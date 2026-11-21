const B=require('../../lib/billing');
module.exports=async(req,res)=>{
 res.setHeader('Cache-Control','no-store');res.setHeader('Vary','Authorization');
 if(!['GET','POST'].includes(req.method))return res.status(405).json({error:'method_not_allowed'});
 try{
  const c=B.config(),uid=await B.user(c,req);if(!uid)return res.status(401).json({error:'authentication_required'});
  const rows=await B.subscriptions(c,uid),s=rows.find(x=>B.entitlement(x))||rows[0];
  if(req.method==='GET'){
   let used=0;
   if(s?.period_start){const usage=await B.db(c,'pinmap_analysis_usage?select=id&user_id=eq.'+uid+'&subscription_id=eq.'+s.subscription_id+'&period_start=eq.'+encodeURIComponent(s.period_start)+'&state=eq.completed&limit=301');used=usage.length;}
   return res.status(200).json({environment:c.environment,active:B.entitlement(s),status:s?.status||'free',periodEnd:s?.period_end||null,cancelAt:s?.cancel_at||null,monthlyLimit:300,used,remaining:Math.max(0,300-used)});
  }
  const body=typeof req.body==='string'?JSON.parse(req.body):req.body;
  if(body?.action==='portal'){
   if(!s)return res.status(404).json({error:'subscription_not_found'});
   const portal=await B.paddle(c,'/customers/'+s.customer_id+'/portal-sessions',{subscription_ids:[s.subscription_id]});
   return res.status(200).json({url:portal.urls.general.overview});
  }
  if(body?.action!=='checkout')return res.status(400).json({error:'invalid_request'});
  if(rows.some(x=>['active','trialing','past_due','paused'].includes(x.status)))return res.status(409).json({error:'subscription_exists'});
  const price=await B.paddle(c,'/prices/'+c.price);
  if(price.status!=='active'||price.unit_price?.currency_code!=='KRW'||price.unit_price?.amount!=='5000'||price.billing_cycle?.interval!=='month'||price.billing_cycle?.frequency!==1||price.trial_period||price.tax_mode!=='internal')throw Error('plan_configuration_mismatch');
  const intent=await B.db(c,'rpc/pinmap_begin_checkout',{p_user_id:uid,p_environment:c.environment});
  if(intent.error)return res.status(409).json({error:intent.error});
  if(intent.existing){
   if(!intent.transaction_id)return res.status(409).json({error:'checkout_pending'});
   const previous=await B.paddle(c,'/transactions/'+intent.transaction_id);
   if(!['draft','ready'].includes(previous.status))return res.status(409).json({error:'payment_verification_pending'});
   return res.status(200).json({transactionId:previous.id,environment:c.environment});
  }
  const txn=await B.paddle(c,'/transactions',{items:[{price_id:c.price,quantity:1}],collection_mode:'automatic',custom_data:{pinmap_checkout:intent.id}});
  await B.db(c,'pinmap_billing_checkouts?id=eq.'+intent.id,{transaction_id:txn.id},'PATCH');
  return res.status(200).json({transactionId:txn.id,environment:c.environment});
 }catch(e){return res.status(503).json({error:['billing_not_configured','plan_configuration_mismatch'].includes(e.message)?e.message:'billing_unavailable'});}
};

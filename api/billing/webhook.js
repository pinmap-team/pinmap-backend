const B=require('../../lib/billing');
module.exports=async(req,res)=>{
 res.setHeader('Cache-Control','no-store');
 if(req.method!=='POST')return res.status(405).json({error:'method_not_allowed'});
 let raw;
 try{const chunks=[];let size=0;for await(const chunk of req){size+=Buffer.byteLength(chunk);if(size>1048576)return res.status(413).end();chunks.push(Buffer.from(chunk));}raw=Buffer.concat(chunks);}catch{return res.status(400).end();}
 // The existing destination without a query belongs to sandbox. Live uses an explicit destination.
 const environment=req.query?.environment||'sandbox';
 if(!['sandbox','live'].includes(environment))return res.status(400).json({error:'invalid_environment'});
 const env={...process.env,PADDLE_ENVIRONMENT:environment};
 if(!B.signature(raw,req.headers['paddle-signature'],B.setting('WEBHOOK_SECRET',env)))return res.status(401).json({error:'invalid_signature'});
 try{
  const event=JSON.parse(raw),c=B.config(env);
  if(!B.id(event.event_id,'evt'))return res.status(400).end();
  const type=event.event_type;
  if(!['transaction.completed','subscription.created','subscription.updated','subscription.activated','subscription.canceled','subscription.paused','subscription.resumed','subscription.past_due','adjustment.created','adjustment.updated'].includes(type))return res.status(200).json({ignored:true});
  let txn,s,revokedUntil=null;
  if(type.startsWith('adjustment.')){
   if(!B.id(event.data?.id,'adj'))return res.status(400).end();
   const adjustment=await B.paddle(c,'/adjustments/'+event.data.id);
   if(adjustment.status!=='approved'||!['refund','chargeback'].includes(adjustment.action)||!B.id(adjustment.transaction_id,'txn'))return res.status(200).json({ignored:true});
   const original=await B.paddle(c,'/transactions/'+adjustment.transaction_id);
   if(!B.id(original.subscription_id,'sub'))return res.status(200).json({ignored:true});
   if(!/^\d+$/.test(String(adjustment.totals?.total))||!/^\d+$/.test(String(original.details?.totals?.total)))throw Error('invalid_adjustment_total');
   if(adjustment.action==='refund'&&BigInt(adjustment.totals.total)<BigInt(original.details.totals.total))return res.status(200).json({ignored:true});
   revokedUntil=B.iso(original.billing_period?.ends_at);
   if(!revokedUntil)throw Error('invalid_refund_period');
   s=await B.paddle(c,'/subscriptions/'+original.subscription_id);
  }else if(type==='transaction.completed'){
   if(!B.id(event.data?.id,'txn'))return res.status(400).end();
   txn=await B.paddle(c,'/transactions/'+event.data.id);
   if(txn.status!=='completed'||!B.id(txn.subscription_id,'sub'))return res.status(200).json({ignored:true});
   s=await B.paddle(c,'/subscriptions/'+txn.subscription_id);
  }else{
   if(!B.id(event.data?.id,'sub'))return res.status(400).end();
   s=await B.paddle(c,'/subscriptions/'+event.data.id);
  }
  const prior=await B.db(c,'pinmap_subscriptions?subscription_id=eq.'+s.id+'&limit=1');
  let uid=prior[0]?.user_id;
  if(!uid){
   const nonce=txn?.custom_data?.pinmap_checkout||s.custom_data?.pinmap_checkout;
   if(!/^[a-f0-9-]{36}$/.test(nonce||''))return res.status(200).json({ignored:true});
   const [intent]=await B.db(c,'pinmap_billing_checkouts?id=eq.'+nonce+'&environment=eq.'+c.environment+'&limit=1');
   if(!intent?.transaction_id)throw Error('checkout_binding_pending');
   const original=await B.paddle(c,'/transactions/'+intent.transaction_id);
   if(original.custom_data?.pinmap_checkout!==nonce||original.subscription_id!==s.id||original.customer_id!==s.customer_id)return res.status(200).json({ignored:true});
   uid=intent.user_id;
  }
  // Only a completed payment for this exact monthly product grants a paid period.
  const paid=txn&&txn.customer_id===s.customer_id&&txn.items?.length===1&&txn.items[0].price?.id===c.price&&txn.items[0].quantity===1&&txn.currency_code==='KRW'&&txn.details?.totals?.total==='5000'&&B.validPlan(c,s);
  const snapshot={subscription_id:s.id,user_id:uid,customer_id:s.customer_id,environment:c.environment,status:B.validPlan(c,s)?s.status:'unsupported_plan',price_id:c.price,
   period_start:B.iso(s.current_billing_period?.starts_at),period_end:B.iso(s.current_billing_period?.ends_at),
   paid_until:paid?B.iso(txn.billing_period?.ends_at):null,revoked_until:revokedUntil,cancel_at:s.scheduled_change?.action==='cancel'?B.iso(s.scheduled_change.effective_at):null,provider_updated_at:B.iso(s.updated_at)};
  if(!snapshot.provider_updated_at)throw Error('invalid_snapshot');
  await B.db(c,'rpc/pinmap_apply_billing_event',{p_event_id:event.event_id,p_subscription:snapshot});
  return res.status(200).json({received:true});
 }catch{return res.status(503).json({error:'webhook_retry_required'});}
};
module.exports.config={api:{bodyParser:false}};

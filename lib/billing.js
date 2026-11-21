const crypto=require('node:crypto');
const {supabaseConfig,bearerToken,authenticatedUser}=require('../api/content-extract');
const {getKey}=require('../config/keys.cjs');
const id=(v,p)=>new RegExp('^'+p+'_[a-z0-9]{26}$').test(v||'');
function setting(name,env=process.env){return env['PADDLE_'+String(env.PADDLE_ENVIRONMENT||'').toUpperCase()+'_'+name]??env['PADDLE_'+name];}
function config(env=process.env){
 const auth=supabaseConfig(env),secret=getKey('SUPABASE_SECRET_KEY',env);
 const price=setting('MONTHLY_PRICE_ID',env),key=setting('API_KEY',env);
 if(env.PADDLE_BILLING_ENABLED!=='1'||!auth||!secret||!id(price,'pri')||!['sandbox','live'].includes(env.PADDLE_ENVIRONMENT)||!String(key||'').startsWith('pdl_'+(env.PADDLE_ENVIRONMENT==='sandbox'?'sdbx':'live')+'_apikey_'))throw Error('billing_not_configured');
 return {auth,secret,origin:auth.origin,price,environment:env.PADDLE_ENVIRONMENT,key};
}
function publicConfig(env=process.env){
 const c=config(env),token=setting('CLIENT_TOKEN',env)||'';
 if(!new RegExp('^'+(c.environment==='sandbox'?'test':'live')+'_[A-Za-z0-9_]+$').test(token))throw Error('billing_not_configured');
 return {environment:c.environment,clientToken:token,monthlyPriceId:c.price};
}
async function db(c,path,body,method=body===undefined?'GET':'POST'){
 const r=await fetch(new URL('/rest/v1/'+path,c.origin),{method,headers:{apikey:c.secret,Authorization:'Bearer '+c.secret,'Content-Type':'application/json',Prefer:'return=representation'},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(8000)});
 if(!r.ok)throw Error('billing_storage_unavailable');return r.status===204?null:r.json();
}
async function paddle(c,path,body){
 const r=await fetch('https://'+(c.environment==='sandbox'?'sandbox-api':'api')+'.paddle.com'+path,{method:body===undefined?'GET':'POST',headers:{Authorization:'Bearer '+c.key,'Content-Type':'application/json','Paddle-Version':'1'},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(12000)});
 if(!r.ok)throw Error('paddle_unavailable');return (await r.json()).data;
}
async function user(c,req){const t=bearerToken(req.headers?.authorization);if(!t)return null;const a=await authenticatedUser(c.auth,t);if(a.status===503)throw Error('auth_unavailable');return a.status===200?a.userId:null;}
const iso=v=>typeof v==='string'&&Number.isFinite(Date.parse(v))?new Date(v).toISOString():null;
function signature(raw,header,secret,now=Date.now()){
 if(!secret||typeof header!=='string')return false;
 const pairs=header.split(';').map(x=>x.trim().split('=')),ts=pairs.filter(x=>x[0]==='ts');
 if(ts.length!==1||!/^\d+$/.test(ts[0][1])||Math.abs(now/1000-Number(ts[0][1]))>5)return false;
 const expected=crypto.createHmac('sha256',secret).update(ts[0][1]+':').update(raw).digest();
 return pairs.some(([k,v])=>k==='h1'&&/^[a-f0-9]{64}$/i.test(v)&&crypto.timingSafeEqual(expected,Buffer.from(v,'hex')));
}
function validPlan(c,s){return s.items?.length===1&&s.items[0].price?.id===c.price&&s.items[0].quantity===1;}
function entitlement(s,now=Date.now()){return !!s&&s.status==='active'&&Date.parse(s.period_start)<=now&&Date.parse(s.period_end)>now&&Date.parse(s.paid_until)>=Date.parse(s.period_end)&&(!s.revoked_until||Date.parse(s.paid_until)>Date.parse(s.revoked_until));}
async function subscriptions(c,uid){return db(c,'pinmap_subscriptions?user_id=eq.'+uid+'&environment=eq.'+c.environment+'&order=period_end.desc.nullslast');}
async function reserve(uid){if(process.env.PADDLE_BILLING_ENABLED!=='1')return null;const c=config(),r=await db(c,'rpc/pinmap_reserve_analysis',{p_user_id:uid,p_environment:c.environment});if(!r.allowed){const e=Error(r.error);e.status=402;throw e;}return r.reservation_id?{c,id:r.reservation_id}:null;}
async function finish(r,success){if(r)await db(r.c,'rpc/pinmap_finish_analysis',{p_id:r.id,p_success:success});}
module.exports={config,publicConfig,setting,db,paddle,user,id,iso,signature,validPlan,entitlement,subscriptions,reserve,finish};

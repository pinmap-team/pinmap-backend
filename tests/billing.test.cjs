const {test}=require('node:test');const assert=require('node:assert/strict');const crypto=require('node:crypto');const fs=require('node:fs');const vm=require('node:vm');
const B=require('../lib/billing');
test('webhook signature rejects edits, old timestamps, missing raw bytes and supports rotated signatures',()=>{
 const raw=Buffer.from('{"event":"payment"}'),now=Date.now(),ts=Math.floor(now/1000),secret='sandbox-webhook-secret';
 const sign=crypto.createHmac('sha256',secret).update(ts+':').update(raw).digest('hex');
 assert(B.signature(raw,`ts=${ts};h1=${sign}`,secret,now));
 assert(B.signature(raw,`ts=${ts};h1=${'0'.repeat(64)};h1=${sign}`,secret,now));
 assert(!B.signature(Buffer.from('{}'),`ts=${ts};h1=${sign}`,secret,now));
 assert(!B.signature(raw,`ts=${ts};h1=${sign}`,secret,now+6000));
 assert(!B.signature(raw,`ts=${ts};ts=${ts};h1=${sign}`,secret,now));
});
test('paid access requires active subscription, matching paid period, and future expiry',()=>{
 const now=Date.parse('2026-11-21T12:00:00Z'),s={status:'active',period_start:'2026-11-21T00:00:00Z',period_end:'2026-12-21T00:00:00Z',paid_until:'2026-12-21T00:00:00Z'};
 assert(B.entitlement(s,now));
 for(const change of [{status:'canceled'},{status:'past_due'},{status:'paused'},{paid_until:null},{paid_until:'2026-12-20'},{period_end:'2026-11-20'},{period_start:'2026-11-22'}])assert(!B.entitlement({...s,...change},now));
});
function load(path,mocks){const exports={};const c={module:{exports},exports,require:name=>mocks[name],Buffer,process:{env:{PADDLE_WEBHOOK_SECRET:'secret'}}};vm.runInNewContext(fs.readFileSync(path,'utf8'),c);return c.module.exports;}
function response(){return {code:null,body:null,setHeader(){},status(code){this.code=code;return this;},json(body){this.body=body;return this;},end(){return this;}};}
const uid='12345678-1234-1234-1234-123456789012',nonce='12345678-1234-1234-1234-123456789099',sub='sub_'+'s'.repeat(26),txn='txn_'+'t'.repeat(26),price='pri_'+'p'.repeat(26),customer='ctm_'+'c'.repeat(26);
test('checkout binds authenticated identity on the server and rejects incorrect prices and unauthenticated requests',async()=>{
 const writes=[];let auth=uid,amount='5000';
 const mock={config:()=>({price,environment:'sandbox'}),user:async()=>auth,subscriptions:async()=>[],entitlement:()=>false,
 db:async(path,route,body)=>{writes.push({route,body});return {id:nonce};},paddle:async(c,path,body)=>path.startsWith('/prices')?{status:'active',unit_price:{currency_code:'KRW',amount},billing_cycle:{interval:'month',frequency:1},tax_mode:'internal'}:{id:txn}};
 const handler=load('api/billing/account.js',{'../../lib/billing':mock});let res=response();await handler({method:'POST',body:{action:'checkout',user_id:'attacker'}},res);
 assert.equal(res.code,200);assert.equal(writes[0].body.p_user_id,uid);assert.equal(res.body.transactionId,txn);
 auth=null;res=response();await handler({method:'POST',body:{action:'checkout'}},res);assert.equal(res.code,401);
 auth=uid;amount='1';res=response();await handler({method:'POST',body:{action:'checkout'}},res);assert.equal(res.code,503);
});
test('webhook only grants after provider payment verification and matching server checkout binding',async()=>{
 let applied,wrong=false,verified=true;
 const snapshot={id:sub,customer_id:customer,items:[{price:{id:price},quantity:1}],status:'active',updated_at:'2026-11-21T12:00:00Z',current_billing_period:{starts_at:'2026-11-21',ends_at:'2026-12-21'}};
 const payment={id:txn,status:'completed',subscription_id:sub,customer_id:customer,custom_data:{pinmap_checkout:nonce},items:[{price:{id:price},quantity:1}],currency_code:'KRW',details:{totals:{total:'5000'}},billing_period:{ends_at:'2026-12-21'}};
 const mock={...B,config:()=>({price,environment:'sandbox'}),signature:()=>verified,
 paddle:async(c,path)=>path.startsWith('/subscriptions')?snapshot:{...payment,subscription_id:wrong?'sub_wrong':sub},
 db:async(c,path,body)=>{if(path.startsWith('pinmap_subscriptions'))return [];if(path.startsWith('pinmap_billing_checkouts'))return [{id:nonce,transaction_id:txn,user_id:uid}];applied=body;return true;}};
 const handler=load('api/billing/webhook.js',{'../../lib/billing':mock});
 async function send(){const raw=JSON.stringify({event_id:'evt_'+'e'.repeat(26),event_type:'transaction.completed',data:{id:txn}});const req={method:'POST',headers:{'paddle-signature':'test'},async *[Symbol.asyncIterator](){yield Buffer.from(raw);}};const res=response();await handler(req,res);return res;}
 assert.equal((await send()).code,200);assert.equal(applied.p_subscription.user_id,uid);assert.equal(applied.p_subscription.paid_until,'2026-12-21T00:00:00.000Z');
 applied=null;wrong=true;await send();assert.equal(applied,null);
 verified=false;assert.equal((await send()).code,401);
});
test('approved full refund revokes the paid period while partial refund does not',async()=>{
 let applied,total='5000';
 const s={id:sub,customer_id:customer,items:[{price:{id:price},quantity:1}],status:'active',updated_at:'2026-11-21T12:00:00Z',current_billing_period:{starts_at:'2026-11-21',ends_at:'2026-12-21'}};
 const mock={...B,config:()=>({price,environment:'sandbox'}),signature:()=>true,
 paddle:async(c,path)=>path.startsWith('/adjustments')?{status:'approved',action:'refund',transaction_id:txn,totals:{total}}:path.startsWith('/transactions')?{subscription_id:sub,details:{totals:{total:'5000'}},billing_period:{ends_at:'2026-12-21'}}:s,
 db:async(c,path,body)=>{if(path.startsWith('pinmap_subscriptions'))return [{user_id:uid}];applied=body;return true;}};
 const handler=load('api/billing/webhook.js',{'../../lib/billing':mock});
 async function send(){const req={method:'POST',headers:{},async *[Symbol.asyncIterator](){yield Buffer.from(JSON.stringify({event_id:'evt_'+'e'.repeat(26),event_type:'adjustment.created',data:{id:'adj_'+'a'.repeat(26)}}));}};const res=response();await handler(req,res);return res;}
 assert.equal((await send()).code,200);assert.equal(applied.p_subscription.revoked_until,'2026-12-21T00:00:00.000Z');
 total='100';applied=null;assert.equal((await send()).code,200);assert.equal(applied,null);
});

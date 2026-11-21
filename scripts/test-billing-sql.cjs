const {PGlite}=require(process.env.PINMAP_PGLITE_MODULE || '@electric-sql/pglite');const fs=require('fs');const assert=require('assert/strict');
(async()=>{const db=new PGlite();await db.exec(`create role anon;create role authenticated;create role service_role;create schema auth;create table auth.users(id uuid primary key);create schema pinmap_private;create table public.pinmap_saved_content(user_id uuid,source_url text);`);
await db.exec(fs.readFileSync('database/005_billing.sql','utf8'));
const user='12345678-1234-1234-1234-123456789012';await db.query('insert into auth.users values ($1)',[user]);
const s={subscription_id:'sub_test',user_id:user,customer_id:'ctm_test',environment:'sandbox',status:'active',price_id:'pri_test',period_start:new Date(Date.now()-86400000).toISOString(),period_end:new Date(Date.now()+86400000*29).toISOString(),paid_until:new Date(Date.now()+86400000*29).toISOString(),provider_updated_at:new Date().toISOString()};
async function apply(id,snapshot){return (await db.query('select public.pinmap_apply_billing_event($1,$2::jsonb) result',[id,JSON.stringify(snapshot)])).rows[0].result;}
const checkout=(await db.query('select pinmap_begin_checkout($1,$2) result',[user,'sandbox'])).rows[0].result;
const repeated=(await db.query('select pinmap_begin_checkout($1,$2) result',[user,'sandbox'])).rows[0].result;
assert.equal(checkout.id,repeated.id);assert(repeated.existing);
assert(await apply('first',s));assert.equal(await apply('first',s),false);
await apply('old',{...s,status:'canceled',provider_updated_at:'2020-01-01'});assert.equal((await db.query('select status from pinmap_subscriptions')).rows[0].status,'active');
const reservations=await Promise.all(Array.from({length:301},()=>db.query('select public.pinmap_reserve_analysis($1,$2) result',[user,'sandbox'])));
assert.equal(reservations.filter(x=>x.rows[0].result.allowed).length,300);assert.equal(reservations[300].rows[0].result.error,'monthly_analysis_limit');
const r=reservations[0].rows[0].result.reservation_id;await db.query('select public.pinmap_finish_analysis($1,false)',[r]);const freed=(await db.query('select public.pinmap_reserve_analysis($1,$2) result',[user,'sandbox'])).rows[0].result;assert(freed.allowed);
await db.query('select public.pinmap_finish_analysis($1,true)',[freed.reservation_id]);assert.equal((await db.query("select count(*)::int n from pinmap_analysis_usage where state='completed'")).rows[0].n,1);
const end=new Date(Date.now()+86400000*60).toISOString();await apply('renew',{...s,period_start:s.period_end,period_end:end,paid_until:end,provider_updated_at:new Date(Date.now()+1000).toISOString()});
// Future billing period cannot grant early access.
assert.equal((await db.query('select public.pinmap_reserve_analysis($1,$2) result',[user,'sandbox'])).rows[0].result.error,'subscription_inactive');
await apply('renew-now',{...s,period_start:new Date(Date.now()-1000).toISOString(),period_end:end,paid_until:end,provider_updated_at:new Date(Date.now()+2000).toISOString()});assert((await db.query('select public.pinmap_reserve_analysis($1,$2) result',[user,'sandbox'])).rows[0].result.allowed);
await apply('refund',{...s,provider_updated_at:new Date(Date.now()+3000).toISOString(),revoked_until:end});
assert.equal((await db.query('select public.pinmap_reserve_analysis($1,$2) result',[user,'sandbox'])).rows[0].result.error,'subscription_inactive');
await db.exec('set role authenticated');await assert.rejects(()=>db.query('select * from pinmap_subscriptions'));await assert.rejects(()=>db.query('select pinmap_reserve_analysis($1,$2)',[user,'sandbox']));
console.log('SQL PASS: migration, 301 overlapping reservations, failure release, completion, renewal, replay/order, access controls');await db.close();})().catch(e=>{console.error(e);process.exit(1)});

const {test}=require('node:test'),assert=require('node:assert/strict');
const handler=require('../api/content-photo'),backfill=require('../api/photo-backfill');
const store=require('../lib/saved-photo-store');
const user='11111111-1111-4111-8111-111111111111',id='22222222-2222-4222-8222-222222222222';
const response=()=>({headers:{},setHeader(k,v){this.headers[k]=v;},status(v){this.code=v;return this;},json(v){this.body=v;return this;}});
test('maintenance route rejects browser tokens and malformed cursors',async()=>{
 assert.equal(backfill.authorized('Bearer short','short'),false);assert.equal(backfill.authorized('Bearer '+ 's'.repeat(25),'s'.repeat(25)),true);
 const r=response();await backfill({method:'POST',headers:{}},r);assert.equal(r.code,401);
});
test('photo route requires owned saved IDs, never arbitrary names or remote URLs',async()=>{
 const r=response();await handler({method:'POST',headers:{},body:{name:'cafe',url:'http://localhost/'}},r);assert.equal(r.code,400);
});
test('authenticated photo route uses the stored place and does not expose server credentials',async()=>{
 const oldEnv={...process.env},oldFetch=global.fetch;let seen=[];
 Object.assign(process.env,{SUPABASE_URL:'https://test.supabase.co',SUPABASE_PUBLISHABLE_KEY:'sb_publishable_test',SUPABASE_SECRET_KEY:'sb_secret_abcdefghijk',GOOGLE_MAPS_SERVER_KEY:'hidden-provider-secret'});
 global.fetch=async(url,opts={})=>{
  const u=String(url);seen.push({u,opts});
  if(u.includes('/auth/v1/user'))return Response.json({id:user,is_anonymous:false});
  if(u.includes('/rest/v1/'))return Response.json([{id,user_id:user,updated_at:'2026-01-01',map_locations:[{name:'cafe',coordinates:{lat:37.5,lng:127},image_data_url:'data:image/jpeg;base64,YQ=='}]}]);
  throw Error('unexpected provider request');
 };
 try{const r=response();await handler({method:'POST',headers:{authorization:'Bearer '+'t'.repeat(40)},body:{content_id:id,location_index:0}},r);assert.equal(r.code,200);assert.equal(r.body.source,'post');assert.ok(seen[1].u.includes('user_id=eq.'+user));assert.ok(!JSON.stringify(r.body).includes('hidden-provider-secret'));}
 finally{global.fetch=oldFetch;process.env=oldEnv;}
});
test('photo route uses the saved post cover before requesting a provider photo',async()=>{
 const oldEnv={...process.env},oldFetch=global.fetch;
 Object.assign(process.env,{SUPABASE_URL:'https://test.supabase.co',SUPABASE_PUBLISHABLE_KEY:'sb_publishable_test',SUPABASE_SECRET_KEY:'sb_secret_abcdefghijk'});
 delete process.env.GOOGLE_MAPS_SERVER_KEY;
 global.fetch=async url=>{
  const u=String(url);
  if(u.includes('/auth/v1/user'))return Response.json({id:user,is_anonymous:false});
  if(u.includes('/rest/v1/')){
   assert.match(u,/cover_data_url/);
   return Response.json([{id,user_id:user,updated_at:'2026-01-01',cover_data_url:'data:image/jpeg;base64,Yg==',map_locations:[{name:'cafe',coordinates:{lat:37.5,lng:127},image_data_url:null}]}]);
  }
  throw Error('unexpected provider request');
 };
 try{const r=response();await handler({method:'POST',headers:{authorization:'Bearer '+'t'.repeat(40)},body:{content_id:id,location_index:0}},r);assert.equal(r.code,200);assert.deepEqual(r.body,{source:'post',url:'data:image/jpeg;base64,Yg==',attributions:[]});}
 finally{global.fetch=oldFetch;process.env=oldEnv;}
});
test('another account cannot retrieve a photo even if storage responds with an unrelated row',async()=>{
 const oldEnv={...process.env},oldFetch=global.fetch;
 Object.assign(process.env,{SUPABASE_URL:'https://test.supabase.co',SUPABASE_PUBLISHABLE_KEY:'sb_publishable_test',SUPABASE_SECRET_KEY:'sb_secret_abcdefghijk',GOOGLE_MAPS_SERVER_KEY:'secret'});
 global.fetch=async u=>String(u).includes('/auth/v1/user')?Response.json({id:user,is_anonymous:false}):Response.json([{id,user_id:id,map_locations:[]}]);
 try{const r=response();await handler({method:'POST',headers:{authorization:'Bearer '+'t'.repeat(40)},body:{content_id:id,location_index:0}},r);assert.equal(r.code,404);}finally{global.fetch=oldFetch;process.env=oldEnv;}
});

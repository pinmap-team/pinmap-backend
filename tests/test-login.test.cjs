const {test} = require('node:test');
const assert = require('node:assert/strict');
const handler = require('../api/auth/test-login');
function response() {return {headers:{},setHeader(k,v){this.headers[k]=v;},status(s){this.code=s;return this;},json(v){this.body=v;return this;}};}
test('test login is disabled by default and rejects supplied credentials', async()=>{
  const old={...process.env};
  try {
    delete process.env.PINMAP_TEST_LOGIN_ENABLED;
    let r=response();await handler({method:'POST'},r);assert.equal(r.code,404);
    process.env.PINMAP_TEST_LOGIN_ENABLED='true';process.env.PINMAP_TEST_LOGIN_PASSWORD='a'.repeat(32);
    r=response();await handler({method:'POST',body:{email:'other@example.com'}},r);assert.equal(r.code,400);
  } finally {process.env=old;}
});
test('existing team account returns only session tokens and never changes users',async()=>{
  const old={...process.env}, original=global.fetch, calls=[];
  Object.assign(process.env,{PINMAP_TEST_LOGIN_ENABLED:'true',PINMAP_TEST_LOGIN_PASSWORD:'a'.repeat(32),SUPABASE_URL:'https://example.supabase.co',SUPABASE_PUBLISHABLE_KEY:'sb_publishable_test',SUPABASE_SECRET_KEY:'sb_secret_test'});
  global.fetch=async(url,options)=>{
    calls.push({url,options});
    return {ok:true,json:async()=>({access_token:'access',refresh_token:'refresh',user:{email:'pinmap2026@gmail.com',app_metadata:{pinmap_test_account:true},is_anonymous:false}})};
  };
  try {
    const r=response();await handler({method:'POST',body:{}},r);
    assert.equal(r.code,200);assert.deepEqual(r.body,{access_token:'access',refresh_token:'refresh'});
    assert.equal(calls.length,1);
    assert.match(calls[0].url,/token\?grant_type=password$/);
    assert.equal(r.headers['Cache-Control'],'private, no-store');
    global.fetch=async()=>({ok:true,json:async()=>({access_token:'x',refresh_token:'y',user:{email:'personal@example.com'}})});
    const rejected=response();await handler({method:'POST'},rejected);assert.equal(rejected.code,503);
  } finally {global.fetch=original;process.env=old;}
});

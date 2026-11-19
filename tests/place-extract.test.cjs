const { test } = require('node:test');
const assert = require('node:assert/strict');
const handler = require('../api/place-extract');

function response() {
  return { code: 200, headers: {}, setHeader(key, value) { this.headers[key] = value; return this; },
    status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } };
}
async function request(method, code, body) {
  const res = response();
  await handler({ method, headers: {'x-pinmap-test-code':code}, body }, res);
  return res;
}
test('accepts only canonical Instagram post and reel paths', () => {
  assert.equal(handler.instagramLink('https://instagram.com/reel/Ab_12-3/?utm_source=x'), 'https://www.instagram.com/reel/Ab_12-3/');
  for (const url of ['http://instagram.com/p/a/', 'https://evil.example/p/a/', 'https://instagram.com/p/a/../../x', 'https://instagram.com.evil.example/p/a/']) {
    assert.throws(() => handler.instagramLink(url));
  }
});
test('rejects invalid requests before contacting the extractor', async () => {
  const names = ['PINMAP_EXTRACTOR_ORIGIN','PINMAP_EXTRACTOR_TOKEN','PINMAP_TEST_ACCESS_CODE',
    'SUPABASE_URL','SUPABASE_SECRET_KEY'];
  const saved = Object.fromEntries(names.map(name => [name, process.env[name]]));
  const previousFetch = global.fetch;
  let calls = 0;
  try {
    process.env.PINMAP_EXTRACTOR_ORIGIN = 'https://backend.example';
    process.env.PINMAP_EXTRACTOR_TOKEN = 'backend-secret';
    process.env.PINMAP_TEST_ACCESS_CODE = 'access-secret';
    process.env.SUPABASE_URL = 'https://project.supabase.co';
    process.env.SUPABASE_SECRET_KEY = 'sb_secret_test_private';
    global.fetch = async () => { calls++; throw Error('Unexpected network'); };
    assert.equal((await request('GET', 'access-secret', {})).code, 405);
    assert.equal((await request('POST', 'wrong', {url:'https://instagram.com/p/abc/'})).code, 401);
    assert.equal((await request('POST', 'access-secret', {url:'https://elsewhere.example/p/abc/'})).code, 400);
    assert.equal(calls, 0);
  } finally {
    global.fetch = previousFetch;
    for (const name of names) saved[name] === undefined ? delete process.env[name] : process.env[name] = saved[name];
  }
});

test('developer endpoint remains place-only by default and accepts explicit event analysis', async () => {
  const names = ['PINMAP_EXTRACTOR_ORIGIN','PINMAP_EXTRACTOR_TOKEN','PINMAP_TEST_ACCESS_CODE',
    'SUPABASE_URL','SUPABASE_SECRET_KEY'];
  const saved = Object.fromEntries(names.map(name => [name, process.env[name]]));
  const previousFetch = global.fetch, payloads = [];
  try {
    process.env.PINMAP_EXTRACTOR_ORIGIN = 'https://backend.example';
    process.env.PINMAP_EXTRACTOR_TOKEN = 'backend-secret';
    process.env.PINMAP_TEST_ACCESS_CODE = 'access-secret';
    process.env.SUPABASE_URL = 'https://project.supabase.co';
    process.env.SUPABASE_SECRET_KEY = 'sb_secret_test_private';
    global.fetch = async (url, options) => {
      assert.equal(String(url), 'https://backend.example/extract-link');
      payloads.push(JSON.parse(options.body));
      return new Response(JSON.stringify({schema_version: 1, results: [{places: [], events: []}]}), {status: 200});
    };
    let res = await request('POST', 'access-secret', {url: 'https://instagram.com/p/abc/'});
    assert.equal(res.code, 200);
    assert.deepEqual(payloads[0].content_types, ['place']);
    res = await request('POST', 'access-secret', {url: 'https://instagram.com/p/abc/', content_types: ['place', 'event']});
    assert.equal(res.code, 200);
    assert.deepEqual(payloads[1].content_types, ['place', 'event']);
    res = await request('POST', 'access-secret', {url: 'https://instagram.com/p/abc/', content_types: ['other']});
    assert.equal(res.code, 400);
    assert.equal(payloads.length, 2);
  } finally {
    global.fetch = previousFetch;
    for (const name of names) saved[name] === undefined ? delete process.env[name] : process.env[name] = saved[name];
  }
});

test('developer analyses exceed twenty calls without a quota database',async()=>{
  const names=['PINMAP_EXTRACTOR_ORIGIN','PINMAP_EXTRACTOR_TOKEN','PINMAP_TEST_ACCESS_CODE','SUPABASE_URL','SUPABASE_SECRET_KEY'];
  const saved=Object.fromEntries(names.map(n=>[n,process.env[n]])),previousFetch=global.fetch;let calls=0;
  try{
    process.env.PINMAP_EXTRACTOR_ORIGIN='https://backend.example';process.env.PINMAP_EXTRACTOR_TOKEN='backend-secret';process.env.PINMAP_TEST_ACCESS_CODE='access-secret';
    delete process.env.SUPABASE_URL;delete process.env.SUPABASE_SECRET_KEY;
    global.fetch=async url=>{assert(String(url).endsWith('/extract-link'));calls++;return new Response(JSON.stringify({results:[]}),{status:200})};
    for(let i=0;i<24;i++){const res=await request('POST','access-secret',{url:'https://instagram.com/p/abc/'});assert.equal(res.code,200)}
    assert.equal(calls,24);
  }finally{global.fetch=previousFetch;for(const n of names)saved[n]===undefined?delete process.env[n]:process.env[n]=saved[n]}
});

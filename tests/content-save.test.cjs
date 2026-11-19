const { test } = require('node:test');
const assert = require('node:assert/strict');
const handler = require('../api/content-save');

const names = ['SUPABASE_URL', 'SUPABASE_PUBLISHABLE_KEY', 'SUPABASE_SECRET_KEY',
  'PINMAP_EXTRACTOR_ORIGIN', 'PINMAP_EXTRACTOR_TOKEN'];
const token = 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJ0ZXN0In0.signature';
const userId = '123e4567-e89b-42d3-a456-426614174000';
const post = 'https://www.instagram.com/p/Example123/';
const user = { id: userId, is_anonymous: false };

function configure() {
  const previous = Object.fromEntries(names.map(name => [name, process.env[name]]));
  process.env.SUPABASE_URL = 'https://project.supabase.co';
  process.env.SUPABASE_PUBLISHABLE_KEY = 'sb_publishable_test';
  process.env.SUPABASE_SECRET_KEY = 'sb_secret_test_private';
  process.env.PINMAP_EXTRACTOR_ORIGIN = 'https://extractor.example.test';
  process.env.PINMAP_EXTRACTOR_TOKEN = 'private-extractor-token';
  return () => {for (const name of names) previous[name] === undefined
    ? delete process.env[name] : process.env[name] = previous[name];};
}

function reply(body, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: {'Content-Type':'application/json'} });
}

function res() {
  return { code: 200, headers: {}, setHeader(name, value) { this.headers[name] = value; return this; },
    status(code) { this.code = code; return this; }, json(body) { this.body = body; return this; } };
}

function req(method = 'POST', body = {url: post}, headers = {}) {
  return { method, body, headers: {authorization: `Bearer ${token}`, ...headers} };
}

const report = {
  source_url: post, status: 'needs_review', ai_title: '서울 카페와 팝업',
  ai_summary: '한강 인근 카페와 전시 일정을 소개합니다.', author_username: 'creator.name',
  author_profile_data_url: 'data:image/jpeg;base64,AAAA', cover_data_url: 'data:image/jpeg;base64,AAAA',
  observed_text: '원본 OCR 텍스트는 저장되면 안 됩니다.', caption: '원본 캡션도 저장되면 안 됩니다.',
  notes: ['장소 주소 확인 필요', '행사 종료일 확인 필요'],
  places: [{name:'한강 카페',address:'서울특별시 마포구',needs_review:true,
    map_lookup:{status:'ambiguous', candidates:[{name:'다른 곳'}]},
    evidence:{kind:'image',file:'link-slide-02.jpg',quote:'한강 카페 합정점',time_seconds:3},
    screen_text:'전체 화면 글자'}],
  events: [{title:'가을 팝업',event_type:'pop_up',start_date:'2026-11-16',end_date:'2026-11-20',
    date_text:'2026.11.16~20',time_text:'오전 11시',venue_name:'한강 공간',address:'서울특별시 마포구',
    source:'media_ocr',evidence:{kind:'image',file:'link-slide-03.jpg',quote:'가을 팝업',time_seconds:4},
    needs_review:true,notes:['운영 시간 확인 필요'],raw_ocr:'no'}],
  map_locations:[{name:'한강 카페',address:'서울특별시 마포구',coordinates:{lat:37.55,lng:126.92},
    needs_review:true,image_data_url:'data:image/jpeg;base64,AAAA',
    evidence:{quote:'raw long OCR'}}]
};

test('POST authenticates, analyzes on the server and upserts a bounded mixed record', async () => {
  const restore = configure(), oldFetch = global.fetch, calls = [];
  try {
    global.fetch = async (url, options = {}) => {
      const target = String(url); calls.push({target,options});
      if (target.endsWith('/auth/v1/user')) return reply(user);
      if (target.includes('/pinmap_saved_content') && target.includes('limit=0')) return reply([]);

      if (target.endsWith('/extract-link')) return reply({schema_version:1,results:[report]});
      if (target.includes('/pinmap_saved_content') && options.method === 'POST') {
        const row = JSON.parse(options.body);
        assert.equal(row.user_id, userId);
        assert.equal(row.content_kind, 'mixed');
        assert.equal(row.author_username, 'creator.name');
        assert.equal(row.cover_data_url, report.cover_data_url);
        assert.equal(row.map_locations[0].image_data_url, report.map_locations[0].image_data_url);
        assert.equal(row.places[0].map_lookup.status, 'ambiguous');
        assert.equal(row.places[0].evidence.file, 'link-slide-02.jpg');
        assert.equal(row.events[0].evidence.quote, '가을 팝업');
        assert.deepEqual(row.extraction_notes, report.notes);
        assert(!JSON.stringify(row).includes('원본 OCR 텍스트'));
        assert(!JSON.stringify(row).includes('원본 캡션'));
        assert(!JSON.stringify(row).includes('screen_text'));
        assert.equal(options.headers.apikey, 'sb_secret_test_private');
        assert.equal(options.headers.Authorization, undefined);
        assert.match(options.headers.Prefer, /resolution=merge-duplicates/);
        assert.equal(new URL(target).searchParams.get('on_conflict'), 'user_id,source_url');
        return reply([{...row,id:'550e8400-e29b-41d4-a716-446655440000'}],201);
      }
      throw Error(`unexpected ${target}`);
    };
    let response;
    for(let i=0;i<8;i++){response=res();await handler(req('POST',{url:post+'?utm_source=test'}),response);assert.equal(response.code,200);}
    assert.equal(response.code,200);
    assert.equal(response.body.item.source_url,post);
    assert.equal(response.body.analysis_status,'needs_review');
    assert.equal(calls.length,32);
    assert.equal(calls[2].target,'https://extractor.example.test/extract-link');
    assert.deepEqual(JSON.parse(calls[2].options.body),{url:post,content_types:['place','event']});
    assert.equal(response.headers['Cache-Control'],'no-store');
  } finally {global.fetch=oldFetch;restore();}
});

test('GET reads only the verified account with a small page size', async () => {
  const restore = configure(), oldFetch = global.fetch, calls=[];
  try {
    global.fetch = async (url,options={}) => {
      calls.push({url:String(url),options});
      if (String(url).endsWith('/auth/v1/user')) return reply(user);
      return reply([{id:'one',user_id:userId,source_url:post}]);
    };
    const response=res();
    await handler({...req('GET'),query:{limit:'2',offset:'4'}},response);
    assert.equal(response.code,200);
    assert.equal(response.body.items.length,1);
    assert.equal(response.body.next_offset,null);
    const search=new URL(calls[1].url).searchParams;
    assert.equal(search.get('user_id'),`eq.${userId}`);
    assert.equal(search.get('limit'),'2');
    assert.equal(search.get('offset'),'4');
    assert.equal(calls[1].options.headers.apikey,'sb_secret_test_private');
    assert.equal(calls[1].options.headers.Authorization,undefined);
    assert.equal(calls.length,2);
  } finally {global.fetch=oldFetch;restore();}
});

test('DELETE removes only the current account record and does not claim extraction quota', async () => {
  const restore=configure(),oldFetch=global.fetch,calls=[];
  try {
    global.fetch=async (url,options={}) => {
      calls.push({url:String(url),options});
      if (String(url).endsWith('/auth/v1/user')) return reply(user);
      assert.equal(options.method,'DELETE');
      const search=new URL(url).searchParams;
      assert.equal(search.get('source_url'),`eq.${post}`);
      assert.equal(search.get('user_id'),`eq.${userId}`);
      return reply([{id:'one',user_id:userId,source_url:post}]);
    };
    const response=res();
    await handler(req('DELETE',{url:post+'?utm_source=x'}),response);
    assert.equal(response.code,200);
    assert.deepEqual(response.body,{deleted:true});
    assert.equal(calls.length,2);
  } finally {global.fetch=oldFetch;restore();}
});

test('collection failure saves an unknown link without raw OCR and never overwrites a previous result', async () => {
  const restore=configure(),oldFetch=global.fetch,calls=[];
  try {
    const existing={id:'one',user_id:userId,source_url:post,content_kind:'place',places:[{name:'old'}]};
    global.fetch=async (url,options={}) => {
      const target=String(url);calls.push({target,options});
      if (target.endsWith('/auth/v1/user')) return reply(user);
      if (target.includes('/pinmap_saved_content') && target.includes('limit=0')) return reply([]);

      if (target.endsWith('/extract-link')) return reply({schema_version:1,results:[{
        source_url:post,status:'collection_failed',places:[],events:[],notes:['비공개 게시물입니다.'],
        observed_text:'do not store'
      }]});
      if (target.includes('/pinmap_saved_content') && options.method==='POST') {
        const row=JSON.parse(options.body);
        assert.equal(row.content_kind,'unknown');
        assert.equal(row.status,'collection_failed');
        assert.deepEqual(row.extraction_notes,['비공개 게시물입니다.']);
        assert(!JSON.stringify(row).includes('do not store'));
        assert.match(options.headers.Prefer,/resolution=ignore-duplicates/);
        return reply([],201);
      }
      if (target.includes('/pinmap_saved_content') && target.includes('limit=1')) return reply([existing]);
      throw Error(`unexpected ${target}`);
    };
    const response=res();
    await handler(req(),response);
    assert.equal(response.code,200);
    assert.deepEqual(response.body.item,existing);
    assert.equal(response.body.analysis_status,'collection_failed');
    assert.deepEqual(response.body.analysis_notes,['비공개 게시물입니다.']);
    assert.equal(calls.length,5);
  } finally {global.fetch=oldFetch;restore();}
});

test('extractor network failure preserves a new link without a quota dependency', async () => {
  const restore=configure(),oldFetch=global.fetch;
  try {
    global.fetch=async (url,options={}) => {
      const target=String(url);
      if (target.endsWith('/auth/v1/user')) return reply(user);
      if (target.includes('/pinmap_saved_content') && target.includes('limit=0')) return reply([]);

      if (target.endsWith('/extract-link')) throw Error('network down');
      const row=JSON.parse(options.body);
      assert.equal(row.status,'extractor_unavailable');
      assert.equal(row.content_kind,'unknown');
      return reply([{...row,id:'new'}],201);
    };
    const response=res();
    await handler(req(),response);
    assert.equal(response.code,200);
    assert.equal(response.body.item.status,'extractor_unavailable');
    assert.match(response.body.analysis_notes[0],/링크만 저장/);
  } finally {global.fetch=oldFetch;restore();}
});

test('zero extracted items still save the Instagram link with a review reason', async () => {
  const restore=configure(),oldFetch=global.fetch;
  try {
    global.fetch=async (url,options={}) => {
      const target=String(url);
      if (target.endsWith('/auth/v1/user')) return reply(user);
      if (target.includes('/pinmap_saved_content') && target.includes('limit=0')) return reply([]);

      if (target.endsWith('/extract-link')) return reply({schema_version:1,results:[{
        source_url:post,status:'needs_media_or_ai',places:[],events:[],
        notes:['이미지의 장소 이름을 확인하지 못했습니다.']
      }]});
      const row=JSON.parse(options.body);
      assert.equal(row.content_kind,'unknown');
      assert.equal(row.status,'needs_media_or_ai');
      return reply([{...row,id:'new'}],201);
    };
    const response=res();await handler(req(),response);
    assert.equal(response.code,200);
    assert.equal(response.body.item.content_kind,'unknown');
    assert.deepEqual(response.body.analysis_notes,['이미지의 장소 이름을 확인하지 못했습니다.']);
  } finally {global.fetch=oldFetch;restore();}
});

test('malformed extractor result is saved as a retriable unknown link, without its payload', async () => {
  const restore=configure(),oldFetch=global.fetch;
  try {
    global.fetch=async (url,options={}) => {
      const target=String(url);
      if (target.endsWith('/auth/v1/user')) return reply(user);
      if (target.includes('/pinmap_saved_content') && target.includes('limit=0')) return reply([]);

      if (target.endsWith('/extract-link')) return reply({schema_version:1,results:[{
        source_url:'https://www.instagram.com/p/SomeoneElse/',status:'extracted',
        places:[{name:'wrong post'}],events:[]
      }]});
      const row=JSON.parse(options.body);
      assert.equal(row.content_kind,'unknown');
      assert.equal(row.status,'extractor_invalid_response');
      assert(!JSON.stringify(row).includes('wrong post'));
      return reply([{...row,id:'new'}],201);
    };
    const response=res();await handler(req(),response);
    assert.equal(response.code,200);
    assert.equal(response.body.analysis_status,'extractor_invalid_response');
  } finally {global.fetch=oldFetch;restore();}
});

test('invalid credentials and missing storage never call the extractor', async () => {
  const restore=configure(),oldFetch=global.fetch;
  try {
    let calls=0;
    global.fetch=async () => {calls++;throw Error('unexpected');};
    let response=res();
    await handler(req('POST',{url:post},{authorization:''}),response);
    assert.equal(response.code,401);assert.equal(calls,0);

    global.fetch=async url => {
      calls++;
      if (String(url).endsWith('/auth/v1/user')) return reply(user);
      return reply({error:'missing table'},404);
    };
    response=res();await handler(req(),response);
    assert.equal(response.code,503);assert.equal(response.body.error,'storage_unavailable');

  } finally {global.fetch=oldFetch;restore();}
});

test('missing server-only storage secret fails before authentication or extraction', async () => {
  const restore=configure(),oldFetch=global.fetch;
  try {
    delete process.env.SUPABASE_SECRET_KEY;
    let calls=0;
    global.fetch=async () => {calls++;throw Error('network must not be used');};
    const response=res();
    await handler(req(),response);
    assert.equal(response.code,503);
    assert.equal(response.body.error,'content_storage_not_configured');
    assert.equal(calls,0);
  } finally {global.fetch=oldFetch;restore();}
});

test('request size, pagination and extra client-supplied analysis fields are rejected', async () => {
  const restore=configure(),oldFetch=global.fetch;
  try {
    let calls=0;global.fetch=async () => {calls++;throw Error('unexpected');};
    let response=res();await handler(req('POST',{url:post,result:report}),response);
    assert.equal(response.code,400);
    response=res();await handler(req('POST',{url:post,extra:'x'.repeat(5000)}),response);
    assert.equal(response.code,413);
    response=res();await handler({...req('GET'),query:{limit:'100'}},response);
    assert.equal(response.code,400);
    response=res();await handler(req('DELETE',{url:post,content_types:['place']}),response);
    assert.equal(response.code,400);
    assert.equal(calls,0);
  } finally {global.fetch=oldFetch;restore();}
});

test('storage response cannot return another user record', async () => {
  const restore=configure(),oldFetch=global.fetch;
  try {
    global.fetch=async url => String(url).endsWith('/auth/v1/user') ? reply(user) :
      reply([{id:'other',user_id:'aaaaaaaa-aaaa-4aaa-aaaa-aaaaaaaaaaaa',source_url:post}]);
    const response=res();await handler(req('GET'),response);
    assert.equal(response.code,503);
    assert.equal(response.body.error,'storage_unavailable');
  } finally {global.fetch=oldFetch;restore();}
});

test('database per-user save limit is a user-facing conflict, without leaking SQL details', async () => {
  const restore=configure(),oldFetch=global.fetch;
  try {
    global.fetch=async (url,options={}) => {
      const target=String(url);
      if (target.endsWith('/auth/v1/user')) return reply(user);
      if (target.includes('/pinmap_saved_content') && target.includes('limit=0')) return reply([]);

      if (target.endsWith('/extract-link')) return reply({schema_version:1,results:[report]});
      if (options.method==='POST') return reply({code:'PZ001',message:'private table details'},400);
      throw Error('unexpected');
    };
    const response=res();await handler(req(),response);
    assert.equal(response.code,409);
    assert.deepEqual(response.body,{error:'saved_content_limit'});
  } finally {global.fetch=oldFetch;restore();}
});

test('anonymous Supabase users cannot read or write content', async () => {
  const restore=configure(),oldFetch=global.fetch;
  try {
    let calls=0;
    global.fetch=async () => {calls++;return reply({...user,is_anonymous:true});};
    let response=res();await handler(req('GET'),response);
    assert.equal(response.code,403);
    response=res();await handler(req('POST'),response);
    assert.equal(response.code,403);
    assert.equal(calls,2);
  } finally {global.fetch=oldFetch;restore();}
});

test('large media images are omitted with explicit warnings while dates and coordinates stay bounded', () => {
  const oversized='data:image/jpeg;base64,'+'A'.repeat(410001);
  const row=handler.sanitizeReport({ ...report,cover_data_url:oversized,
    author_profile_data_url:'data:image/jpeg;base64,AAAA',
    events:[{...report.events[0],start_date:'2026-02-30',end_date:'2026-01-01'}],
    map_locations:[{...report.map_locations[0],coordinates:{lat:91,lng:126}},
      {...report.map_locations[0],image_data_url:oversized}]
  },post,userId);
  assert.equal(row.cover_data_url,null);
  assert.equal(row.events[0].start_date,null);
  assert.equal(row.events[0].needs_review,true);
  assert.match(row.events[0].notes.at(-1),/날짜/);
  assert.equal(row.map_locations.length,1);
  assert.equal(row.map_locations[0].image_data_url,null);
  assert(row.media_warnings.some(item=>item.code==='cover_omitted'));
  assert(row.media_warnings.some(item=>item.code==='place_image_omitted'));
});

test('diagnostic notes never persist configured private API tokens', () => {
  const old=process.env.PINMAP_EXTRACTOR_TOKEN;
  try {
    process.env.PINMAP_EXTRACTOR_TOKEN='sample-secret-token-123456';
    const row=handler.sanitizeReport({...report,
      notes:['Failed with sample-secret-token-123456'],
      events:[{...report.events[0],notes:['API sk-proj-abc123456789xyz failed']}]
    },post,userId);
    assert(!JSON.stringify(row).includes('sample-secret-token-123456'));
    assert(!JSON.stringify(row).includes('sk-proj-abc123456789xyz'));
    assert.match(row.extraction_notes[0],/redacted/);
  } finally {old === undefined ? delete process.env.PINMAP_EXTRACTOR_TOKEN :
    process.env.PINMAP_EXTRACTOR_TOKEN=old;}
});

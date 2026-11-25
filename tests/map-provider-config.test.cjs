const {test}=require('node:test');
const assert=require('node:assert/strict');
const handler=require('../api/map-config.js');

function request(method='GET') {
  const headers={};
  const res={statusCode:200,setHeader(name,value){headers[name]=value;return this},status(code){this.statusCode=code;return this},json(value){this.body=value;return this}};
  handler({method},res);
  return {res,headers};
}

test('map config selects Naver from its current Vercel browser ID and keeps server secrets private',()=>{
  const names=['GOOGLE_MAPS_BROWSER_KEY','KAKAO_MAP_JAVASCRIPT_KEY','NAVER_MAP_CLIENT_ID','PINMAP_MAP_PROVIDER'];
  const before=Object.fromEntries(names.map(name=>[name,process.env[name]]));
  try {
    process.env.GOOGLE_MAPS_BROWSER_KEY='google-test-key';
    process.env.KAKAO_MAP_JAVASCRIPT_KEY='kakao-test-key';
    process.env.NAVER_MAP_CLIENT_ID='naver-test-id';
    process.env.PINMAP_MAP_PROVIDER='naver';
    const {res,headers}=request();
    assert.equal(res.statusCode,200);
    assert.equal(headers['Cache-Control'],'no-store');
    assert.deepEqual(res.body.available,{google:true,naver:true});
    assert.equal(res.body.defaultProvider,'naver');
    assert.deepEqual(Object.keys(res.body).sort(),['available','defaultProvider','googleBrowserKey','naverClientId']);
    assert.equal(res.body.naverClientId,'naver-test-id');
    assert.equal(JSON.stringify(res.body).includes('kakao-test-key'),false);
    delete process.env.NAVER_MAP_CLIENT_ID;
    assert.deepEqual(request().res.body,{defaultProvider:'google',available:{google:true,naver:false},googleBrowserKey:'google-test-key',naverClientId:''});
    delete process.env.GOOGLE_MAPS_BROWSER_KEY;
    assert.deepEqual(request().res.body,{defaultProvider:'google',available:{google:false,naver:false},googleBrowserKey:'',naverClientId:''});
    assert.equal(request('POST').res.statusCode,405);
  } finally {
    for(const name of names) before[name]===undefined?delete process.env[name]:process.env[name]=before[name];
  }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import {getGooglePlacePhoto} from '../service/google-place-photo.mjs';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createMultiuserApp} from '../service/api.mjs';

const location={name:'카브론',address:'서울 용산구 대사관로31길 7',coordinates:{lat:37.533671,lng:127.005697},provider:'google_places'};
test('Google photo is returned only for a matching place and retains attribution',async()=>{
  const calls=[];
  const fetcher=async(url,options)=>{
    calls.push({url:String(url),options});
    if(calls.length===1)return Response.json({places:[
      {id:'wrong',displayName:{text:'카브론'},location:{latitude:37.7,longitude:127},photos:[{name:'places/wrong/photos/a'}]},
      {id:'right',displayName:{text:'카브론'},location:{latitude:37.53367,longitude:127.0057},photos:[{name:'places/right/photos/a',authorAttributions:[{displayName:'사진 제공자',uri:'https://maps.google.com/maps/contrib/1'}]}]}
    ]});
    return Response.json({photoUri:'https://lh3.googleusercontent.com/example'});
  };
  const photo=await getGooglePlacePhoto(location,{key:'test-key',fetcher});
  assert.equal(photo.place_id,'right');assert.equal(photo.attributions[0].name,'사진 제공자');
  assert.equal(photo.url,'https://lh3.googleusercontent.com/example');
  assert.equal(calls.length,2);assert.match(calls[1].url,/places\/right\/photos\/a\/media/);
  assert.equal(calls[0].options.headers['X-Goog-FieldMask'],'places.id,places.displayName,places.formattedAddress,places.location,places.photos');
});

test('missing or mismatched locations do not receive unrelated photos',async()=>{
  assert.equal(await getGooglePlacePhoto({...location,coordinates:null},{key:'test',fetcher:()=>{throw Error('unexpected');}}),null);
  const fetcher=async()=>Response.json({places:[{id:'far',displayName:{text:'카브론'},location:{latitude:37.7,longitude:127},photos:[{name:'places/far/photos/a'}]}]});
  assert.equal(await getGooglePlacePhoto(location,{key:'test',fetcher}),null);
});

test('local photo endpoint uses the saved matching location without exposing the server key',async()=>{
  const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),'pinmap-google-photo-'));
  const env={MULTIUSER_PORT:'0',PUBLIC_ORIGIN:'http://127.0.0.1:0',MULTIUSER_AI_PROVIDER:'gemini',GOOGLE_MAPS_API_KEY:'server-secret',GOOGLE_MAPS_BROWSER_KEY:'browser-public'};
  const app=await createMultiuserApp({dataDir,env,localTest:true,photoLookup:async(place,{key})=>{
    assert.equal(key,'server-secret');assert.equal(place.name,'카브론');return{url:'https://lh3.googleusercontent.com/example',attributions:[]};
  }});
  await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
  const base=`http://127.0.0.1:${app.server.address().port}`;
  try{
    const user='00000000-0000-4000-8000-000000000001',post='11111111-1111-4111-8111-111111111111',job='22222222-2222-4222-8222-222222222222',date=new Date().toISOString();
    app.db.prepare('INSERT INTO posts(id,user_id,source_url,title,created_at,updated_at) VALUES(?,?,?,?,?,?)').run(post,user,'https://www.instagram.com/p/example/','test',date,date);
    app.db.prepare('INSERT INTO jobs(id,user_id,post_id,fingerprint,status,source_url,material_json,settings_json,result_json,created_at,updated_at,completed_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(job,user,post,'f','completed','https://www.instagram.com/p/example/','{}','{}',JSON.stringify({map_location:{locations:[location]}}),date,date,date);
    const config=await(await fetch(base+'/api/map-config')).json();
    assert.equal(config.defaultProvider,'google');assert.equal(config.googleBrowserKey,'browser-public');
    assert.ok(!JSON.stringify(config).includes('server-secret'));
    const photo=await fetch(`${base}/api/posts/${post}/places/0/photo`);
    assert.equal(photo.status,200);assert.equal((await photo.json()).url,'https://lh3.googleusercontent.com/example');
    assert.equal((await fetch(`${base}/api/posts/${post}/places/1/photo`)).status,404);
  }finally{await new Promise(resolve=>app.server.close(resolve));app.db.close();await fs.rm(dataDir,{recursive:true,force:true});}
});

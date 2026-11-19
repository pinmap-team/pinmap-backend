import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {createMultiuserApp} from '../service/api.mjs';
import {claimJob,markExpiredJobs,enqueueImportedPosts,enqueueJob} from '../service/jobs.mjs';
import {desktopPlaceResult,processJob} from '../service/worker.mjs';
import {openDatabase} from '../service/db.mjs';
import {VllmClient} from '../service/vllm-client.mjs';
import {GeminiClient} from '../service/gemini-client.mjs';
import {providerFromEnv} from '../service/worker.mjs';
import {migrateLegacy} from '../service/migrate-legacy.mjs';
import {normalizeTranscription,transcriberFromEnv} from '../service/transcription.mjs';
import {syntheticSavedPostsZip} from './synthetic-instagram.mjs';

const fixture=syntheticSavedPostsZip();
const fixtureCount=125;
const sampleResult={title:'시험',summary:'캡션 기반 요약',summary_evidence_ids:['caption'],topics:[],visible_text:[],facts:[],inferences:[],limitations:[]};
test('public event schedule remains separate from map places in the saved job result',()=>{
  const event={title:'봄 전시',event_type:'exhibition',start_date:'2026-04-01',end_date:'2026-04-30',
    date_text:'4월 1일~30일',time_text:null,venue_name:'전시장',address:null,
    source:'caption',evidence:{kind:'caption',quote:'4월 1일~30일'},needs_review:false,notes:[]};
  const mapped=desktopPlaceResult({status:'needs_review',content_kind:'event',places:[],map_locations:[],events:[event],notes:[]});
  assert.equal(mapped.result.content_kind,'event');
  assert.deepEqual(mapped.result.events,[event]);
  assert.deepEqual(mapped.result.map_location.locations,[]);
});
test('accounts isolate ZIP posts, assets, jobs, and results',async()=>{
  const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),'pinmap-multi-'));
  const app=await createMultiuserApp({dataDir,env:{MULTIUSER_PORT:'0',PINMAP_INVITE_CODE:'invite-test-code',MULTIUSER_AI_PROVIDER:'ollama'}});
  await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));const base=`http://127.0.0.1:${app.server.address().port}`;
  const request=async(route,{method='GET',body,cookie}={})=>{const headers={...(method==='POST'?{'X-Pinmap-CSRF':'1'}:{}),...(cookie?{Cookie:cookie}:{})};if(body&&!(body instanceof FormData))headers['Content-Type']='application/json';const res=await fetch(base+route,{method,headers,body:body instanceof FormData?body:body?JSON.stringify(body):undefined});return{status:res.status,cookie:res.headers.get('set-cookie')?.split(';')[0],body:await res.json()};};
  try{
    const a=await request('/api/auth/register',{method:'POST',body:{email:'a@example.com',password:'password-123456',invite_code:'invite-test-code'}});
    const b=await request('/api/auth/register',{method:'POST',body:{email:'b@example.com',password:'password-123456',invite_code:'invite-test-code'}});
    assert.equal(a.status,201);assert.equal(b.status,201);
    const form=new FormData();form.append('file',new Blob([fixture],{type:'application/zip'}),'export.zip');
    const imported=await request('/api/import/instagram',{method:'POST',body:form,cookie:a.cookie});assert.equal(imported.status,201);assert.equal(imported.body.imported,fixtureCount);
    const own=await request('/api/posts?limit=1',{cookie:a.cookie}),other=await request('/api/posts',{cookie:b.cookie});assert.equal(own.body.total,fixtureCount);assert.equal(other.body.total,0);
    const postId=own.body.posts[0].id;assert.equal((await request(`/api/posts/${postId}`,{cookie:b.cookie})).status,404);
    assert.equal((await request('/api/jobs',{method:'POST',body:{post_id:postId},cookie:b.cookie})).status,404);
    const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lS8AAAAASUVORK5CYII=','base64');
    const media=new FormData();media.append('file',new Blob([png],{type:'image/png'}),'tiny.png');media.append('complete','true');
    const upload=await request(`/api/posts/${postId}/assets`,{method:'POST',body:media,cookie:a.cookie});assert.equal(upload.status,201);
    const assetId=upload.body.id;assert.equal((await fetch(base+`/api/assets/${assetId}`,{headers:{Cookie:b.cookie}})).status,404);
    assert.equal((await fetch(base+`/api/assets/${assetId}`,{headers:{Cookie:a.cookie}})).status,200);
    const queued=await request('/api/jobs',{method:'POST',body:{post_id:postId},cookie:a.cookie});assert.equal(queued.status,202);
    const jobId=queued.body.job.id;assert.equal((await request(`/api/jobs/${jobId}`,{cookie:b.cookie})).status,404);
    assert.equal((await request('/api/jobs',{cookie:b.cookie})).body.jobs.length,0);
    const claimed=claimJob(app.db,'test-worker');assert.equal(claimed.id,jobId);
    await processJob(app.db,claimed,{dataDir,mapResolver:async()=>({locations:[],name_lookups:[]}),provider:{async describeImage(img){return{scene:'작은 테스트 이미지',visible_text:[],objects:[],actions:[],uncertainties:[],model:'fake'};},async summarize(prepared){assert.ok(prepared.evidence.some(x=>x.id==='caption'));assert.equal(prepared.images.length,0);assert.equal(prepared.media_text.visual[0].scene,'작은 테스트 이미지');return{result:sampleResult,evidence:prepared.evidence,usage:{input_tokens:10,output_tokens:20},model:'fake'};}}});
    const done=await request(`/api/jobs/${jobId}`,{cookie:a.cookie});assert.equal(done.body.status,'completed');assert.equal(done.body.result.summary,'캡션 기반 요약');assert.equal(done.body.media_text.visual[0].evidence_id,assetId);
    assert.equal((await request(`/api/jobs/${jobId}`,{cookie:b.cookie})).status,404);
    assert.equal((await request('/api/results',{cookie:b.cookie})).body.results.length,0);
    const repeated=await request('/api/jobs',{method:'POST',body:{post_id:postId},cookie:a.cookie});assert.equal(repeated.body.reused,true);
    for(let n=0;n<5;n++)assert.equal((await request('/api/auth/login',{method:'POST',body:{email:'a@example.com',password:'incorrect-password'}})).status,401);
    assert.equal((await request('/api/auth/login',{method:'POST',body:{email:'a@example.com',password:'incorrect-password'}})).status,429);
  }finally{await new Promise(resolve=>app.server.close(resolve));app.db.close();await fs.rm(dataDir,{recursive:true,force:true});}
});
test('media text persists before synthesis and audio transcription keeps segment times',async()=>{
  const folder=await fs.mkdtemp(path.join(os.tmpdir(),'pinmap-media-text-')),db=openDatabase(path.join(folder,'pinmap.sqlite')),date=new Date().toISOString();
  try{
    db.prepare('INSERT INTO users(id,email,password_hash,created_at) VALUES(?,?,?,?)').run('u','u@example.com','test',date);
    db.prepare('INSERT INTO posts(id,user_id,source_url,title,created_at,updated_at) VALUES(?,?,?,?,?,?)').run('p','u','https://www.instagram.com/p/example/','',date,date);
    db.prepare('INSERT INTO jobs(id,user_id,post_id,fingerprint,status,source_url,material_json,settings_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)').run('j','u','p','f','queued','https://www.instagram.com/p/example/',JSON.stringify({caption:'',assets:[]}),JSON.stringify({model:'fake',maxImages:2,maxOutputTokens:500,maxVideoSeconds:10}),date,date);
    const job=claimJob(db,'worker');
    const prepared={evidence:[{id:'frame:1',kind:'video_frame',time_seconds:1}],images:[{id:'frame:1',kind:'video_frame',time_seconds:1,path:'/unused.png',mime:'image/png'}],audio:[{id:'audio:1',path:'/unused.mp3',mime:'audio/mpeg',duration_seconds:2}],coverage:{kind:'sampled_video',partial:true,audio_status:'pending_transcription'}};
    await processJob(db,job,{dataDir:folder,prepare:async()=>prepared,provider:{async describeImage(){return{scene:'사람이 걷는다',visible_text:['서울'],objects:['사람'],actions:['걷기'],uncertainties:[],model:'fake'};},async summarize(input){assert.equal(input.images.length,0);assert.equal(input.media_text.visual[0].time_seconds,1);assert.equal(input.media_text.audio[0].segments[0].start_seconds,0.2);assert.equal(input.evidence.at(-1).kind,'audio_transcript');return{result:{...sampleResult,summary_evidence_ids:['frame:1']},evidence:input.evidence,usage:null};}},transcriber:{async transcribe(){return normalizeTranscription({text:'안녕하세요',language:'ko',segments:[{start:0.2,end:1.4,text:'안녕하세요'}]});}}});
    const saved=db.prepare('SELECT * FROM jobs WHERE id=?').get('j');assert.equal(saved.status,'completed');assert.equal(JSON.parse(saved.media_text_json).visual[0].visible_text[0],'서울');assert.equal(JSON.parse(saved.coverage_json).audio_status,'transcribed');
    assert.equal(transcriberFromEnv({ASR_PROVIDER:'none'}),null);
  }finally{db.close();await fs.rm(folder,{recursive:true,force:true});}
});
test('audio jobs without ASR stop before summary and keep visual observations',async()=>{
  const folder=await fs.mkdtemp(path.join(os.tmpdir(),'pinmap-asr-gap-')),db=openDatabase(path.join(folder,'pinmap.sqlite')),date=new Date().toISOString();
  try{
    db.prepare('INSERT INTO users(id,email,password_hash,created_at) VALUES(?,?,?,?)').run('u','u@example.com','test',date);
    db.prepare('INSERT INTO posts(id,user_id,source_url,title,created_at,updated_at) VALUES(?,?,?,?,?,?)').run('p','u','https://www.instagram.com/p/example/','',date,date);
    db.prepare('INSERT INTO jobs(id,user_id,post_id,fingerprint,status,source_url,material_json,settings_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)').run('j','u','p','f','queued','https://www.instagram.com/p/example/','{"caption":"","assets":[]}','{"model":"fake"}',date,date);
    const job=claimJob(db,'worker');
    await processJob(db,job,{dataDir:folder,prepare:async()=>({evidence:[{id:'image',kind:'image'}],images:[{id:'image',kind:'image',path:'/unused.png'}],audio:[{id:'audio',path:'/unused.mp3'}],coverage:{partial:true}}),transcriber:null,provider:{async describeImage(){return{scene:'꽃',visible_text:[],objects:['꽃'],actions:[],uncertainties:[]};},async summarize(){throw Error('summary must not run');}}});
    const saved=db.prepare('SELECT status,error_json,media_text_json FROM jobs WHERE id=?').get('j');assert.equal(saved.status,'failed');assert.equal(JSON.parse(saved.error_json).code,'asr_not_configured');assert.equal(JSON.parse(saved.media_text_json).visual[0].scene,'꽃');
  }finally{db.close();await fs.rm(folder,{recursive:true,force:true});}
});
test('vLLM speech endpoint returns transcript and timecoded segments',async()=>{
  let endpoint,form;
  const transcriber=transcriberFromEnv({ASR_PROVIDER:'vllm',ASR_BASE_URL:'http://127.0.0.1:8001/v1',ASR_MODEL:'whisper-test'},async(url,options)=>{endpoint=String(url);form=options.body;return Response.json({text:'안녕',language:'ko',segments:[{start:0.1,end:0.8,text:'안녕'}]});});
  const folder=await fs.mkdtemp(path.join(os.tmpdir(),'pinmap-asr-http-')),file=path.join(folder,'audio.mp3');
  try{await fs.writeFile(file,Buffer.from('fake-audio'));const result=await transcriber.transcribe({path:file,mime:'audio/mpeg'});assert.equal(endpoint,'http://127.0.0.1:8001/v1/audio/transcriptions');assert.equal(form.get('model'),'whisper-test');assert.equal(result.segments[0].start_seconds,0.1);}
  finally{await fs.rm(folder,{recursive:true,force:true});}
});
test('two worker connections claim distinct users and preserve running jobs on disk',async()=>{
  const folder=await fs.mkdtemp(path.join(os.tmpdir(),'pinmap-queue-')),file=path.join(folder,'queue.sqlite');
  const first=openDatabase(file),second=openDatabase(file),date=new Date().toISOString();
  try{
    for(const user of ['u1','u2']){
      first.prepare('INSERT INTO users(id,email,password_hash,created_at) VALUES(?,?,?,?)').run(user,`${user}@example.com`,'test',date);
      first.prepare('INSERT INTO posts(id,user_id,source_url,title,created_at,updated_at) VALUES(?,?,?,?,?,?)').run(`p-${user}`,user,`https://www.instagram.com/p/${user}/`,'test',date,date);
      for(let n=1;n<=2;n++)first.prepare('INSERT INTO jobs(id,user_id,post_id,fingerprint,status,source_url,material_json,settings_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)').run(`${user}-job-${n}`,user,`p-${user}`,`f${n}`,'queued',`https://www.instagram.com/p/${user}/`,'{}','{}',date,date);
    }
    const a=claimJob(first,'worker-a'),b=claimJob(second,'worker-b');
    assert.notEqual(a.id,b.id);assert.notEqual(a.user_id,b.user_id);
    assert.equal(first.prepare("SELECT COUNT(*) AS n FROM jobs WHERE status='queued'").get().n,2);
    first.close();const restarted=openDatabase(file);
    assert.equal(restarted.prepare("SELECT COUNT(*) AS n FROM jobs WHERE status='preparing'").get().n,2);
    restarted.prepare('UPDATE jobs SET lease_until=? WHERE id=?').run(Date.now()-1,a.id);
    assert.equal(markExpiredJobs(restarted),1);
    assert.equal(restarted.prepare('SELECT status FROM jobs WHERE id=?').get(a.id).status,'needs_review');
    restarted.close();
  }finally{if(first.open)first.close();second.close();await fs.rm(folder,{recursive:true,force:true});}
});
test('vLLM adapter uses structured vision request and validates evidence',async()=>{
  let endpoint,body;
  const client=new VllmClient({baseUrl:'http://127.0.0.1:8000/v1',model:'vision-model',fetchImpl:async(url,options)=>{endpoint=String(url);body=JSON.parse(options.body);return{ok:true,headers:{get:()=>null},json:async()=>({id:'response-1',model:'vision-model',choices:[{finish_reason:'stop',message:{content:JSON.stringify(sampleResult)}}],usage:{prompt_tokens:12,completion_tokens:8}})};}});
  const result=await client.summarize({evidence:[{id:'caption',kind:'caption',text:'시험'}],images:[],coverage:{kind:'caption_only'}},{sourceUrl:'https://www.instagram.com/p/abc/'});
  assert.equal(endpoint,'http://127.0.0.1:8000/v1/chat/completions');assert.equal(body.response_format.type,'json_schema');assert.equal(result.result.title,'시험');
  const folder=await fs.mkdtemp(path.join(os.tmpdir(),'pinmap-vllm-')),image=path.join(folder,'image.png');
  try{await fs.writeFile(image,Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lS8AAAAASUVORK5CYII=','base64'));
    await client.summarize({evidence:[{id:'caption',kind:'caption',text:'시험'},{id:'image',kind:'image'}],images:[{id:'image',kind:'image',mime:'image/png',path:image}],coverage:{kind:'uploaded_images'}},{sourceUrl:'https://www.instagram.com/p/abc/'});
    assert.match(body.messages[1].content.at(-1).image_url.url,/^data:image\/png;base64,/);
  }finally{await fs.rm(folder,{recursive:true,force:true});}
});
test('vLLM converts one image into structured text before synthesis',async()=>{
  const folder=await fs.mkdtemp(path.join(os.tmpdir(),'pinmap-visual-http-')),file=path.join(folder,'image.png');
  try{
    await fs.writeFile(file,Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lS8AAAAASUVORK5CYII=','base64'));
    let body;const client=new VllmClient({baseUrl:'http://127.0.0.1:8000/v1',model:'vision-test',fetchImpl:async(url,options)=>{body=JSON.parse(options.body);return Response.json({model:'vision-test',choices:[{finish_reason:'stop',message:{content:JSON.stringify({scene:'사람이 걷는 장면',visible_text:['서울'],objects:['사람'],actions:['걷기'],uncertainties:[]})}}]});}});
    const result=await client.describeImage({id:'frame:1',kind:'video_frame',path:file,mime:'image/png',time_seconds:2});
    assert.equal(body.response_format.json_schema.name,'pinmap_visual_text');assert.equal(body.messages[1].content[0].text.includes('frame:1'),true);assert.equal(result.visible_text[0],'서울');
  }finally{await fs.rm(folder,{recursive:true,force:true});}
});
test('Gemini sends a private-key vision request and checks evidence in summary',async()=>{
  const folder=await fs.mkdtemp(path.join(os.tmpdir(),'pinmap-gemini-')),file=path.join(folder,'image.png');
  const calls=[];
  try{
    await fs.writeFile(file,Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/lS8AAAAASUVORK5CYII=','base64'));
    const client=new GeminiClient({apiKey:'private-test-key',fetchImpl:async(url,options)=>{calls.push({url:String(url),options});return Response.json({modelVersion:'gemini-2.5-flash',candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify(calls.length===1?{scene:'서울 간판',visible_text:['서울'],objects:['간판'],actions:[],uncertainties:[]}:sampleResult)}]}}],usageMetadata:{totalTokenCount:25}});}});
    const observation=await client.describeImage({id:'frame:1',kind:'video_frame',path:file,mime:'image/png',time_seconds:2});
    assert.equal(observation.visible_text[0],'서울');
    const request=JSON.parse(calls[0].options.body);
    assert.match(calls[0].url,/models\/gemini-2\.5-flash:generateContent$/);
    assert.equal(calls[0].options.headers['x-goog-api-key'],'private-test-key');
    assert.equal(request.contents[0].parts[1].inline_data.mime_type,'image/png');
    assert.equal(request.generationConfig.responseMimeType,'application/json');
    assert.ok(request.generationConfig.responseJsonSchema.properties.visible_text);
    const summary=await client.summarize({evidence:[{id:'caption',kind:'caption',text:'서울'}],images:[],coverage:{kind:'caption_only'}},{sourceUrl:'https://www.instagram.com/p/abc/'});
    assert.equal(summary.result.title,'시험');
    assert.equal(JSON.stringify(calls[1].options.body).includes('private-test-key'),false);
    await assert.rejects(new GeminiClient({apiKey:'private-test-key',fetchImpl:async()=>Response.json({candidates:[{finishReason:'STOP',content:{parts:[{text:JSON.stringify({...sampleResult,summary_evidence_ids:['unknown']})}]}}]})}).summarize({evidence:[{id:'caption',kind:'caption',text:'서울'}],images:[],coverage:{}},{}),{code:'unknown_evidence'});
    assert.ok(providerFromEnv({providerName:'gemini',model:'gemini-2.5-flash'},{GEMINI_API_KEY:'private-test-key'}) instanceof GeminiClient);
  }finally{await fs.rm(folder,{recursive:true,force:true});}
});
test('Gemini ZIP batch queues caption posts without attempting public-link collection',async()=>{
  const folder=await fs.mkdtemp(path.join(os.tmpdir(),'pinmap-gemini-zip-')),db=openDatabase(path.join(folder,'pinmap.sqlite')),date=new Date().toISOString();
  try{
    db.prepare('INSERT INTO users(id,email,password_hash,created_at) VALUES(?,?,?,?)').run('u','u@example.com','test',date);
    for(const [id,caption] of [['with-caption','서울의 카페'],['without-caption','']])db.prepare('INSERT INTO posts(id,user_id,source_url,title,caption,created_at,updated_at) VALUES(?,?,?,?,?,?,?)').run(id,'u',`https://www.instagram.com/p/${id}/`,'test',caption,date,date);
    const result=enqueueImportedPosts(db,'u',['https://www.instagram.com/p/with-caption/','https://www.instagram.com/p/without-caption/'],{providerName:'gemini',model:'gemini-2.5-flash'});
    assert.deepEqual(result,{queued:1,reused:0,skipped:1});
    const material=JSON.parse(db.prepare('SELECT material_json FROM jobs').get().material_json);
    assert.equal(material.caption,'서울의 카페');assert.equal(material.collect_public,undefined);
  }finally{db.close();await fs.rm(folder,{recursive:true,force:true});}
});
test('local API serves the connected map app without exposing private files',async()=>{
  const folder=await fs.mkdtemp(path.join(os.tmpdir(),'pinmap-frontend-'));
  await fs.writeFile(path.join(folder,'index.html'),'<h1>Pinmap</h1>');
  const app=await createMultiuserApp({dataDir:path.join(folder,'data'),env:{MULTIUSER_PORT:'0',PINMAP_FRONTEND_DIR:folder,MULTIUSER_AI_PROVIDER:'gemini'}});
  await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));const base=`http://127.0.0.1:${app.server.address().port}`;
  try{
    assert.match(await(await fetch(base+'/')).text(),/Pinmap/);
    assert.equal(await(await fetch(base+'/backend-config.js')).text(),'window.PINMAP_BACKEND=true;window.PINMAP_LOCAL_TEST=false;');
    assert.equal((await fetch(base+'/api/me')).status,401);
    assert.equal((await fetch(base+'/.env')).status,404);
  }finally{await new Promise(resolve=>app.server.close(resolve));app.db.close();await fs.rm(folder,{recursive:true,force:true});}
});
test('legacy migration assigns historical results only to the chosen account and is repeatable',async()=>{
  const folder=await fs.mkdtemp(path.join(os.tmpdir(),'pinmap-migrate-')),dataDir=path.join(folder,'new'),legacyRoot=path.join(folder,'old'),sourceRoot=path.join(folder,'source'),db=openDatabase(path.join(dataDir,'pinmap.sqlite'));
  try{
    const date=new Date().toISOString(),first={id:'synthetic-1',url:'https://www.instagram.com/p/Synthetic0001/',title:'테스트 장소',sourceCaption:'서울 종로구 테스트로 1'};
    await fs.mkdir(sourceRoot,{recursive:true});
    await fs.writeFile(path.join(sourceRoot,'pinmap-items.json'),JSON.stringify([first]));
    db.prepare('INSERT INTO users(id,email,password_hash,created_at) VALUES(?,?,?,?)').run('owner','owner@example.com','test',date);
    db.prepare('INSERT INTO users(id,email,password_hash,created_at) VALUES(?,?,?,?)').run('other','other@example.com','test',date);
    await fs.mkdir(path.join(legacyRoot,'jobs'),{recursive:true});
    await fs.writeFile(path.join(legacyRoot,'jobs','historical.json'),JSON.stringify({status:'completed',item_id:first.id,fingerprint:'old-fingerprint',source_url:first.url,created_at:date,completed_at:date,material:{caption:first.sourceCaption},provider:{name:'ollama',model:'test'},result:sampleResult,evidence:[{id:'caption',kind:'caption'}],coverage:{kind:'caption_only'},usage:{}}));
    const options={db,dataDir,email:'owner@example.com',sourceRoot,legacyRoot};
    const migrated=await migrateLegacy(options);assert.equal(migrated.imported_posts,1);assert.equal(migrated.imported_results,1);
    const again=await migrateLegacy(options);assert.equal(again.imported_posts,0);assert.equal(again.imported_results,0);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM posts WHERE user_id=?').get('other').n,0);
  }finally{db.close();await fs.rm(folder,{recursive:true,force:true});}
});

test('public-link jobs queue without a caption, remain isolated, and preserve save metadata',async()=>{
 const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),'pinmap-link-'));
 const app=await createMultiuserApp({dataDir,env:{PINMAP_INVITE_CODE:'test',MULTIUSER_AI_PROVIDER:'ollama',PINMAP_EXTRACTOR_ORIGIN:'https://extractor.example.test'}});
 await new Promise(r=>app.server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${app.server.address().port}`;
 let cookie='';const req=async(route,body)=>{const r=await fetch(base+route,{method:'POST',headers:{'Content-Type':'application/json','X-Pinmap-CSRF':'1',Cookie:cookie},body:JSON.stringify(body)});if(r.headers.get('set-cookie'))cookie=r.headers.get('set-cookie').split(';')[0];return {status:r.status,body:await r.json()};};
 try{await req('/api/auth/register',{email:'link@example.test',password:'test-password-1234',invite_code:'test'});const p=await req('/api/posts',{source_url:'https://www.instagram.com/reel/DfCipmOSLSA/',metadata:{memo:'keep',collection:'test'}});assert.equal(p.body.metadata.memo,'keep');
 assert.equal((await req('/api/jobs',{post_id:p.body.id,require_visual:true})).status,400);
 const j=await req('/api/jobs',{post_id:p.body.id,require_visual:true,collect_public:true});assert.equal(j.status,202);assert.equal(JSON.parse(app.db.prepare('SELECT material_json FROM jobs WHERE id=?').get(j.body.job.id).material_json).collect_public,true);
 assert.equal((await req('/api/jobs',{post_id:p.body.id,collect_public:true})).body.reused,true);
 }finally{await new Promise(r=>app.server.close(r));app.db.close();await fs.rm(dataDir,{recursive:true,force:true});}
});

test('worker retains explicit caption address even when the model omits it',async()=>{
 const folder=await fs.mkdtemp(path.join(os.tmpdir(),'pinmap-address-worker-')),db=openDatabase(path.join(folder,'pinmap.sqlite')),date=new Date().toISOString();
 try{
  db.prepare('INSERT INTO users(id,email,password_hash,created_at) VALUES(?,?,?,?)').run('u','u@example.com','test',date);
  db.prepare('INSERT INTO posts(id,user_id,source_url,title,created_at,updated_at) VALUES(?,?,?,?,?,?)').run('p','u','https://www.instagram.com/reel/DfPe6egKq_z/','',date,date);
  db.prepare('INSERT INTO jobs(id,user_id,post_id,fingerprint,status,source_url,material_json,settings_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)').run('j','u','p','f','queued','https://www.instagram.com/reel/DfPe6egKq_z/','{}','{"model":"fake"}',date,date);
  const prepared={evidence:[{id:'caption',kind:'caption',text:'📍국립스포츠박물관 도서관\n✔️ 서울 송파구 올림픽로 424'}],images:[],audio:[],coverage:{kind:'caption_only',partial:true}};
  await processJob(db,claimJob(db,'worker'),{dataDir:folder,prepare:async()=>prepared,mapResolver:async()=>({locations:[],name_lookups:[]}),provider:{async summarize(){return{result:structuredClone(sampleResult),evidence:prepared.evidence,usage:null};}}});
  const row=db.prepare('SELECT status,result_json FROM jobs WHERE id=?').get('j');assert.equal(row.status,'completed');
  const result=JSON.parse(row.result_json);assert.equal(result.map_location.addresses[0].value,'서울 송파구 올림픽로 424');assert.equal(result.map_location.addresses[0].source,'caption');assert.equal(result.map_location.status,'needs_verification');assert.equal(result.map_location.coordinates,null);
 }finally{db.close();await fs.rm(folder,{recursive:true,force:true});}
});
test('worker persists a map pin selected from a place name',async()=>{
 const folder=await fs.mkdtemp(path.join(os.tmpdir(),'pinmap-name-pin-')),db=openDatabase(path.join(folder,'pinmap.sqlite')),date=new Date().toISOString();
 try{
  db.prepare('INSERT INTO users(id,email,password_hash,created_at) VALUES(?,?,?,?)').run('u','u@example.com','test',date);
  db.prepare('INSERT INTO posts(id,user_id,source_url,title,created_at,updated_at) VALUES(?,?,?,?,?,?)').run('p','u','https://www.instagram.com/p/example/','',date,date);
  db.prepare('INSERT INTO jobs(id,user_id,post_id,fingerprint,status,source_url,material_json,settings_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)').run('j','u','p','f','queued','https://www.instagram.com/p/example/','{}','{"model":"fake"}',date,date);
  const prepared={evidence:[{id:'caption',kind:'caption',text:'부산 테스트 카페'}],images:[],audio:[],coverage:{kind:'caption_only',partial:true}};
  const result={...sampleResult,facts:[{field:'place_name',value:'테스트 카페',evidence_ids:['caption']}]};
  await processJob(db,claimJob(db,'worker'),{dataDir:folder,prepare:async()=>prepared,provider:{async summarize(){return{result,evidence:prepared.evidence,usage:null};}},mapResolver:async()=>({locations:[{name:'테스트 카페',address:'부산 해운대구 2',coordinates:{lat:35.16,lng:129.16},source:'place_name',provider:'google_places',evidence_ids:['caption'],review_required:true}],name_lookups:[]})});
  const saved=db.prepare('SELECT status,result_json FROM jobs WHERE id=?').get('j');assert.equal(saved.status,'completed');
  const map=JSON.parse(saved.result_json).map_location;assert.equal(map.locations[0].coordinates.lat,35.16);assert.equal(map.addresses[0].source,'map_lookup');
 }finally{db.close();await fs.rm(folder,{recursive:true,force:true});}
});
test('map provider outage keeps the completed media analysis and its review note',async()=>{
 const folder=await fs.mkdtemp(path.join(os.tmpdir(),'pinmap-map-outage-')),db=openDatabase(path.join(folder,'pinmap.sqlite')),date=new Date().toISOString();
 try{
  db.prepare('INSERT INTO users(id,email,password_hash,created_at) VALUES(?,?,?,?)').run('u','u@example.com','test',date);
  db.prepare('INSERT INTO posts(id,user_id,source_url,title,created_at,updated_at) VALUES(?,?,?,?,?,?)').run('p','u','https://www.instagram.com/p/example/','',date,date);
  db.prepare('INSERT INTO jobs(id,user_id,post_id,fingerprint,status,source_url,material_json,settings_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)').run('j','u','p','f','queued','https://www.instagram.com/p/example/','{}','{"model":"fake"}',date,date);
  const prepared={evidence:[{id:'caption',kind:'caption',text:'테스트 카페'}],images:[],audio:[],coverage:{kind:'caption_only',partial:false}};
  await processJob(db,claimJob(db,'worker'),{dataDir:folder,prepare:async()=>prepared,
   provider:{async summarize(){return{result:{...sampleResult,facts:[{field:'place_name',value:'테스트 카페',evidence_ids:['caption']}],limitations:[]},evidence:prepared.evidence,usage:null};}},
   mapResolver:async()=>{throw Error('map service unavailable');}});
  const saved=db.prepare('SELECT status,result_json FROM jobs WHERE id=?').get('j');
  assert.equal(saved.status,'completed');
  const result=JSON.parse(saved.result_json);
  assert.equal(result.facts[0].value,'테스트 카페');
  assert.ok(result.limitations.includes('지도 장소 확인을 완료하지 못했습니다.'));
 }finally{db.close();await fs.rm(folder,{recursive:true,force:true});}
});
test('Gemini link-only job stores desktop extractor locations without running the provider twice',async()=>{
 const folder=await fs.mkdtemp(path.join(os.tmpdir(),'pinmap-desktop-link-')),db=openDatabase(path.join(folder,'pinmap.sqlite')),date=new Date().toISOString();
 try{
  db.prepare('INSERT INTO users(id,email,password_hash,created_at) VALUES(?,?,?,?)').run('u','u@example.com','test',date);
  db.prepare('INSERT INTO posts(id,user_id,source_url,title,created_at,updated_at) VALUES(?,?,?,?,?,?)').run('p','u','https://www.instagram.com/p/example/','',date,date);
  db.prepare('INSERT INTO jobs(id,user_id,post_id,fingerprint,status,source_url,material_json,settings_json,created_at,updated_at) VALUES(?,?,?,?,?,?,?,?,?,?)').run('j','u','p','f','queued','https://www.instagram.com/p/example/',JSON.stringify({caption:'',assets:[],collect_public:true}),JSON.stringify({providerName:'gemini',model:'gemini-2.5-flash'}),date,date);
  const report={status:'needs_review',places:[{name:'서울숲',address:'서울 성동구 왕십리로',source:'ai_api',evidence:{kind:'caption',quote:'서울숲'}}],map_locations:[{name:'서울숲',address:'서울 성동구 왕십리로',coordinates:{lat:37.5435,lng:127.0447},coordinate_source:'photon_openstreetmap',needs_review:true}],notes:[]};
  await processJob(db,claimJob(db,'worker'),{dataDir:folder,desktopCollector:async()=>report,provider:{async summarize(){throw Error('double AI call');}}});
  const saved=db.prepare('SELECT status,result_json FROM jobs WHERE id=?').get('j');assert.equal(saved.status,'completed');
  const result=JSON.parse(saved.result_json);assert.equal(result.map_location.locations[0].coordinates.lat,37.5435);assert.equal(result.facts[0].value,'서울숲');
 }finally{db.close();await fs.rm(folder,{recursive:true,force:true});}
});
test('configured shared extractor permits a Gemini link-only job',async()=>{
 const folder=await fs.mkdtemp(path.join(os.tmpdir(),'pinmap-link-queue-')),db=openDatabase(path.join(folder,'pinmap.sqlite')),date=new Date().toISOString();
 try{
  db.prepare('INSERT INTO users(id,email,password_hash,created_at) VALUES(?,?,?,?)').run('u','u@example.com','test',date);
  db.prepare('INSERT INTO posts(id,user_id,source_url,title,created_at,updated_at) VALUES(?,?,?,?,?,?)').run('p','u','https://www.instagram.com/p/example/','',date,date);
  db.prepare('INSERT INTO assets(id,user_id,post_id,kind,mime,path,name,bytes,sha256,complete,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
   .run('uploaded','u','p','image','image/jpeg','/user/upload.jpg','upload.jpg',1,'hash',1,date);
  const queued=await enqueueJob(db,'u','p',{providerName:'gemini',model:'gemini-2.5-flash',dailyJobLimit:10},{collectPublic:true,env:{PINMAP_EXTRACTOR_ORIGIN:'https://extractor.example.test'}});
  assert.equal(queued.job.status,'queued');assert.equal(JSON.parse(db.prepare('SELECT material_json FROM jobs WHERE id=?').get(queued.job.id).material_json).collect_public,true);
 }finally{db.close();await fs.rm(folder,{recursive:true,force:true});}
});

test('ZIP auto-analysis persists all synthetic jobs, deduplicates and exposes per-post results beyond 100',async()=>{
 const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),'pinmap-batch-')),app=await createMultiuserApp({dataDir,env:{PINMAP_INVITE_CODE:'test',MULTIUSER_AI_PROVIDER:'ollama',PINMAP_EXTRACTOR_ORIGIN:'https://extractor.example.test'}});
 await new Promise(r=>app.server.listen(0,'127.0.0.1',r));const base=`http://127.0.0.1:${app.server.address().port}`;
 try{
  const response=await fetch(base+'/api/auth/register',{method:'POST',headers:{'Content-Type':'application/json','X-Pinmap-CSRF':'1'},body:JSON.stringify({email:'batch@example.test',password:'test-password-1234',invite_code:'test'})});const cookie=response.headers.get('set-cookie').split(';')[0];
  const upload=async()=>{const form=new FormData();form.append('file',new Blob([fixture]),'export.zip');form.append('auto_analyze','true');const r=await fetch(base+'/api/import/instagram',{method:'POST',headers:{Cookie:cookie,'X-Pinmap-CSRF':'1'},body:form});assert.equal(r.status,201);return r.json();};
  const first=await upload();assert.equal(first.analysis.queued,fixtureCount);const duplicate=await upload();assert.equal(duplicate.analysis.queued,0);assert.equal(duplicate.analysis.reused,fixtureCount);assert.equal(app.db.prepare('SELECT COUNT(*) n FROM jobs').get().n,fixtureCount);
  const page=await(await fetch(base+'/api/posts?offset=100&limit=100',{headers:{Cookie:cookie}})).json();assert.equal(page.posts.length,fixtureCount-100);assert.ok(page.posts.every(p=>p.analysis.status==='queued'));
  const claimed=claimJob(app.db,'batch-worker');assert.ok(claimed);assert.equal(claimJob(app.db,'other-worker'),null);assert.equal(JSON.parse(claimed.material_json).collect_public,true);
  assert.equal((await fetch(base+'/api/posts')).status,401);
 }finally{await new Promise(r=>app.server.close(r));app.db.close();await fs.rm(dataDir,{recursive:true,force:true});}
});

test('completed jobs do not impose a daily analysis quota',async()=>{
 const folder=await fs.mkdtemp(path.join(os.tmpdir(),'pinmap-unlimited-')),db=openDatabase(path.join(folder,'pinmap.sqlite')),date=new Date().toISOString();
 try{
  db.prepare('INSERT INTO users(id,email,password_hash,created_at) VALUES(?,?,?,?)').run('u','u@example.com','test',date);
  db.prepare('INSERT INTO posts(id,user_id,source_url,title,created_at,updated_at) VALUES(?,?,?,?,?,?)').run('p','u','https://www.instagram.com/p/example/','',date,date);
  for(let i=0;i<55;i++){
   const queued=await enqueueJob(db,'u','p',{providerName:'gemini',model:'gemini-2.5-flash',dailyJobLimit:1},{force:true,collectPublic:true,env:{PINMAP_EXTRACTOR_ORIGIN:'https://extractor.example.test'}});
   assert.equal(queued.reused,false);
   db.prepare("UPDATE jobs SET status='completed' WHERE id=?").run(queued.job.id);
  }
  assert.equal(db.prepare('SELECT COUNT(*) AS n FROM jobs').get().n,55);
 }finally{db.close();await fs.rm(folder,{recursive:true,force:true});}
});

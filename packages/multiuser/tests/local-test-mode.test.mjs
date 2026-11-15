import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import {createMultiuserApp} from '../service/api.mjs';

test('loopback local mode saves and queues links without login while normal mode stays protected',async()=>{
  const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),'pinmap-local-test-'));
  const env={MULTIUSER_PORT:'0',MULTIUSER_HOST:'127.0.0.1',PUBLIC_ORIGIN:'http://127.0.0.1:0',MULTIUSER_AI_PROVIDER:'gemini',PINMAP_EXTRACTOR_ORIGIN:'https://extractor.example.test',PINMAP_FRONTEND_DIR:dataDir};
  const app=await createMultiuserApp({dataDir,env,localTest:true});
  await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
  const base=`http://127.0.0.1:${app.server.address().port}`;
  try{
    const me=await fetch(base+'/api/me');assert.equal(me.status,200);assert.equal((await me.json()).user.local_test,true);
    const config=await fetch(base+'/backend-config.js');assert.match(await config.text(),/PINMAP_LOCAL_TEST=true/);
    const created=await fetch(base+'/api/posts',{method:'POST',headers:{'Content-Type':'application/json','X-Pinmap-CSRF':'1'},body:JSON.stringify({source_url:'https://www.instagram.com/p/DS6fsPBkjtj/'})});
    assert.equal(created.status,201);const post=await created.json();
    const queued=await fetch(base+'/api/jobs',{method:'POST',headers:{'Content-Type':'application/json','X-Pinmap-CSRF':'1'},body:JSON.stringify({post_id:post.id,collect_public:true})});
    assert.equal(queued.status,202);
    assert.equal((await (await fetch(base+'/api/posts')).json()).total,1);
    assert.equal((await fetch(base+'/api/auth/login',{method:'POST',headers:{'Content-Type':'application/json','X-Pinmap-CSRF':'1'},body:'{}'})).status,404);
    const badHost=await new Promise((resolve,reject)=>http.get(base+'/api/posts',{headers:{Host:'example.com'}},res=>{res.resume();res.on('end',()=>resolve(res.statusCode));}).on('error',reject));
    assert.equal(badHost,403);
  }finally{await new Promise(resolve=>app.server.close(resolve));app.db.close();await fs.rm(dataDir,{recursive:true,force:true});}
  const normal=await createMultiuserApp({dataDir,env,localTest:false});
  await new Promise(resolve=>normal.server.listen(0,'127.0.0.1',resolve));
  try{assert.equal((await fetch(`http://127.0.0.1:${normal.server.address().port}/api/me`)).status,401);}
  finally{await new Promise(resolve=>normal.server.close(resolve));normal.db.close();await fs.rm(dataDir,{recursive:true,force:true});}
});

test('local mode refuses a non-loopback binding',async()=>{
  const dataDir=await fs.mkdtemp(path.join(os.tmpdir(),'pinmap-local-guard-'));
  try{await assert.rejects(()=>createMultiuserApp({dataDir,localTest:true,env:{MULTIUSER_HOST:'0.0.0.0',PUBLIC_ORIGIN:'https://example.com',MULTIUSER_AI_PROVIDER:'gemini'}}),/127\.0\.0\.1/);}
  finally{await fs.rm(dataDir,{recursive:true,force:true});}
});

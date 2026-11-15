import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {openDatabase} from '../service/db.mjs';
import {saveDesktopCover} from '../service/desktop-cover.mjs';

test('shared extractor cover becomes a private post image and is not duplicated',async()=>{
  const root=await fs.mkdtemp(path.join(os.tmpdir(),'pinmap-cover-'));
  const dataDir=path.join(root,'private');
  const cover=Buffer.from([255,216,255,224,0,16,74,70,73,70]);
  const db=openDatabase(path.join(dataDir,'pinmap.sqlite'));
  try{
    const date=new Date().toISOString();
    db.prepare('INSERT INTO users(id,email,password_hash,created_at) VALUES(?,?,?,?)').run('u','u@example.test','test',date);
    db.prepare('INSERT INTO posts(id,user_id,source_url,title,created_at,updated_at) VALUES(?,?,?,?,?,?)').run('p','u','https://www.instagram.com/p/example/','',date,date);
    db.prepare('INSERT INTO assets(id,user_id,post_id,kind,mime,path,name,bytes,sha256,complete,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?)')
      .run('uploaded','u','p','image','image/jpeg','/user/other.jpg','other.jpg',cover.length,'user-hash',1,date);
    const job={user_id:'u',post_id:'p',source_url:'https://www.instagram.com/p/example/'};
    const report={post_id:'ig_example',cover_data_url:`data:image/jpeg;base64,${cover.toString('base64')}`};
    const id=await saveDesktopCover(db,job,report,{dataDir});
    assert.ok(id);
    assert.notEqual(id,'uploaded');
    const saved=db.prepare('SELECT * FROM assets WHERE id=?').get(id);
    assert.equal(saved.mime,'image/jpeg');
    assert.equal(saved.origin,'extractor_cover');
    assert.deepEqual(await fs.readFile(saved.path),cover);
    assert.equal(await saveDesktopCover(db,job,report,{dataDir}),id);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM assets').get().n,2);
    assert.equal(await saveDesktopCover(db,job,{...report,post_id:'ig_other'},{dataDir}),null);
  }finally{db.close();await fs.rm(root,{recursive:true,force:true});}
});

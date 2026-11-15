import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import {identifyMedia} from '../lib/media.mjs';
import {now} from './db.mjs';

// Save only the cover returned for this public post by the shared extractor.
export async function saveDesktopCover(db,job,report,{dataDir}={}){
  const code=new URL(job.source_url).pathname.match(/^\/(?:p|reel|tv)\/([A-Za-z0-9_-]+)\/?$/)?.[1];
  if(!code||report?.post_id!==`ig_${code}`)return null;
  const existing=db.prepare("SELECT id FROM assets WHERE user_id=? AND post_id=? AND origin='extractor_cover' ORDER BY created_at,id LIMIT 1").get(job.user_id,job.post_id);
  if(existing)return existing.id;
  const encoded=report.cover_data_url;
  if(typeof encoded!=='string'||encoded.length>1024*1024)return null;
  const match=encoded.match(/^data:image\/(jpeg|png|webp);base64,([A-Za-z0-9+/]+={0,2})$/);
  if(!match)return null;
  const bytes=Buffer.from(match[2],'base64');
  if(!bytes.length||bytes.length>512*1024)return null;
  const name=`instagram-cover.${match[1]==='jpeg'?'jpg':match[1]}`;
  const type=identifyMedia(bytes.subarray(0,16),name);
  if(type.kind!=='image')return null;
  const id=crypto.randomUUID(),targetFolder=path.join(dataDir,'assets',job.user_id,job.post_id);
  const target=path.join(targetFolder,id+type.extension);
  await fs.mkdir(targetFolder,{recursive:true,mode:0o700});
  await fs.writeFile(target,bytes,{flag:'wx',mode:0o600});
  try{
    db.prepare('INSERT INTO assets(id,user_id,post_id,kind,mime,path,name,bytes,sha256,complete,origin,created_at) VALUES(?,?,?,?,?,?,?,?,?,?,?,?)')
      .run(id,job.user_id,job.post_id,'image',type.mime,target,name,bytes.length,
           crypto.createHash('sha256').update(bytes).digest('hex'),1,'extractor_cover',now());
  }catch(error){await fs.unlink(target).catch(()=>{});throw error;}
  return id;
}

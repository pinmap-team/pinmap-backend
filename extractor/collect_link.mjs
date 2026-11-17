import fs from 'node:fs/promises';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import {fileURLToPath} from 'node:url';
import {BrowserCollector} from './collector/browser.mjs';
import {canonicalPost,readPublicDocument} from './collector/extract.mjs';
const exec = promisify(execFile);
const root = path.dirname(fileURLToPath(import.meta.url));
const target = canonicalPost(process.argv[2]);
const mode = process.argv[3] || 'caption';
if(!['caption','media'].includes(mode)) throw Error('mode must be caption or media');
// The HTTP server supplies a private directory for each extraction request.
// Keep the old default for standalone local collection commands.
const mediaRoot = process.env.PINMAP_MEDIA_ROOT || path.join(root,'data','media');
const folder = path.join(mediaRoot,'ig_'+target.code);
const profile = process.env.PINMAP_BROWSER_PROFILE_DIR || path.join(root,'data','browser');
const report = {post_id:'ig_'+target.code,source_url:target.url,status:'unavailable',caption:'',media_files:[],notes:[]};
let slideBackup=null;
let previousSlides=[];
const collector = new BrowserCollector(profile,{headless:true});
function captionFromMeta(value){
  const marker = String(value||'').indexOf(': "');
  if(marker<0) return '';
  const text = value.slice(marker+3);
  return text.replace(/\"\.?\s*$/, '');
}
try{
  const item=await collector.collect({url:target.url});
  report.status=item.status;
  if(item.status!=='collected'){
    report.notes.push(item.status==='age_restricted'
      ? 'Instagram이 연령 제한 화면을 표시했습니다. 이 브라우저에서는 로그인하지 않아 게시물 사진과 캡션 본문에 접근할 수 없습니다.'
      : 'Instagram 공개 화면: '+item.status);
  }else{
    const page=collector.context.pages()[0];
    let snapshot=await page.evaluate(readPublicDocument);
    const metaAuthor=(snapshot.meta?.['og:description']||'').match(/\s-\s([A-Za-z0-9._]+)\s-/)?.[1];
    report.author_username=snapshot.author?.username||metaAuthor||null;
    const profileUrl=snapshot.author?.profile_image_url;
    if(profileUrl && report.author_username){
      try{
        const parsed=new URL(profileUrl);
        if(parsed.protocol==='https:'&&/(^|\.)(?:fbcdn\.net|cdninstagram\.com|instagram\.com)$/.test(parsed.hostname)){
          const response=await collector.context.request.get(profileUrl,{timeout:12000});
          const mime=(response.headers()['content-type']||'').split(';')[0].trim().toLowerCase();
          if(response.ok()&&['image/jpeg','image/png','image/webp'].includes(mime)){
            const bytes=await response.body();
            if(bytes.length&&bytes.length<=300*1024)report.author_profile_data_url='data:'+mime+';base64,'+bytes.toString('base64');
          }
        }
      }catch{}
    }
    report.caption=captionFromMeta(snapshot.meta?.['og:description']);
    if(!report.caption){
      report.caption=(await page.locator('article h1').first().innerText().catch(()=>''))?.trim()||'';
    }
    if(!report.caption)report.notes.push('공개 화면에서 캡션을 읽지 못했습니다.');
    const coverUrl=snapshot.meta?.['og:image']||snapshot.images?.[0]?.src;
    if(coverUrl){
      try{
        const parsed=new URL(coverUrl);
        if(parsed.protocol==='https:'&&/(^|\.)(?:fbcdn\.net|cdninstagram\.com|instagram\.com)$/.test(parsed.hostname)){
          const response=await collector.context.request.get(coverUrl,{timeout:20000});
          const mime=(response.headers()['content-type']||'').split(';')[0].trim().toLowerCase();
          if(response.ok()&&['image/jpeg','image/png','image/webp'].includes(mime)){
            const bytes=await response.body();
            if(bytes.length&&bytes.length<=8*1024*1024){
              const name='link-cover.'+({ 'image/jpeg':'jpg','image/png':'png','image/webp':'webp' }[mime]);
              await fs.mkdir(folder,{recursive:true,mode:0o700});
              await fs.writeFile(path.join(folder,name),bytes,{mode:0o600});
              report.media_files.push(name);
            }
          }
        }
      }catch{report.notes.push('콘텐츠 대표 이미지를 가져오지 못했습니다.');}
    }
    if(mode==='media'){
      await fs.mkdir(folder,{recursive:true,mode:0o700});
      if(target.kind!=='reel'){
        previousSlides=(await fs.readdir(folder)).filter(name=>/^link-slide-\d+\.jpg$/i.test(name));
        if(previousSlides.length){
          slideBackup=await fs.mkdtemp(path.join(os.tmpdir(),'pinmap-slides-'));
          for(const name of previousSlides)await fs.copyFile(path.join(folder,name),path.join(slideBackup,name));
        }
      }
      for(const name of await fs.readdir(folder)){
        if(/^video-frame-\d+(?:ms|s)\.(?:jpe?g|png)$/i.test(name)||/^link-slide-\d+\.jpg$/i.test(name)||/^link-[A-Za-z0-9_-]+\.(?:mp4|mov|webm|info\.json)$/i.test(name))await fs.unlink(path.join(folder,name));
      }
      if(target.kind==='reel'||snapshot.video){
        const downloader=process.env.PINMAP_YT_DLP_BIN || path.join(root,'.venv','bin','yt-dlp');
        try{
          await exec(downloader,['--ignore-config','--retries','0','--socket-timeout','20','--max-filesize','150M',...(process.env.PINMAP_YT_DLP_COOKIES?['--cookies-from-browser',process.env.PINMAP_YT_DLP_COOKIES]:[]),'--write-info-json','-o',path.join(folder,'link-%(id)s.%(ext)s'),target.url],{timeout:180000,maxBuffer:1024*1024});
          const names=await fs.readdir(folder);
          report.media_files=names.filter(n=>/\.(mp4|mov|webm)$/i.test(n));
          const info=names.find(n=>n.endsWith('.info.json'));
          if(info){const data=JSON.parse(await fs.readFile(path.join(folder,info),'utf8'));report.caption=data.description||report.caption;}
        }catch(e){
          report.notes.push('Instagram이 영상 파일 다운로드를 제한했습니다. 브라우저 재생 프레임을 대신 분석합니다.');
          const video=page.locator('main video').first();
          if(await video.count()){
            const duration=await page.evaluate(async()=>{const v=document.querySelector('main video');await v.play().catch(()=>{});return Number.isFinite(v.duration)?v.duration:0;}).catch(()=>0);
            const interval=duration>0?Math.max(0.5,duration/120):0.5;
            const count=Math.min(120,Math.max(1,Math.ceil((duration||10)/interval)));
            for(let index=0;index<count;index++){
              const second=Math.min(index*interval,Math.max(0,duration-0.15));
              try{
                await page.evaluate(t=>{const v=document.querySelector('main video');v.pause();v.currentTime=t;},second);
                await page.waitForFunction(t=>{const v=document.querySelector('main video');return v&&v.readyState>=2&&Math.abs(v.currentTime-t)<0.8;},second,{timeout:5000}).catch(()=>{});
                await page.waitForTimeout(120);
                const name='video-frame-'+String(Math.round(second*1000)).padStart(6,'0')+'ms.jpg';
                await video.screenshot({path:path.join(folder,name),type:'jpeg',quality:72,timeout:10000});
                report.media_files.push(name);
              }catch{report.notes.push('재생 프레임 일부를 캡처하지 못했습니다.');}
            }
            if(report.media_files.length)report.notes.push('영상 원본 대신 브라우저 재생 프레임 '+report.media_files.length+'장을 분석합니다. 음성은 포함되지 않습니다.');
          }
        }
      }
      if(target.kind!=='reel'||!report.media_files.length){
        const seen=new Set();let count=0,totalSlideBytes=0,sizeLimitNoted=false;
        const maxSlideBytes=12*1024*1024,maxTotalSlideBytes=96*1024*1024;
        for(let slide=0;slide<20;slide++){
          snapshot=await page.evaluate(readPublicDocument);
          for(const image of snapshot.images||[]){
            try{
              const response=await collector.context.request.get(image.src,{timeout:20000});
              if(!response.ok())continue;
              const headers=response.headers(),declared=Number(headers['content-length']||0);
              const mime=(headers['content-type']||'').split(';')[0].trim().toLowerCase();
              if((mime&&!['image/jpeg','image/png','image/webp'].includes(mime))||declared>maxSlideBytes)continue;
              const bytes=await response.body(),hash=crypto.createHash('sha256').update(bytes).digest('hex');
              if(bytes.length>maxSlideBytes||totalSlideBytes+bytes.length>maxTotalSlideBytes){
                if(!sizeLimitNoted)report.notes.push('이미지 용량 제한으로 일부 슬라이드를 건너뛰었습니다.');
                sizeLimitNoted=true;
                continue;
              }
              if(seen.has(hash))continue;
              seen.add(hash);count++;totalSlideBytes+=bytes.length;
              const name='link-slide-'+String(count).padStart(2,'0')+'.jpg';
              await fs.writeFile(path.join(folder,name),bytes);
              report.media_files.push(name);
            }catch{report.notes.push('이미지 일부를 가져오지 못했습니다.');}
          }
          const next=page.getByRole('button',{name:/^(Next|다음)$/i});
          if(await next.count()!==1||!await next.isVisible())break;
          const prior=(snapshot.images||[]).map(x=>x.src).join('|');
          await next.click({force:true,timeout:8000}).catch(()=>{});
          await page.waitForFunction(previous=>[...document.querySelectorAll('main img')].filter(e=>e.width>=200).map(e=>e.currentSrc||e.src).join('|')!==previous,prior,{timeout:5000}).catch(()=>{});
          await page.waitForTimeout(700);
        }
      }
      if(!report.media_files.length)report.notes.push('사진·영상 원본을 확보하지 못했습니다.');
    }
  }
}catch(error){report.notes.push(String(error.message).split('\n')[0].slice(0,200));}
finally{
  if(slideBackup){
    const fresh=report.media_files.filter(name=>/^link-slide-\d+\.jpg$/i.test(name));
    if(fresh.length<previousSlides.length&&!report.media_files.some(name=>/\.(mp4|mov|webm)$/i.test(name))){
      for(const name of fresh)await fs.unlink(path.join(folder,name)).catch(()=>{});
      for(const name of previousSlides)await fs.copyFile(path.join(slideBackup,name),path.join(folder,name));
      report.media_files=previousSlides;
      report.notes.push('이번 수집에서 캐러셀 일부만 보여 이전에 확보한 같은 게시물 이미지를 사용합니다.');
    }
    await fs.rm(slideBackup,{recursive:true,force:true});
  }
  await collector.close();process.stdout.write(JSON.stringify(report));
}

import fs from 'node:fs/promises';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import {canonicalPost,readPublicDocument,normalizeSnapshot} from './extract.mjs';

export async function loadPlaywright(){
  try{return await import('playwright')}catch{throw new Error('Playwright가 없습니다. 프로그램 폴더에서 npm install을 실행해 주세요.');}
}

export class BrowserCollector {
  constructor(directory,{headless=false}={}){this.directory=directory;this.headless=headless;this.context=null;this.opening=null;}
  async open(){
    if(this.context)return this.context;
    if(this.opening)return this.opening;
    this.opening=(async()=>{
      await fs.mkdir(this.directory,{recursive:true,mode:0o700});
      const {chromium}=await loadPlaywright();
      this.context=await chromium.launchPersistentContext(path.join(this.directory,'browser-profile'),{...(process.env.PINMAP_BROWSER_CHANNEL==='bundled'?{}:{channel:'chrome'}),headless:this.headless,viewport:{width:1280,height:900},locale:'ko-KR',timezoneId:'Asia/Seoul'});
      this.context.on('close',()=>{this.context=null;});return this.context;
    })();
    try{return await this.opening}finally{this.opening=null}
  }
  async login(){const c=await this.open();const p=c.pages()[0]||await c.newPage();await p.goto('https://www.instagram.com/accounts/login/',{waitUntil:'domcontentloaded'});return {message:'열린 Chrome에서 직접 로그인한 뒤 수집을 시작하세요. 프로그램은 비밀번호를 입력하거나 읽지 않습니다.'};}
  async collect(item,{moreComments=false,evidenceDirectory}={}){
    const target=canonicalPost(item.url);const context=await this.open();const page=context.pages()[0]||await context.newPage();
    let response;
    try{
      response=await page.goto(target.url,{waitUntil:'domcontentloaded',timeout:35000});
      if(response?.status()===429)return this.failure(item,'rate_limited');
      if(response?.status()>=500)return this.failure(item,'server_error');
      await page.waitForFunction(()=>document.querySelector('time[datetime],main video')||/\/accounts\/login|\/challenge\/|\/checkpoint\//.test(location.pathname),{},{timeout:12000}).catch(()=>{});
      // Instagram sometimes covers an otherwise public post with a dismissible
      // signup promotion. Close only this recognized promotion, never a login,
      // security challenge, or terms-acceptance flow.
      const pageText=await page.locator('body').innerText();
      if(/게시물을 놓치지 마세요|Don't miss .*posts/i.test(pageText)){
        const close=page.getByRole('button',{name:/^(닫기|Close)$/i});
        if(await close.count()===1&&await close.isVisible())await close.click({timeout:4000});
      }
      await page.waitForFunction(()=>{
        const root=document.querySelector('main,[role="main"]');
        return root&&([...root.querySelectorAll('img')].some(e=>e.width>=200&&e.height>=100)||root.querySelector('video,button[aria-label="다음"],button[aria-label="Next"]'));
      },{},{timeout:5000}).catch(()=>{});
      if(moreComments){for(let i=0;i<2;i++){const button=page.getByRole('button',{name:/^(댓글 더 읽어들이기|댓글 더 보기|Load more comments)$/i});if(await button.count()!==1)break;const before=await page.locator('a[href*="/c/"]').count();await button.click({timeout:4000});await page.waitForFunction(n=>document.querySelectorAll('a[href*="/c/"]').length>n||/\/accounts\/login|\/challenge\//.test(location.pathname),before,{timeout:6000}).catch(()=>{});if(/\/accounts\/login|\/challenge\//.test(page.url()))break;}}
      const snapshot=await page.evaluate(readPublicDocument);const result=normalizeSnapshot(snapshot,item);
      result.http_status=response?.status()||null;
      if(evidenceDirectory){const stem=target.code+'_'+result.collected_at.replace(/[:.]/g,'-');await fs.mkdir(evidenceDirectory,{recursive:true,mode:0o700});await fs.writeFile(path.join(evidenceDirectory,stem+'.json'),JSON.stringify(snapshot,null,2),{mode:0o600});await page.screenshot({path:path.join(evidenceDirectory,stem+'.png'),fullPage:false});result.artifacts={snapshot:stem+'.json',screenshot:stem+'.png'};}
      return result;
    }catch(error){return {...this.failure(item,'navigation_failed'),error:String(error.message).replace(/\n[\s\S]*/,'').slice(0,240)};}
  }
  failure(item,status){return{item_id:item.id||item.item_id||null,url:canonicalPost(item.url).url,collected_at:new Date().toISOString(),method:'browser',status,fields:{},evidence:{},missing:{},comments:[],comments_coverage:'not_collected'};}
  async close(){await this.context?.close();this.context=null;}
}

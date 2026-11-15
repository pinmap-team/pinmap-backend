export function canonicalPost(value) {
  const u = new URL(value);
  if (!['https:'].includes(u.protocol) || !['instagram.com','www.instagram.com'].includes(u.hostname) || u.username || u.password) throw new Error('Instagram 게시물 링크를 입력해 주세요.');
  const match = u.pathname.match(/^\/(?:[A-Za-z0-9._]+\/)?(p|reel|tv)\/([A-Za-z0-9_-]+)\/?$/);
  if (!match) throw new Error('게시물 또는 릴스 링크만 사용할 수 있습니다.');
  return { url:`https://www.instagram.com/${match[1]}/${match[2]}/`, kind:match[1], code:match[2] };
}

export function parseCount(text) {
  if (typeof text !== 'string') return null;
  const m = text.trim().replace(/,/g,'').match(/^(\d+(?:\.\d+)?)\s*(천|만|억|k|m|b)?$/i);
  if (!m) return null;
  const multiplier = {천:1000,만:10000,억:100000000,k:1000,m:1000000,b:1000000000}[m[2]?.toLowerCase()] || 1;
  return {value:Number(m[1])*multiplier,approximate:!!m[2],display:text.trim()};
}

// This function is serialized into the browser. It reads the displayed document and
// standard page metadata only; it does not read cookies or private network APIs.
export function readPublicDocument() {
  const root = document.querySelector('main,[role="main"]') || document.body;
  const authorLink = [...root.querySelectorAll('article header a[href],main header a[href]')]
    .find(a => /^\/[A-Za-z0-9._]+\/?$/.test(a.getAttribute('href') || ''));
  const authorHeader = authorLink?.closest('header');
  const authorImage = authorLink?.querySelector('img') || authorHeader?.querySelector('img');
  const code = location.pathname.match(/\/(?:p|reel|tv)\/([^/]+)/)?.[1];
  const visible = e => !!(e.getClientRects().length && getComputedStyle(e).visibility !== 'hidden');
  const meta = Object.fromEntries([...document.querySelectorAll('meta[property],meta[name]')].map(e=>[e.getAttribute('property')||e.getAttribute('name'),e.getAttribute('content')||'']));
  const times = [...root.querySelectorAll('time[datetime]')].map(e=>({datetime:e.getAttribute('datetime'),text:e.textContent,href:e.closest('a')?.getAttribute('href')||''}));
  const buttons = [...root.querySelectorAll('button,[role="button"]')].filter(visible);
  const controls = [...root.querySelectorAll('svg[aria-label]')].map(svg=>{
    const b = svg.closest('button,[role="button"]');
    if (!b || !visible(b)) return null;
    let neighbor = '';
    for (let e=b,i=0;e && i<3;e=e.parentElement,i++) {
      const next=e.nextElementSibling;
      const value=next?.textContent?.trim()||'';
      if (/^[\d.,]+\s*[KMBkmb천만억]?$/.test(value)) {neighbor=value;break;}
      if (e.parentElement?.querySelectorAll('svg[aria-label]').length>1) break;
    }
    return {label:svg.getAttribute('aria-label'),neighbor};
  }).filter(Boolean);
  const images=[...root.querySelectorAll('img')].filter(e=>{
    if (!visible(e) || /프로필|profile (?:picture|photo)/i.test(e.alt)) return false;
    if (!/Photo (?:by|shared by)|Video by|사진|동영상/i.test(e.alt) && !(e.width>=200&&e.height>=100)) return false;
    const href=e.closest('a')?.getAttribute('href')||'';
    const other=href.match(/\/(?:p|reel|tv)\/([^/]+)/)?.[1];
    return !other || other===code;
  }).map(e=>({alt:e.alt,src:e.currentSrc||e.src}));
  const comments=[]; const seen=new Set();
  for (const a of root.querySelectorAll('a[href*="/c/"]')) {
    const href=a.getAttribute('href')||'';
    const m=href.match(/\/(?:p|reel)\/([^/]+)\/c\/(\d+)/);
    if (!m || m[1]!==code || seen.has(m[2]) || !visible(a)) continue;
    let block=a;
    for(let i=0;i<8 && block.parentElement;i++) {
      const parent=block.parentElement;
      const ids=new Set([...parent.querySelectorAll('a[href*="/c/"]')].map(x=>x.getAttribute('href')));
      if(ids.size>1) break;
      block=parent;
      const account=[...block.querySelectorAll('a[href]')].find(x=>/^\/[A-Za-z0-9._]+\/$/.test(x.getAttribute('href')||'') && x.textContent.trim());
      if(account && /Reply|답글 달기/.test(block.innerText)) break;
    }
    const account=[...block.querySelectorAll('a[href]')].find(x=>/^\/[A-Za-z0-9._]+\/$/.test(x.getAttribute('href')||'') && x.textContent.trim());
    seen.add(m[2]);
    comments.push({comment_id:m[2],url:new URL(href,location.origin).href,username:account?.getAttribute('href')?.split('/')[1]||null,published_at:a.querySelector('time')?.getAttribute('datetime')||null,raw_text:block.innerText.trim().slice(0,16000)});
  }
  const jsonLd=[...document.querySelectorAll('script[type="application/ld+json"]')].map(e=>{try{return JSON.parse(e.textContent)}catch{return null}}).filter(Boolean);
  return {
    url:location.href,canonical:document.querySelector('link[rel="canonical"]')?.href||meta['og:url']||'',title:document.title,
    meta,times,controls,images,jsonLd,comments,
    author:{username:authorLink?.getAttribute('href')?.split('/')[1] || '',
            profile_image_url:authorImage?.currentSrc || authorImage?.src || ''},
    video:!![...root.querySelectorAll('video')].find(visible),
    carousel:buttons.some(e=>/^(Next|다음)$/i.test(e.getAttribute('aria-label')||e.querySelector('svg[aria-label]')?.getAttribute('aria-label')||e.innerText.trim())),
    page_text:root.innerText.slice(0,30000),
    more_comments:buttons.some(e=>/댓글 더 읽어들이기|댓글 더 보기|load more comments/i.test(e.innerText+' '+e.getAttribute('aria-label')))
  };
}

function walkLd(value, out=[]) {
  if (Array.isArray(value)) value.forEach(v=>walkLd(v,out));
  else if (value && typeof value==='object') {out.push(value);Object.values(value).forEach(v=>walkLd(v,out));}
  return out;
}

export function normalizeSnapshot(snapshot, item, collectedAt=new Date().toISOString()) {
  const target=canonicalPost(item.url);
  const result={item_id:item.id||item.item_id||null,url:target.url,collected_at:collectedAt,method:'browser',status:'no_public_data',fields:{},comments:[],comments_coverage:'visible_only',missing:{},evidence:{}};
  const put=(key,value,source,detail={})=>{if(value!==null && value!==undefined && value!==''){result.fields[key]=value;result.evidence[key]={source,...detail};}};
  const text=snapshot.page_text||'';
  if (/\/challenge\/|\/checkpoint\//.test(snapshot.url) || /Confirm you're human|보안 확인|자동화된 행동|unusual activity|잠시 후 다시 시도/i.test(text)) {result.status='verification_required';return result;}
  if (/연령 제한 콘텐츠|Age-restricted content/i.test(text)) {result.status='age_restricted';return result;}
  let observed;
  try{observed=canonicalPost(snapshot.canonical||snapshot.url)}catch{result.status=/\/accounts\/login/.test(snapshot.url)?'login_required':'unavailable';return result;}
  if(observed.code!==target.code){result.status='wrong_page';return result;}
  const meta=snapshot.meta||{};
  const desc=meta['og:description']||meta.description||'';
  const prefix=desc.match(/^\s*([\d.,]+\s*[KMBkmb천만억]?)\s+likes?,\s*([\d.,]+\s*[KMBkmb천만억]?)\s+comments?\s*-\s*([A-Za-z0-9._]+)/i);
  if(prefix){for(const[key,value]of[['like_count',prefix[1]],['comment_count',prefix[2]]]){const c=parseCount(value);if(c)put(key,c.value,'meta:og:description',{approximate:c.approximate,display:c.display});}put('author_username',prefix[3],'meta:og:description');}
  const labels={like_count:/^(Like|Unlike|좋아요|좋아요 취소)$/i,comment_count:/^(Comment|댓글 달기)$/i,shares_count:/^(Share|공유하기)$/i,saves_count:/^(Save|저장)$/i};
  for(const[key,re]of Object.entries(labels)) if(!(key in result.fields)){
    const control=(snapshot.controls||[]).find(x=>re.test(x.label)&&parseCount(x.neighbor));
    if(control){const c=parseCount(control.neighbor);put(key,c.value,'visible_metric_control',{label:control.label,display:c.display,approximate:c.approximate});}
  }
  const times=(snapshot.times||[]).filter(x=>!x.href?.includes('/c/'));
  const time=times.find(x=>{try{return x.href && canonicalPost(new URL(x.href,'https://www.instagram.com').href).code===target.code}catch{return false}})||times.find(x=>!x.href);
  if(time && !isNaN(Date.parse(time.datetime)))put('published_at',new Date(time.datetime).toISOString(),'time[datetime]',{href:time.href,display:time.text,precision:'timestamp'});
  if(!result.fields.published_at){const date=desc.match(/-\s*[A-Za-z0-9._]+\s*-\s*([A-Za-z]+\s+\d{1,2},\s+\d{4}):/);if(date&&!isNaN(Date.parse(date[1])))put('published_date',new Date(date[1]+' 00:00:00 GMT').toISOString().slice(0,10),'meta:og:description',{precision:'date_only'});}
  const ld=walkLd(snapshot.jsonLd||[]).filter(x=>['ImageObject','VideoObject','SocialMediaPosting'].includes(x['@type']) && (!x.url || String(x.url).includes(target.code)));
  if(!result.fields.published_at){const d=ld.find(x=>x.datePublished||x.uploadDate);const value=d?.datePublished||d?.uploadDate;if(value&&!isNaN(Date.parse(value)))put('published_at',new Date(value).toISOString(),'json-ld',{precision:'timestamp'});}
  const hasMedia=(snapshot.images||[]).length>0||snapshot.video||ld.length>0;
  if(hasMedia){const format=snapshot.carousel?'carousel':target.kind==='reel'?'reel':snapshot.video?'video':'image';put('media_format',format,'visible_media',{visible_media_count:snapshot.images?.length||0,total_media_count:null});}
  else if(target.kind==='reel' && (prefix||result.fields.published_at))put('media_format','reel','canonical_url',{note:'게시물 메타데이터와 일치하는 /reel/ 경로. 영상 내용은 분석하지 않음.'});
  if(meta['og:image']&&hasMedia)put('thumbnail_url',meta['og:image'],'meta:og:image',{may_expire:true});
  result.comments=(snapshot.comments||[]).filter(c=>c.url?.includes('/'+target.code+'/c/'));
  const allKnown=typeof result.fields.comment_count==='number' && !result.evidence.comment_count?.approximate && !snapshot.more_comments && result.comments.length>=result.fields.comment_count;
  result.comments_coverage=allKnown?'all_reported_comments_visible':'visible_only';
  for(const key of ['published_at','media_format','like_count','comment_count','shares_count','saves_count','sends_count'])if(!(key in result.fields))result.missing[key]=key==='sends_count'?'DM 보내기 수는 공개 공유 수와 같은 값으로 간주하지 않음':'현재 공개 화면에서 확인되지 않음';
  result.status=Object.keys(result.fields).length?'collected':/로그인|Log in/i.test(text)?'login_required':'no_public_data';
  return result;
}

export function mergeObservations(api, browser) {
  const out=structuredClone(api);
  for(const[key,value]of Object.entries(browser.fields||{})) if(!(key in out.fields)){out.fields[key]=value;out.evidence[key]=browser.evidence[key];delete out.missing[key];}
  out.browser_status=browser.status;out.browser_collected_at=browser.collected_at;
  if(!out.comments?.length){out.comments=browser.comments;out.comments_coverage=browser.comments_coverage;}
  out.method='api+browser';return out;
}

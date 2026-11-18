const normalized=value=>String(value||'').normalize('NFKC').toLocaleLowerCase().replace(/[^\p{L}\p{N}]/gu,'');
const validPoint=p=>Number.isFinite(p?.lat)&&Number.isFinite(p?.lng)&&Math.abs(p.lat)<=90&&Math.abs(p.lng)<=180;
const distance=(a,b)=>{const r=Math.PI/180,h=Math.sin((a.lat-b.lat)*r/2)**2+Math.cos(a.lat*r)*Math.cos(b.lat*r)*Math.sin((a.lng-b.lng)*r/2)**2;return 12742000*Math.asin(Math.min(1,Math.sqrt(h)));};
const attributionUri=value=>{try{const u=new URL(value);return u.protocol==='https:'&&/(^|\.)google\.com$/.test(u.hostname)?u.href:null;}catch{return null;}};
export const validPlaceId=value=>typeof value==='string'&&/^[A-Za-z0-9_-]{8,256}$/.test(value);
function matches(place,location){const name=normalized(place.displayName?.text),target=normalized(location.name),p={lat:place.location?.latitude,lng:place.location?.longitude};return !!target&&(name===target||target.length>=3&&name.includes(target)&&name.length-target.length<=10)&&validPoint(p)&&distance(p,location.coordinates)<=150;}
export async function resolveGooglePlace(location,{key,fetcher=fetch,photos=false}={}){
  if(!key||!location?.name||!validPoint(location.coordinates))return null;
  const fields='places.id,places.displayName,'+(photos?'places.formattedAddress,':'')+'places.location'+(photos?',places.photos':'');
  const response=await fetcher('https://places.googleapis.com/v1/places:searchText',{
    method:'POST',headers:{'Content-Type':'application/json','X-Goog-Api-Key':key,'X-Goog-FieldMask':fields},
    body:JSON.stringify({textQuery:[location.name,location.address].filter(Boolean).join(' '),languageCode:'ko',pageSize:5}),signal:AbortSignal.timeout(8000)});
  if(!response.ok)throw new Error(response.status===429?'photo_rate_limited':'photo_provider_unavailable');
  const data=await response.json();
  return(data.places||[]).filter(p=>matches(p,location)).sort((a,b)=>distance({lat:a.location.latitude,lng:a.location.longitude},location.coordinates)-distance({lat:b.location.latitude,lng:b.location.longitude},location.coordinates))[0]||null;
}
export async function getGooglePlacePhoto(location,{key,fetcher=fetch}={}){
  if(!key||!location?.name||!validPoint(location.coordinates))return null;
  let candidate;
  if(validPlaceId(location.google_place_id)){
    const detail=await fetcher('https://places.googleapis.com/v1/places/'+encodeURIComponent(location.google_place_id)+'?languageCode=ko',{
      headers:{'X-Goog-Api-Key':key,'X-Goog-FieldMask':'id,displayName,location,photos,googleMapsUri'},signal:AbortSignal.timeout(8000)});
    if(!detail.ok)throw new Error('photo_provider_unavailable');
    const p=await detail.json();candidate=matches(p,location)?p:null;
  }else candidate=await resolveGooglePlace(location,{key,fetcher,photos:true});
  const photo=candidate?.photos?.[0];
  if(!candidate?.id||!/^places\/[^/]+\/photos\/[^/]+$/.test(photo?.name||''))return null;
  const mediaUrl=new URL(`https://places.googleapis.com/v1/${photo.name}/media`);
  mediaUrl.searchParams.set('maxWidthPx','600');mediaUrl.searchParams.set('skipHttpRedirect','true');
  const media=await fetcher(mediaUrl,{headers:{'X-Goog-Api-Key':key},signal:AbortSignal.timeout(8000)});
  if(!media.ok)throw new Error('photo_provider_unavailable');
  let uri;try{uri=new URL((await media.json()).photoUri);}catch{return null;}
  if(uri.protocol!=='https:'||!/^([\w-]+\.)*googleusercontent\.com$/.test(uri.hostname))return null;
  return{url:uri.href,place_id:candidate.id,google_maps_uri:attributionUri(photo.googleMapsUri||candidate.googleMapsUri)||'https://www.google.com/maps/search/?api=1&query='+encodeURIComponent(location.name)+'&query_place_id='+encodeURIComponent(candidate.id),attributions:(photo.authorAttributions||[]).filter(a=>typeof a.displayName==='string').slice(0,10).map(a=>({name:a.displayName.slice(0,160),uri:attributionUri(a.uri)}))};
}

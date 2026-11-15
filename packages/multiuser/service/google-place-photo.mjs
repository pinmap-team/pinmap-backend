const normalized=value=>String(value||'').normalize('NFKC').toLocaleLowerCase().replace(/[^\p{L}\p{N}]/gu,'');
const distance=(a,b)=>Math.hypot((a.lat-b.lat)*111000,(a.lng-b.lng)*88000);
const validPoint=point=>Number.isFinite(point?.lat)&&Number.isFinite(point?.lng);
const attributionUri=value=>{
  if(!value)return null;
  try{const uri=new URL(String(value||''),'https://maps.google.com');return uri.protocol==='https:'&&/(^|\.)google\.com$/.test(uri.hostname)?uri.toString():null;}
  catch{return null;}
};

export async function getGooglePlacePhoto(location,{key,fetcher=fetch}={}){
  if(!key||!location?.name||!validPoint(location.coordinates))return null;
  const response=await fetcher('https://places.googleapis.com/v1/places:searchText',{
    method:'POST',headers:{'Content-Type':'application/json','X-Goog-Api-Key':key,
      'X-Goog-FieldMask':'places.id,places.displayName,places.formattedAddress,places.location,places.photos'},
    body:JSON.stringify({textQuery:[location.name,location.address].filter(Boolean).join(' '),languageCode:'ko',pageSize:5}),
    signal:AbortSignal.timeout(15000)
  });
  if(!response.ok)return null;
  const data=await response.json();
  const target=normalized(location.name);
  const candidate=(data.places||[]).find(place=>{
    const name=normalized(place.displayName?.text),point={lat:place.location?.latitude,lng:place.location?.longitude};
    return (name===target||target.length>=3&&name.includes(target)&&name.length-target.length<=10)
      &&validPoint(point)&&distance(point,location.coordinates)<=150;
  });
  const photo=candidate?.photos?.[0];
  if(!candidate?.id||!/^places\/[^/]+\/photos\/[^/]+$/.test(photo?.name||''))return null;
  const mediaUrl=new URL(`https://places.googleapis.com/v1/${photo.name}/media`);
  mediaUrl.searchParams.set('maxWidthPx','600');mediaUrl.searchParams.set('skipHttpRedirect','true');
  const media=await fetcher(mediaUrl,{headers:{'X-Goog-Api-Key':key},signal:AbortSignal.timeout(15000)});
  if(!media.ok)return null;
  const photoUri=(await media.json()).photoUri;
  let uri;try{uri=new URL(photoUri);}catch{return null;}
  if(uri.protocol!=='https:'||!/^([\w-]+\.)*googleusercontent\.com$/.test(uri.hostname))return null;
  return{url:uri.toString(),place_id:candidate.id,attributions:(photo.authorAttributions||[])
    .filter(item=>typeof item.displayName==='string').slice(0,3)
    .map(item=>({name:item.displayName,uri:attributionUri(item.uri)}))};
}

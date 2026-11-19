// Server-token-only maintenance route. It persists place IDs, never Google photo URLs or bytes.
const {timingSafeEqual}=require('node:crypto');
const store=require('../lib/saved-photo-store');
const {getKey}=require('../config/keys.cjs');
function authorized(header,token){if(typeof token!=='string'||token.length<20)return false;const a=Buffer.from(String(header||'')),b=Buffer.from('Bearer '+token);return a.length===b.length&&timingSafeEqual(a,b);}
module.exports=async(req,res)=>{
 res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');
 if(req.method!=='POST')return res.status(405).json({error:'method_not_allowed'});
 if(!authorized(req.headers.authorization,getKey('PINMAP_EXTRACTOR_TOKEN')))return res.status(401).json({error:'unauthorized'});
 let body;try{body=typeof req.body==='string'?JSON.parse(req.body):req.body;}catch{}
 const offset=body?.offset??0,start=body?.location_offset??0;
 if(!Number.isInteger(offset)||offset<0||offset>10000||!Number.isInteger(start)||start<0||start>=40)return res.status(400).json({error:'invalid_request'});
 const c=store.config(),key=getKey('GOOGLE_MAPS_SERVER_KEY');if(!c||!key)return res.status(503).json({error:'not_configured'});
 try{
  const row=await store.read(c,{offset});if(!row)return res.status(200).json({done:true,checked:0,matched:0,missing:0});
  const locations=Array.isArray(row.map_locations)?row.map_locations:[],end=Math.min(start+6,locations.length),stats={checked:0,matched:0,missing:0,skipped:0};
  const {resolveGooglePlace,validPlaceId}=await import('../lib/google-place-photo.mjs');
  let changed=false;
  for(let i=start;i<end;i++){
   const loc=locations[i];if(loc.image_data_url||validPlaceId(loc.google_place_id)){stats.skipped++;continue;}
   stats.checked++;
   // A provider outage fails the batch rather than marking the place as absent.
   const place=await resolveGooglePlace(loc,{key});
   if(place&&validPlaceId(place.id)){locations[i]={...loc,google_place_id:place.id};stats.matched++;changed=true;}else stats.missing++;
  }
  const updated=!changed||await store.update(c,row,locations);
  return res.status(200).json({...stats,updated,done:false,next:updated?(end>=locations.length?{offset:offset+1,location_offset:0}:{offset,location_offset:end}):{offset,location_offset:start}});
 }catch{return res.status(503).json({error:'backfill_unavailable'});}
};
module.exports.authorized=authorized;

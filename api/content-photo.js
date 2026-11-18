const {supabaseConfig,bearerToken,authenticatedUser}=require('./content-extract');
const store=require('../lib/saved-photo-store');
const UUID=/^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/i;
module.exports=async(req,res)=>{
 res.setHeader('Cache-Control','private, no-store');res.setHeader('Vary','Authorization');res.setHeader('X-Content-Type-Options','nosniff');
 if(req.method!=='POST'){res.setHeader('Allow','POST');return res.status(405).json({error:'method_not_allowed'});}
 let body;try{body=typeof req.body==='string'?JSON.parse(req.body):req.body;}catch{}
 if(!UUID.test(body?.content_id||'')||!Number.isInteger(body?.location_index)||body.location_index<0||body.location_index>=40)return res.status(400).json({error:'invalid_request'});
 const config=supabaseConfig(),storage=store.config(),key=process.env.GOOGLE_MAPS_SERVER_KEY;
 if(!config||!storage||!key)return res.status(503).json({error:'photo_not_configured'});
 const token=bearerToken(req.headers.authorization);if(!token)return res.status(401).json({error:'authentication_required'});
 const auth=await authenticatedUser(config,token);if(auth.status!==200)return res.status(auth.status).json({error:'authentication_required'});
 try{
  const row=await store.read(storage,{id:body.content_id,userId:auth.userId});
  if(!row||row.user_id!==auth.userId)return res.status(404).json({error:'not_found'});
  const loc=row.map_locations?.[body.location_index];if(!loc)return res.status(404).json({error:'not_found'});
  if(loc.image_data_url)return res.status(200).json({source:'post',url:loc.image_data_url,attributions:[]});
  const {getGooglePlacePhoto,validPlaceId}=await import('../lib/google-place-photo.mjs');
  const photo=await getGooglePlacePhoto(loc,{key});
  if(!photo)return res.status(404).json({error:'photo_not_found'});
  if(!loc.google_place_id&&validPlaceId(photo.place_id)){
    const locations=row.map_locations.map((v,i)=>i===body.location_index?{...v,google_place_id:photo.place_id}:v);
    await store.update(storage,row,locations).catch(()=>{});
  }
  return res.status(200).json({...photo,source:'google'});
 }catch{return res.status(503).json({error:'photo_unavailable'});}
};

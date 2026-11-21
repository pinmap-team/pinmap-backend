const {supabaseConfig}=require('../api/content-extract');
const {storageConfig}=require('../api/content-save');
function config(){const c=supabaseConfig();return c&&storageConfig(c);}
const headers=c=>({apikey:c.secret,Accept:'application/json'});
async function read(c,{id,userId,offset=0}={}){
 const u=new URL('/rest/v1/pinmap_saved_content',c.origin);u.searchParams.set('select',id?'id,user_id,map_locations,cover_data_url,updated_at':'id,user_id,map_locations,updated_at');u.searchParams.set('limit','1');
 if(id)u.searchParams.set('id','eq.'+id);if(userId)u.searchParams.set('user_id','eq.'+userId);
 if(!id){u.searchParams.set('order','id.asc');u.searchParams.set('offset',String(offset));}
 const r=await fetch(u,{headers:headers(c),signal:AbortSignal.timeout(10000)});if(!r.ok)throw Error('storage_unavailable');
 const rows=await r.json();if(!Array.isArray(rows)||rows.length>1)throw Error('storage_unavailable');return rows[0]||null;
}
async function update(c,row,locations){
 const u=new URL('/rest/v1/pinmap_saved_content',c.origin);u.searchParams.set('id','eq.'+row.id);u.searchParams.set('user_id','eq.'+row.user_id);u.searchParams.set('updated_at','eq.'+row.updated_at);
 const r=await fetch(u,{method:'PATCH',headers:{...headers(c),'Content-Type':'application/json',Prefer:'return=representation'},body:JSON.stringify({map_locations:locations}),signal:AbortSignal.timeout(10000)});
 if(!r.ok)throw Error('storage_unavailable');return(await r.json()).length===1;
}
module.exports={config,read,update};

// Paddle.js tokens and price IDs are public. API keys and webhook secrets stay on the server.
const B=require('../../lib/billing');
module.exports=(req,res)=>{
 res.setHeader('Cache-Control','no-store');res.setHeader('X-Content-Type-Options','nosniff');
 if(req.method!=='GET')return res.status(405).json({error:'method_not_allowed'});
 try{return res.status(200).json(B.publicConfig());}
 catch{return res.status(503).json({error:'billing_not_configured'});}
};

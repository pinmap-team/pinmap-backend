import {addressSpans} from './media-addresses.mjs';

// Match explicit address spans, not the beginning of a caption line.
// Keep the original line as evidence; never resolve a place name by guessing.
export function explicitCaptionAddresses(text){
 const found=new Map();
 for(const quote of String(text||'').split(/\r?\n/)){
  for(const value of addressSpans(quote)){
   if(!found.has(value))found.set(value,{field:'address',value,evidence_ids:['caption'],source:'caption',method:'explicit_caption',quote:quote.trim(),verified:false});
  }
 }
 return [...found.values()];
}

export const corsHeaders={"Access-Control-Allow-Origin":Deno.env.get("ALLOWED_ORIGINS")||"*","Access-Control-Allow-Headers":"authorization, x-client-info, apikey, content-type, x-cron-secret, x-webhook-secret","Access-Control-Allow-Methods":"GET,POST,OPTIONS","Content-Type":"application/json; charset=utf-8"};
export function json(data:unknown,status=200){return new Response(JSON.stringify(data),{status,headers:corsHeaders});}
export function preflight(req:Request){return req.method==="OPTIONS"?new Response("ok",{headers:corsHeaders}):null;}
export function bearer(req:Request){return(req.headers.get("authorization")||"").replace(/^Bearer\s+/i,"");}
export function constantTimeEqual(a:string,b:string){const x=new TextEncoder().encode(a),y=new TextEncoder().encode(b);if(x.length!==y.length)return false;let out=0;for(let i=0;i<x.length;i++)out|=x[i]^y[i];return out===0;}

'use strict';
const http=require('node:http');
const https=require('node:https');
const {Readable}=require('node:stream');

function responseHeaders(response){
  return {get(name){const value=response.headers[String(name).toLowerCase()];return value===undefined?null:Array.isArray(value)?value.join(', '):String(value)}};
}

// Game actions wait for the provider until cancellation or a connection error.
// A dedicated socket avoids the response deadlines in the shared fetch client.
// Connection tests may pass shared keep-alive agents ({http,https}) so repeated
// tests reuse idle sockets and TLS sessions, and a connectTimeoutMs that bounds
// each attempt until the response headers arrive.
function requestAgent(endpoint,{method='POST',headers={},body='',signal,timeoutMs=0,connectTimeoutMs=0,agent=false}){
  return new Promise((resolve,reject)=>{
    const url=new URL(endpoint);
    const secure=url.protocol==='https:';
    const transport=secure?https:http;
    let connectTimer=null;
    const request=transport.request(url,{
      method,headers:{...headers,'Content-Length':Buffer.byteLength(body)},
      agent:agent?(secure?agent.https:agent.http)||false:false,timeout:timeoutMs,signal
    },response=>{
      clearTimeout(connectTimer);
      if(response.statusCode>=300&&response.statusCode<400){response.resume();reject(Object.assign(Error('Agent endpoint redirected'),{code:'ERR_AGENT_REDIRECT'}));return;}
      response.setTimeout(timeoutMs);
      resolve({ok:response.statusCode>=200&&response.statusCode<300,status:response.statusCode,headers:responseHeaders(response),body:Readable.toWeb(response)});
    });
    if(connectTimeoutMs>0)connectTimer=setTimeout(()=>request.destroy(Object.assign(Error('Agent connect timed out'),{code:'ETIMEDOUT',connectTimeout:true})),connectTimeoutMs);
    request.setTimeout(timeoutMs,()=>request.destroy(Object.assign(Error('Agent request timed out'),{code:'ETIMEDOUT'})));
    request.on('socket',socket=>socket.setTimeout(timeoutMs));
    request.on('error',error=>{clearTimeout(connectTimer);reject(error)});
    request.end(body);
  });
}

// Idle sockets close before common provider idle limits; TLS sessions are cached
// so even a fresh socket can resume the handshake.
function createConnectionAgents({idleTimeoutMs=10000,maxSockets=4}={}){
  return {
    http:new http.Agent({keepAlive:true,maxSockets,timeout:idleTimeoutMs}),
    https:new https.Agent({keepAlive:true,maxSockets,timeout:idleTimeoutMs,maxCachedSessions:100})
  };
}

const retryableCodes=new Set(['EAI_AGAIN','ECONNRESET','ECONNREFUSED','ETIMEDOUT','ENETUNREACH','EHOSTUNREACH','EPIPE']);
function networkCode(error){return error?.code||error?.cause?.code}
function isRetryableNetworkError(error){return retryableCodes.has(networkCode(error))}
function waitForRetry(signal,delayMs){
  if(!delayMs)return Promise.resolve();
  return new Promise((resolve,reject)=>{
    const timer=setTimeout(done,delayMs);
    const abort=()=>{clearTimeout(timer);signal?.removeEventListener('abort',abort);reject(Object.assign(Error('Agent request cancelled'),{name:'AbortError',code:'ABORT_ERR'}))};
    function done(){signal?.removeEventListener('abort',abort);resolve()}
    if(signal?.aborted)abort();else signal?.addEventListener('abort',abort,{once:true});
  });
}
// A per-attempt connectTimeoutMs turns a stalled connect into a retryable ETIMEDOUT,
// so the retry gets its own window instead of sharing one deadline with the first try.
async function requestAgentWithRetry(endpoint,options={}){
  const retries=Number.isInteger(options.retries)&&options.retries>=0?options.retries:1;
  const retryDelayMs=Number.isFinite(options.retryDelayMs)&&options.retryDelayMs>=0?options.retryDelayMs:150;
  for(let attempt=0;;attempt++){
    try{return await requestAgent(endpoint,options)}catch(error){
      if(attempt>=retries||options.signal?.aborted||!isRetryableNetworkError(error)){
        if(error&&typeof error==='object')error.attempts=attempt+1;
        throw error;
      }
      await waitForRetry(options.signal,retryDelayMs);
    }
  }
}
module.exports={requestAgent,requestAgentWithRetry,createConnectionAgents,isRetryableNetworkError};
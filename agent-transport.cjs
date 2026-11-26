'use strict';
const http=require('node:http');
const https=require('node:https');
const {Readable}=require('node:stream');

// Game actions wait for the provider until cancellation or a connection error.
// A dedicated socket avoids the response deadlines in the shared fetch client.
function requestAgent(endpoint,{method='POST',headers,body,signal}){
  return new Promise((resolve,reject)=>{
    const url=new URL(endpoint);
    const transport=url.protocol==='https:'?https:http;
    const request=transport.request(url,{
      method,headers:{...headers,'Content-Length':Buffer.byteLength(body)},
      agent:false,timeout:0,signal
    },response=>{
      if(response.statusCode>=300&&response.statusCode<400){response.resume();reject(Error('Agent endpoint redirected'));return;}
      response.setTimeout(0);
      resolve({ok:response.statusCode>=200&&response.statusCode<300,status:response.statusCode,body:Readable.toWeb(response)});
    });
    request.setTimeout(0);
    request.on('socket',socket=>socket.setTimeout(0));
    request.on('error',reject);
    request.end(body);
  });
}
module.exports={requestAgent};

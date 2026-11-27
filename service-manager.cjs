'use strict';

const fs=require('node:fs');
const fsp=require('node:fs/promises');
const path=require('node:path');
const {spawn}=require('node:child_process');
const {cleanSystemLogs,createTimestampedWriter}=require('./system-logs.cjs');

const root=__dirname;
const runtime=process.env.NIGHTFALL_RUNTIME_DIR||path.join(root,'logs');
const pidFile=path.join(runtime,'game-service.pid');
const stopFile=path.join(runtime,'game-service.stop');
const lifecycleFile=path.join(runtime,'game-lifecycle.log');
const stdoutFile=path.join(runtime,'game.stdout.log');
const stderrFile=path.join(runtime,'game.stderr.log');
const delays=[1000,2000,5000,10000,30000,60000];
const STABLE_RUN_MS=60000;
// Restart delays grow on repeated crashes and reset once a server has stayed up for STABLE_RUN_MS.
function createRestartBackoff({steps=delays,stableMs=STABLE_RUN_MS,setTimer=setTimeout,clearTimer=clearTimeout}={}){
  let count=0,stableTimer=null;
  const clearStable=()=>{if(stableTimer!==null)clearTimer(stableTimer);stableTimer=null};
  return {
    get attempts(){return count},
    started(){clearStable();stableTimer=setTimer(()=>{count=0;stableTimer=null},stableMs);stableTimer?.unref?.()},
    exited(){clearStable()},
    next(){return steps[Math.min(count++,steps.length-1)]}
  };
}
const backoff=createRestartBackoff();
let server=null,stopping=false,timer=null,stopPoll=null,nextLogCleanupAt=0;

function stamp(){return new Date().toISOString()}
function append(file,text){fs.appendFileSync(file,text,{encoding:'utf8'})}
function log(event,details=''){append(lifecycleFile,stamp()+' '+event+(details?' '+details:'')+'\n')}
function pidAlive(pid){try{process.kill(pid,0);return true}catch{return false}}
function delay(){return backoff.next()}
function wait(ms){return new Promise(resolve=>{timer=setTimeout(resolve,ms)})}
function cleanupRuntimeLogs(){if(Date.now()<nextLogCleanupAt)return;cleanSystemLogs({directory:runtime});nextLogCleanupAt=Date.now()+60*60*1000;}

async function start(){
  await fsp.mkdir(runtime,{recursive:true});
  if(fs.existsSync(pidFile)){
    const old=Number(fs.readFileSync(pidFile,'utf8').trim());
    if(Number.isInteger(old)&&old!==process.pid&&pidAlive(old)){
      console.log('游戏服务管理器已经运行，地址：http://127.0.0.1:'+ (process.env.PORT||4173));return;
    }
  }
  try{fs.rmSync(stopFile,{force:true})}catch{}
  const child=spawn(process.execPath,[__filename,'run'],{cwd:root,detached:true,stdio:'ignore',windowsHide:true,env:{...process.env,NIGHTFALL_ROOT:root,NIGHTFALL_RUNTIME_DIR:runtime}});
  child.unref();
  console.log('游戏服务已在后台启动：http://127.0.0.1:'+ (process.env.PORT||4173));
  console.log('关闭此窗口不会停止游戏；停止时双击 stop-game.cmd。日志位于 logs 文件夹。');
}

function launchServer(){
  if(stopping)return;
  log('SERVER_START',`attempt=${backoff.attempts+1} port=${process.env.PORT||4173}`);
  server=spawn(process.execPath,[path.join(root,'server.cjs')],{cwd:root,stdio:['ignore','pipe','pipe'],windowsHide:true,env:process.env});
  const child=server;
  backoff.started();
  const stdoutWriter=createTimestampedWriter(stdoutFile,append);
  const stderrWriter=createTimestampedWriter(stderrFile,append);
  child.stdout.on('data',chunk=>stdoutWriter.write(chunk));
  child.stderr.on('data',chunk=>stderrWriter.write(chunk));
  child.once('error',error=>{log('SERVER_SPAWN_ERROR',JSON.stringify({message:error.message,code:error.code}));});
  child.once('exit',(code,signal)=>{
    backoff.exited();
    stdoutWriter.flush();stderrWriter.flush();
    const childPid=child.pid;server=null;
    log('SERVER_EXIT',`pid=${childPid||'unknown'} code=${code===null?'null':code} signal=${signal||'none'}`);
    if(stopping)return;
    const ms=delay();log('SERVER_RESTART_SCHEDULED',`delayMs=${ms}`);
    timer=setTimeout(launchServer,ms);
  });
}

async function run(){
  await fsp.mkdir(runtime,{recursive:true});
  cleanupRuntimeLogs();
  fs.writeFileSync(pidFile,String(process.pid),'utf8');
  log('MANAGER_START',`pid=${process.pid} node=${process.version}`);
  const shutdown=()=>stop();
  process.once('SIGINT',shutdown);process.once('SIGTERM',shutdown);
  process.on('uncaughtException',error=>{log('MANAGER_UNCAUGHT_EXCEPTION',error?.stack||String(error));void stop(1)});
  process.on('unhandledRejection',error=>{log('MANAGER_UNHANDLED_REJECTION',error?.stack||String(error));void stop(1)});
  stopPoll=setInterval(()=>{
    if(!fs.existsSync(stopFile)){cleanupRuntimeLogs();return}
    try{fs.rmSync(stopFile,{force:true})}catch{}
    void stop();
  },500);
  launchServer();
  await new Promise(resolve=>{run.finish=resolve});
}

async function stop(exitCode=0){
  if(stopping)return;stopping=true;clearTimeout(timer);clearInterval(stopPoll);log('MANAGER_STOP','requested');
  const child=server;server=null;
  if(child&&!child.killed){
    await new Promise(resolve=>{
      const timeout=setTimeout(()=>{try{child.kill('SIGKILL')}catch{}resolve()},5000);
      child.once('exit',()=>{clearTimeout(timeout);resolve()});
      try{child.kill('SIGTERM')}catch{clearTimeout(timeout);resolve()}
    });
  }
  try{const pid=Number(fs.readFileSync(pidFile,'utf8').trim());if(pid===process.pid)fs.rmSync(pidFile,{force:true})}catch{}
  log('MANAGER_STOPPED');run.finish?.();
}

async function requestStop(){
  await fsp.mkdir(runtime,{recursive:true});
  if(!fs.existsSync(pidFile)){console.log('未发现后台游戏服务。');return}
  const pid=Number(fs.readFileSync(pidFile,'utf8').trim());
  if(!Number.isInteger(pid)||!pidAlive(pid)){fs.rmSync(pidFile,{force:true});console.log('服务已停止，已清理失效记录。');return}
  fs.writeFileSync(stopFile,stamp(),'utf8');
  for(let i=0;i<40&&pidAlive(pid);i++)await new Promise(resolve=>setTimeout(resolve,250));
  if(pidAlive(pid))throw Error('服务管理器未能在 10 秒内停止，请检查 logs/game-lifecycle.log');
  console.log('游戏服务已停止。');
}

async function status(){
  if(!fs.existsSync(pidFile)){console.log('游戏服务未运行。');return}
  const pid=Number(fs.readFileSync(pidFile,'utf8').trim());console.log(pidAlive(pid)?`游戏服务后台运行中（管理进程 ${pid}），地址：http://127.0.0.1:${process.env.PORT||4173}`:'游戏服务未运行（PID 记录已失效）。');
}

if(require.main===module){
  const action=process.argv[2]||'start';
  if(action==='run')void run();
  else if(action==='start')void start().catch(error=>{console.error(error.message);process.exitCode=1});
  else if(action==='stop')void requestStop().catch(error=>{console.error(error.message);process.exitCode=1});
  else if(action==='status')void status().catch(error=>{console.error(error.message);process.exitCode=1});
  else{console.error('用法：node service-manager.cjs start|stop|status');process.exitCode=2}
}
module.exports={createRestartBackoff,STABLE_RUN_MS,delays};

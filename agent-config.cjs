'use strict';
const fs=require('node:fs/promises');
const path=require('node:path');
const os=require('node:os');
const {randomUUID}=require('node:crypto');
const {protectSecret}=require('./image-config.cjs');

const configPath=path.join(process.env.LOCALAPPDATA||path.join(os.homedir(),'AppData','Local'),'NightfallWerewolf','agent-profiles.json');
const MAX_BYTES=2*1024*1024;

class AgentConfigError extends Error{
  constructor(status,code,message){super(message);this.status=status;this.code=code;}
}

function serializedProfiles(value){
  if(!Array.isArray(value)||value.length!==12)throw new AgentConfigError(400,'INVALID_AGENT_CONFIG','Agent 配置需要包含 12 个席位。');
  let serialized;
  try{serialized=JSON.stringify(value)}catch{throw new AgentConfigError(400,'INVALID_AGENT_CONFIG','Agent 配置格式不正确。')}
  if(Buffer.byteLength(serialized,'utf8')>MAX_BYTES)throw new AgentConfigError(413,'AGENT_CONFIG_TOO_LARGE','Agent 配置文件过大，请缩小自定义头像后重试。');
  return serialized;
}

function encryptionFailure(){return new AgentConfigError(500,'AGENT_CONFIG_ENCRYPTION_FAILED','本机配置加密暂不可用，请重试；原有配置没有改变。')}

function createAgentConfigStore(file=configPath){
  async function readRecord(){
    try{
      const record=JSON.parse(await fs.readFile(file,'utf8'));
      if(record.version!==1||record.protection!=='windows-dpapi-current-user'||typeof record.encryptedProfiles!=='string'||!/^01000000[0-9a-f]+$/i.test(record.encryptedProfiles)||typeof record.savedAt!=='string')throw Error();
      return record;
    }catch(error){
      if(error.code==='ENOENT')return null;
      throw new AgentConfigError(500,'AGENT_CONFIG_READ_FAILED','本机 Agent 配置无法读取，请重新保存一次配置。');
    }
  }
  async function load(){
    const record=await readRecord();
    if(!record)return null;
    let profiles;
    try{profiles=JSON.parse(await protectSecret(record.encryptedProfiles,true))}catch{throw new AgentConfigError(500,'AGENT_CONFIG_READ_FAILED','本机 Agent 配置无法读取，请重新保存一次配置。')}
    serializedProfiles(profiles);
    return {profiles,savedAt:record.savedAt};
  }
  return {
    async status(){const loaded=await load();return {configured:!!loaded,savedAt:loaded?.savedAt||null,storage:'Windows 当前用户加密保存'}},
    async load(){return load()},
    async save(profiles,{clientSavedAt}={}){
      const serialized=serializedProfiles(profiles);
      const current=await readRecord();
      if(current&&typeof clientSavedAt==='string'){
        const requested=Date.parse(clientSavedAt),stored=Date.parse(current.savedAt);
        if(Number.isFinite(requested)&&Number.isFinite(stored)&&requested<=stored)throw new AgentConfigError(409,'AGENT_CONFIG_CONFLICT','本机已有更新的 Agent 配置，请重新打开页面后再保存。');
      }
      let encryptedProfiles;
      try{encryptedProfiles=await protectSecret(serialized)}catch{throw encryptionFailure()}
      const record={version:1,protection:'windows-dpapi-current-user',encryptedProfiles,savedAt:new Date().toISOString()};
      const temp=file+'.'+process.pid+'.'+randomUUID()+'.tmp';
      try{
        await fs.mkdir(path.dirname(file),{recursive:true});
        await fs.writeFile(temp,JSON.stringify(record),{flag:'wx',mode:0o600});
        await fs.rename(temp,file);
      }catch{throw new AgentConfigError(500,'AGENT_CONFIG_SAVE_FAILED','本机 Agent 配置保存失败，请检查当前 Windows 账户的文件权限后重试。')}
      finally{await fs.rm(temp,{force:true}).catch(()=>{})}
      return {savedAt:record.savedAt,storage:'Windows 当前用户加密保存'};
    }
  };
}

module.exports={AgentConfigError,createAgentConfigStore,configPath,MAX_BYTES};

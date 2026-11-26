'use strict';
const {test}=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');
const os=require('node:os');
const path=require('node:path');
const {RETENTION_MS,SYSTEM_LOGS,cleanSystemLogs,createTimestampedWriter}=require('./system-logs.cjs');

function tempDirectory(t){
  const directory=fs.mkdtempSync(path.join(os.tmpdir(),'nightfall-system-logs-'));
  t.after(()=>fs.rmSync(directory,{recursive:true,force:true}));
  return directory;
}

function timestamp(date){return new Date(date).toISOString()+' entry';}

test('系统日志按逐行时间戳保留72小时并仅处理指定文件',t=>{
  const directory=tempDirectory(t),now=Date.now();
  const old=timestamp(now-RETENTION_MS-1000),recent=timestamp(now-RETENTION_MS+1000);
  const file=path.join(directory,'game.stdout.log');
  fs.writeFileSync(file,[old,recent,''].join('\n'));
  const unrelated=path.join(directory,'automation-regression.log');
  fs.writeFileSync(unrelated,old+'\n');
  const cleaned=cleanSystemLogs({directory,now,files:[...SYSTEM_LOGS,'automation-regression.log']});
  assert.equal(cleaned.length,1);
  assert.equal(cleaned[0].removed,1);
  assert.equal(fs.readFileSync(file,'utf8'),recent+'\n');
  assert.equal(fs.readFileSync(unrelated,'utf8'),old+'\n');
});

test('没有逐行时间戳的旧系统日志按文件修改时间清理',t=>{
  const directory=tempDirectory(t),now=Date.now();
  const oldFile=path.join(directory,'game-lifecycle.log');
  fs.writeFileSync(oldFile,'old manager output\nwithout timestamps\n');
  const expired=new Date(now-RETENTION_MS-1000);
  fs.utimesSync(oldFile,expired,expired);
  const recentFile=path.join(directory,'game.stderr.log');
  fs.writeFileSync(recentFile,'recent legacy output\n');
  assert.deepEqual(cleanSystemLogs({directory,now}),[{file:oldFile,removed:2}]);
  assert.equal(fs.readFileSync(oldFile,'utf8'),'');
  assert.equal(fs.readFileSync(recentFile,'utf8'),'recent legacy output\n');
});

test('Agent 日志按每行时间清理，错误行按文件时间处理',t=>{
  const directory=tempDirectory(t),now=Date.now();
  const file=path.join(directory,'agent-requests.jsonl');
  const rows=[
    JSON.stringify({time:new Date(now-RETENTION_MS-500).toISOString(),event:'started'}),
    JSON.stringify({time:new Date(now-RETENTION_MS+500).toISOString(),event:'failed'}),
    '{broken row'
  ];
  fs.writeFileSync(file,rows.join('\n')+'\n');
  const fresh=new Date(now),old=new Date(now-RETENTION_MS-1000);
  fs.utimesSync(file,old,old);
  cleanSystemLogs({directory,now});
  assert.equal(fs.readFileSync(file,'utf8'),rows[1]+'\n');
  fs.appendFileSync(file,'another broken row\n');
  fs.utimesSync(file,fresh,fresh);
  cleanSystemLogs({directory,now});
  assert.equal(fs.readFileSync(file,'utf8'),rows[1]+'\nanother broken row\n');
});

test('服务管理器输出按行添加可清理时间戳',t=>{
  const appended=[];
  const writer=createTimestampedWriter('unused',(file,text)=>appended.push(text));
  writer.write('first line\npartial');
  writer.write(' end\r\n');
  writer.flush();
  assert.equal(appended.length,2);
  for(const line of appended){
    assert.match(line,/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z /);
    assert.ok(line.endsWith('\n'));
  }
  assert.match(appended[0],/first line/);
  assert.match(appended[1],/partial end/);
});

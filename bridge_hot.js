#!/usr/bin/env node
/**
 * CB Terminal Bridge —— 热更新版（不 patch、不重启 ptyHost）
 *
 * 原理：作为独立客户端连上 code-server 远程 IPC（WebSocket），
 * 复刻 VS Code 的握手 + PersistentProtocol 帧格式，直接调用
 * `remoteterminal` channel 的 API 读写原生终端。随开随停，零重启。
 *
 * 用法：/usr/lib/code-server/lib/node /workspace/cb-chat/bridge_hot.js [port]
 * 默认端口 7911。用 code-server 自带 node（有内置 WebSocket）。
 */
'use strict';
const http = require('node:http');
const fs = require('node:fs');

const CS_HOST = process.env.CB_CS_HOST || '127.0.0.1';
const CS_PORT = process.env.CB_CS_PORT || '8686';
const BRIDGE_PORT = Number(process.argv[2] || process.env.CB_PORT || 7911);
const WORKSPACE_ID = process.env.CB_WORKSPACE_ID || '4cce8db9';
const COMMIT = process.env.CB_COMMIT || '59c988c744a240b05b039f57b856a5312f19d5b1';

// ---------- VSBuffer serialize / deserialize (ipc.ts) ----------
const enc = new TextEncoder(), dec = new TextDecoder();
function vql(v){ if(v===0) return [0]; const o=[]; let x=v>>>0; while(x){ let b=x&0x7f; x>>>=7; if(x) b|=0x80; o.push(b);} return o; }
function rv(u8,p){ let r=0,s=0,b; do{ b=u8[p++]; r+=(b&0x7f)*Math.pow(2,s); s+=7; }while(b&0x80); return [r,p]; }
function ser(v){
  if(v===undefined) return [0];
  if(typeof v==='string'){ const z=[...enc.encode(v)]; return [1,...vql(z.length),...z]; }
  if(Array.isArray(v)){ const o=[4,...vql(v.length)]; for(const e of v) o.push(...ser(e)); return o; }
  if(typeof v==='number' && (v|0)===v) return [6,...vql(v)];
  const z=[...enc.encode(JSON.stringify(v))]; return [5,...vql(z.length),...z];
}
function de(u8,p){
  const t=u8[p++];
  if(t===0) return [undefined,p];
  if(t===1||t===2||t===3||t===5){ let n; [n,p]=rv(u8,p); const z=u8.slice(p,p+n); p+=n; return [t===5?JSON.parse(dec.decode(z)):dec.decode(z),p]; }
  if(t===4){ let n; [n,p]=rv(u8,p); const a=[]; let v; for(let i=0;i<n;i++){ [v,p]=de(u8,p); a.push(v); } return [a,p]; }
  if(t===6){ let n; [n,p]=rv(u8,p); return [n,p]; }
  return [null,p];
}

// ---------- PersistentProtocol 帧 (ipc.net.ts) ----------
// 13 字节头: TYPE(1) ID(4 u32be) ACK(4 u32be) LEN(4 u32be)
function frame(type,id,ack,payload){
  const b=new Uint8Array(13+payload.length), dv=new DataView(b.buffer);
  dv.setUint8(0,type); dv.setUint32(1,id); dv.setUint32(5,ack); dv.setUint32(9,payload.length);
  b.set(payload,13); return b;
}
function parseFrame(u8){
  if(u8.length<13) return null;
  const dv=new DataView(u8.buffer), type=u8[0], id=dv.getUint32(1), ack=dv.getUint32(5), len=dv.getUint32(9);
  if(13+len>u8.length) return null;
  return { type,id,ack,body:u8.slice(13,13+len) };
}

// ---------- 状态 ----------
let ws=null, connected=false, handshaked=false;
let outId=0, inAck=0;          // 帧序列号 / 已确认收到的服务端帧数
let rpcId=1;
const pending=new Map();       // rpcId -> {resolve,reject}
const eventSubs=new Map();     // rpcId(listen id) -> handler
const clients=new Map();       // terminalId -> Set<res>  (SSE 订阅)
const ptyHistory=new Map();    // terminalId -> string[]  累积的原始数据流（实时 onProcessData）

// 持久化到 /workspace（持久目录）：每个 chunk 追加写 JSONL，桥重启后回放恢复，历史不再丢。
const HIST_DIR='/workspace/cb-chat/history';
try{ fs.mkdirSync(HIST_DIR,{recursive:true}); }catch(e){}
function histFile(id){ return HIST_DIR+'/'+id+'.jsonl'; }
function appendHist(id, s){
  try{ fs.appendFileSync(histFile(id), JSON.stringify({t:Date.now(),d:s})+'\n'); }catch(e){}
}
function loadHist(id){
  try{
    const txt=fs.readFileSync(histFile(id),'utf-8');
    return txt.split('\n').filter(Boolean).map(l=>{try{return JSON.parse(l).d;}catch(e){return '';}}).filter(Boolean);
  }catch(e){ return []; }
}

function log(...a){ console.log('[cb-bridge]',...a); }

function rawSend(bytes){ if(ws&&ws.readyState===1) ws.send(bytes); }
function sendRegular(rpcIdVal, channel, method, arg, reqType){
  const payload=[...ser([reqType||100,rpcIdVal,channel,method]),...ser(arg)];
  rawSend(frame(1, ++outId, inAck, payload));
}
function call(channel,method,arg,timeout=15000){
  return new Promise((resolve,reject)=>{
    const id=rpcId++;
    pending.set(id,{resolve,reject});
    sendRegular(id,channel,method,arg);
    setTimeout(()=>{ if(pending.has(id)){ pending.delete(id); reject(new Error('RPC timeout: '+method)); } },timeout);
  });
}
function listenEvent(method,arg,handler){
  const id=rpcId++;
  eventSubs.set(id,handler);
  sendRegular(id,'remoteterminal',method,arg,102); // EventListen
  return id;
}

function onMessage(u8){
  const f=parseFrame(u8);
  if(!f) return;
  if(f.type===2){ // Control: 握手
    let msg; try{ msg=JSON.parse(dec.decode(f.body)); }catch(e){ return; }
    if(msg.type==='sign'){
      // 回 connectionType（auth=none 时不做签名校验）
      const r={ type:'connectionType', signedData:'', desiredConnectionType:1 };
      if(COMMIT) r.commit=COMMIT;
      const payload=[...ser(r)];
      rawSend(frame(2,0,0,enc.encode(JSON.stringify(r)))); // control 直接 JSON
      handshaked=true;
      log('handshake: sent connectionType');
      subscribeEvents();
    }
    return;
  }
  if(f.type===1){
    // 只确认 Regular 消息（PersistentProtocol ACK）
    if(f.id>inAck) inAck=f.id;
    const hr=de(f.body,0); const h=hr[0]; const pos=hr[1];
    if(!Array.isArray(h)) return;
    const type=h[0], id=h[1];
    // ResponseType: Initialize=200 PromiseSuccess=201 PromiseError=202 PromiseErrorObj=203 EventFire=204 (ipc.ts:66-72)
    if(type===201 || type===202 || type===204 || type===203){
      const data=de(f.body,pos)[0];
      if(type===204){ // EventFire —— 这才是事件推送（之前误判成 202=PromiseError 导致丢弃）
        const hdl=eventSubs.get(id);
        if(hdl) hdl(data);
        return;
      }
      const p=pending.get(id);
      if(p){ pending.delete(id); p.resolve(data); }
    }
  }
}

async function connect(){
  const url=`ws://${CS_HOST}:${CS_PORT}/stable-${COMMIT||'x'}?reconnectionToken=${crypto.randomUUID()}&reconnection=false&skipWebSocketFrames=false`;
  log('connecting', url);
  ws=new WebSocket(url);
  ws.binaryType='arraybuffer';
  ws.onopen=()=>{
    // auth（auth=none，auth 任意值）
    const auth={ type:'auth', auth:'00000000000000000000', data:crypto.randomUUID() };
    rawSend(frame(2,0,0,enc.encode(JSON.stringify(auth))));
    log('handshake: sent auth');
  };
  ws.onmessage=(ev)=>{
    let u8;
    if(ev.data instanceof ArrayBuffer) u8=new Uint8Array(ev.data);
    else if(typeof ev.data==='string') u8=enc.encode(ev.data);
    else return;
    onMessage(u8);
  };
  ws.onclose=()=>{ connected=false; log('ws closed; retry in 3s'); setTimeout(connect,3000); };
  ws.onerror=(e)=>{ log('ws error',String(e)); };
  // 等连接建立
  for(let i=0;i<40 && ws.readyState!==1;i++) await new Promise(r=>setTimeout(r,100));
  connected=ws.readyState===1;
  log('ws open; waiting handshake before subscribing');
}
async function subscribeEvents(){
  // 关键：PtyHostService 是懒连接的（ptyHostService.ts:53 __connection 首次才建立，
  // :176 proxy.onProcessData 事件转发依赖连接已建立）。必须先触发一次 RPC 建立连接，
  // 再订阅事件，否则事件通道是死的（实测订阅后无任何 EventFire）。
  var procs=[];
  try{ procs=await call('remoteterminal','$listProcesses',[],20000); }catch(e){ log('[init] listProcesses failed (retry)',String(e)); try{ procs=await call('remoteterminal','$listProcesses',[],20000); }catch(e2){ log('[init] listProcesses retry failed',String(e2)); } }
  // 立即订阅（最优先，不被初始化阻塞）——服务端唯一汇聚点 onProcessData
  listenEvent('$onProcessDataEvent', undefined, (ev)=>{
    if(!ev||ev.id==null) return;
    const raw=ev.event;
    const txt=(raw&&typeof raw==='object'&&raw.data!==undefined)?raw.data:raw;
    const s=String(txt==null?'':txt);
    if(!ptyHistory.has(ev.id)) ptyHistory.set(ev.id,[]);
    const arr=ptyHistory.get(ev.id); arr.push(s);
    appendHist(ev.id, s);                      // 持久化：桥重启不丢
    if(arr.length>20000) arr.shift();
    const set=clients.get(ev.id);
    if(set){ const payload='data: '+JSON.stringify({id:ev.id,data:s,t:Date.now()})+'\n\n'; set.forEach(r=>{try{r.write(payload);}catch(e){}}); }
  });
  log('subscribed onProcessData; ready');
  // 后台初始化：用 snapshot(replay) 作为历史起点（桥重启后恢复最近 scrollback），
  // 仅在该终端还没有实时数据时写入，避免覆盖已经累积的实时流。
  (async()=>{
    for(const p0 of (procs||[])){
      if(p0.pid===-1) continue;
      try{
        if((ptyHistory.get(p0.id)||[]).length) continue; // 已有实时数据，不覆盖
        const ser=await call('remoteterminal','$serializeTerminalState',[[p0.id]],8000);
        let d=ser; if(typeof d==='string') d=JSON.parse(d);
        const s0=(d.state&&d.state[0])||{};
        const ev=(s0.replayEvent&&s0.replayEvent.events)||[];
        const replay=ev.map(e=>e.data||'').join('');
        if(replay && !(ptyHistory.get(p0.id)||[]).length) ptyHistory.set(p0.id,[replay]);
      }catch(e){}
    }
    log('[init] snapshot baseline done');
  })();
}

// ---------- HTTP 服务 ----------
function sendJSON(res,code,obj){
  res.writeHead(code,{'Content-Type':'application/json; charset=utf-8','Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'*','Access-Control-Allow-Methods':'GET,POST,OPTIONS'});
  res.end(JSON.stringify(obj));
}
// ===== codebuddy 会话识别：terminal PID → 子进程 codebuddy → sessionId → 标题 =====
const CB_SESSION_DIR = '/root/.codebuddy/sessions';
const CB_PROJECT_DIR = '/root/.codebuddy/projects';
const titleCache = new Map();  // sessionId -> {title, t}
function codebuddyTitle(sessionId){
  if(!sessionId) return '';
  const now=Date.now();
  const hit=titleCache.get(sessionId);
  if(hit && now-hit.t<60000) return hit.title;
  // 找该 sessionId 的 jsonl（在 projects/*/ 下）
  let file='';
  try{
    for(const proj of fs.readdirSync(CB_PROJECT_DIR)){
      const p=CB_PROJECT_DIR+'/'+proj+'/'+sessionId+'.jsonl';
      if(fs.existsSync(p)){ file=p; break; }
    }
  }catch(e){}
  let title='', fallback='', bestTs=-1;
  if(file){
    try{
      // 流式扫全文：优先 ai-title / custom-title / topic（源码 i2 映射，取 timestamp 最新），
      // 没有则 fallback 第一条 user 的 input_text。
      const fd=fs.openSync(file,'r');
      const buf=Buffer.alloc(1<<20);
      let pos=0, carry='', bytes;
      while((bytes=fs.readSync(fd,buf,0,buf.length,pos))>0){
        pos+=bytes;
        carry+=buf.slice(0,bytes).toString('utf8');
        const lines=carry.split('\n');
        carry=lines.pop();
        for(const line of lines){
          if(!line.trim()) continue;
          let d; try{ d=JSON.parse(line); }catch(e){ continue; }
          const ts=d.timestamp||0;
          if(d.type==='ai-title' && typeof d.aiTitle==='string' && d.aiTitle.trim()){
            if(ts>=bestTs){ bestTs=ts; title=d.aiTitle.trim(); }
          }else if(d.type==='custom-title' && typeof d.customTitle==='string' && d.customTitle.trim()){
            if(ts>=bestTs){ bestTs=ts; title=d.customTitle.trim(); }
          }else if(d.type==='session-meta'){
            // 标题权威来源：session-meta.meta['codebuddy.ai/sessionTitle'] 内的 ai-title/custom-title
            var st=(d.meta&&d.meta['codebuddy.ai/sessionTitle'])||[];
            (Array.isArray(st)?st:[]).forEach(function(x){
              if(!x) return;
              var xts=x.timestamp||ts, t=x.aiTitle||x.customTitle||'';
              if(t && xts>=bestTs){ bestTs=xts; title=String(t).trim(); }
            });
          }else if(d.type==='topic' && typeof d.topic==='string' && d.topic.trim() && !fallback){
            fallback=d.topic.trim();
          }
          if(!fallback && d.type==='message' && d.role==='user'){
            const c=d.content||[];
            const ut=(Array.isArray(c)?c:[]).filter(x=>x&&x.type==='input_text').map(x=>x.text||'').join('').trim();
            // 跳过系统注入内容（<system-reminder>/<local-command-stdout>/CDATA 等 XML 标签），
            // 它不是用户真实输入，当标题会显示成乱码
            if(/^\s*<[a-zA-Z][\w-]*[\s>]/i.test(ut) || /^\s*<!\[CDATA\[/.test(ut)) continue;
            // 跳过寒暄（你好/啊/是的 等短消息），取第一条够长的实质消息作标题
            if(ut.length>10) fallback=ut;
          }
        }
      }
      fs.closeSync(fd);
    }catch(e){}
  }
  title=(title||fallback||'').replace(/\s+/g,' ').slice(0,60);
  titleCache.set(sessionId,{title,t:now});
  return title;
}
// PID -> sessionId（从 codebuddy 自己维护的 sessions/<pid>.json 读，只认 60s 内心跳）
function pidToSession(){
  const map=new Map();
  try{
    for(const f of fs.readdirSync(CB_SESSION_DIR)){
      if(!/\.json$/.test(f)) continue;
      try{
        const j=JSON.parse(fs.readFileSync(CB_SESSION_DIR+'/'+f,'utf8'));
        if(j.pid && j.sessionId && Date.now()-(j.lastHeartbeat||0)<60000) map.set(j.pid, j.sessionId);
      }catch(e){}
    }
  }catch(e){}
  return map;
}
// 找 pid 的子孙进程里 cmdline 含 codebuddy 的，返回 {pid, sessionId}
function findCodebuddy(shellPid, sessions){
  if(!shellPid || shellPid<1) return null;
  let children=[];
  try{
    children=(require('node:child_process').execSync('ps --ppid '+shellPid+' -o pid= 2>/dev/null',{encoding:'utf8'})
      .trim().split(/\s+/).map(Number).filter(Boolean));
  }catch(e){}
  for(const c of children){
    try{
      const cmd=fs.readFileSync('/proc/'+c+'/cmdline','utf8').replace(/\0/g,' ');
      if(/codebuddy/.test(cmd) && /node/.test(cmd)){
        const sid=sessions.get(c);
        return {pid:c, sessionId:sid||null};
      }
    }catch(e){}
    const deeper=findCodebuddy(c, sessions);
    if(deeper) return deeper;
  }
  return null;
}
async function enrichProcesses(){
  const data=await call('remoteterminal','$listProcesses',[]);
  const procs=(data||[]).map(x=>({id:x.id,pid:x.pid,title:x.title,cwd:x.cwd,workspaceId:x.workspaceId}));
  const sessions=pidToSession();
  const out={};
  for(const p of procs){
    const cb=findCodebuddy(p.pid, sessions);
    if(cb){
      const title=cb.sessionId?codebuddyTitle(cb.sessionId):'';
      // 空会话（jsonl 还没内容）不显示误导性的会话短 id，交给前端显示 "codebuddy · 新会话"
      out[p.id]={codebuddy:true, pid:cb.pid, sessionId:cb.sessionId, title:title};
    }
  }
  return out;
}
function serveStatic(res,path){
  // 版本前缀：/v2/59 → v2/web/（v2 用 v2 目录，其余主版本 web/）
  let base='/workspace/cb-chat/web';
  let vm=path.match(/^\/(v\d+)(\/|$)/);
  if(vm){ base=(vm[1]==='v1')?'/workspace/cb-chat/web':'/workspace/cb-chat/'+vm[1]+'/web'; path=path.slice(vm[1].length+1)||'/'; }
  if(path==='/chat'||path==='/chat/') path='/chat.html';
  if(path==='/editor'||path==='/editor/') path='/editor.html';
  let rel=(path==='/'||path==='')?'/index.html':path;
  let fp=base+rel;
  // SPA 回退：/59 这类终端路由，或缺失的页面，都回 index.html
  if(!fs.existsSync(fp) || fs.statSync(fp).isDirectory()) fp=base+'/index.html';
  try{
    const buf=fs.readFileSync(fp);
    const ct=fp.endsWith('.js')?'application/javascript; charset=utf-8'
      :fp.endsWith('.css')?'text/css; charset=utf-8'
      :fp.endsWith('.ttf')?'font/ttf'
      :fp.endsWith('.woff2')?'font/woff2'
      :fp.endsWith('.woff')?'font/woff'
      :fp.endsWith('.svg')?'image/svg+xml'
      :fp.endsWith('.png')?'image/png'
      :'text/html; charset=utf-8';
    res.writeHead(200,{'Content-Type':ct,'Cache-Control':'no-store'}); res.end(buf);
  }catch(e){ res.writeHead(404); res.end('not found'); }
}
const server=http.createServer(async (req,res)=>{
  const u=new URL(req.url,'http://x'), path=u.pathname;
  if(req.method==='OPTIONS'){res.writeHead(204,{'Access-Control-Allow-Origin':'*','Access-Control-Allow-Headers':'*','Access-Control-Allow-Methods':'GET,POST,OPTIONS'});return res.end();}
  if(path==='/cb/api/ping') return sendJSON(res,200,{ok:true,connected,t:Date.now()});
  // 代理 CodeBuddy Web UI 的 HTTP API（自动加鉴权头），供对话式页面复刻使用
  if(path.indexOf('/cb/api/webui/')===0){
    const sub=path.slice('/cb/api/webui/'.length);          // 如 sessions、jobs、sessions/<id>/history
    const qs=u.search||'';
    // base path 会随网关实例漂移（cnb-ofv-… / cnb-ase-…）；优先环境变量，其次 CNB_PIPELINE_ID，最后才用旧默认
    const rawBase=process.env.CODEBUDDY_GATEWAY_BASE_PATH||(process.env.CNB_PIPELINE_ID?('/'+process.env.CNB_PIPELINE_ID):'/cnb-ase-1k82cvklk-001');
    const base=rawBase.replace(/\/$/,'');
    const target='http://127.0.0.1:8688'+base+'/api/v1/'+sub+qs;
    try{
      // 支持 POST：读取请求体转发（发消息 reply / runs 等）
      let body;
      if(req.method==='POST'){
        body=await new Promise(function(r){ let b=''; req.on('data',c=>b+=c); req.on('end',()=>r(b)); });
      }
      const hr=await fetch(target,{
        method:req.method,
        headers:{'x-codebuddy-request':'1','content-type':'application/json'},
        body:body||undefined
      });
      const txt=await hr.text();
      res.writeHead(hr.status,{'Content-Type':'application/json; charset=utf-8','Access-Control-Allow-Origin':'*'});
      return res.end(txt);
    }catch(e){ return sendJSON(res,502,{error:String(e)}); }
  }
  // ===== 独立文件浏览器 API（不依赖 codebuddy web UI，直接用 Node fs 实现，对齐 E2B Filesystem.ListDir） =====
  // 路径安全：限制在 /workspace 内，阻止 .. 穿越
  function safePath(p){
    p=String(p||'/workspace');
    const root='/workspace';
    const real=require('node:path').resolve(p);
    if(real!==root && real.indexOf(root+'/')!==0) return null;
    return real;
  }
  if(path==='/cb/api/fs/list' && req.method==='POST'){
    let body=''; req.on('data',c=>body+=c);
    req.on('end',()=>{
      try{
        const o=JSON.parse(body||'{}');
        const rp=safePath(o.path||'/workspace');
        if(!rp) return sendJSON(res,403,{error:'forbidden path'});
        const st=fs.statSync(rp);
        if(!st.isDirectory()) return sendJSON(res,404,{error:'not a directory'});
        const entries=fs.readdirSync(rp,{withFileTypes:true}).map(function(d){
          const fp=rp+'/'+d.name;
          let s={}; try{ s=fs.statSync(fp); }catch(e){}
          return {name:d.name, type:d.isDirectory()?'directory':(d.isSymbolicLink()?'symlink':'file'),
            path:fp, size:s.size||0, mode:s.mode||0,
            permissions:s.mode?require('node:fs').constants && octalPerm(s.mode):'',
            modifiedTime:s.mtime?s.mtime.toISOString():null};
        });
        return sendJSON(res,200,{ok:true,entries:entries});
      }catch(e){ return sendJSON(res,500,{error:String(e)}); }
    });
    return;
  }
  function octalPerm(mode){ return (mode&0o777).toString(8).padStart(3,'0'); }
  if(path==='/cb/api/fs/read'){
    const rp=safePath(u.searchParams.get('path'));
    if(!rp) return sendJSON(res,403,{error:'forbidden path'});
    try{
      const st=fs.statSync(rp);
      if(!st.isFile()) return sendJSON(res,400,{error:'not a file'});
      const buf=fs.readFileSync(rp);
      const isBin=(st.size>2*1024*1024)||buf.slice(0,512).some(function(b){return b===0;});
      if(isBin) return sendJSON(res,200,{ok:true,binary:true,size:st.size,content:''});
      const content=buf.toString('utf8');
      return sendJSON(res,200,{ok:true,binary:false,content:content,lines:content.split('\n').length,size:st.size});
    }catch(e){ return sendJSON(res,500,{error:String(e)}); }
  }
  if(path==='/cb/api/fs/search'){
    // 简易递归模糊文件名搜索（深度限制 + 数量限制，避免扫全盘）
    const q=(u.searchParams.get('query')||'').toLowerCase();
    const limit=Math.min(Number(u.searchParams.get('limit'))||50,200);
    if(!q) return sendJSON(res,200,{ok:true,results:[]});
    const root=safePath(u.searchParams.get('cwd')||'/workspace')||'/workspace';
    const out=[];
    function walk(dir,depth){
      if(out.length>=limit||depth>6) return;
      let ents=[]; try{ ents=fs.readdirSync(dir,{withFileTypes:true}); }catch(e){ return; }
      for(const d of ents){
        if(out.length>=limit) break;
        const fp=dir+'/'+d.name;
        if(d.name.toLowerCase().indexOf(q)>=0) out.push({name:d.name,path:fp,type:d.isDirectory()?'directory':'file'});
        if(d.isDirectory() && d.name.charAt(0)!=='.') walk(fp,depth+1);
      }
    }
    walk(root,0);
    return sendJSON(res,200,{ok:true,results:out});
  }
  // 文件写操作（独立实现，对齐 E2B Filesystem）
  if(path.indexOf('/cb/api/fs/')===0 && req.method==='POST' &&
     ['/cb/api/fs/mkdir','/cb/api/fs/remove','/cb/api/fs/move','/cb/api/fs/write'].indexOf(path)>=0){
    let body=''; req.on('data',c=>body+=c);
    req.on('end',()=>{
      try{
        const o=JSON.parse(body||'{}');
        if(path==='/cb/api/fs/mkdir'){
          const rp=safePath(o.path); if(!rp) return sendJSON(res,403,{error:'forbidden'});
          fs.mkdirSync(rp,{recursive:true}); return sendJSON(res,200,{ok:true});
        }
        if(path==='/cb/api/fs/remove'){
          const rp=safePath(o.path); if(!rp) return sendJSON(res,403,{error:'forbidden'});
          if(rp==='/workspace') return sendJSON(res,403,{error:'cannot remove workspace root'});
          fs.rmSync(rp,{recursive:true,force:true}); return sendJSON(res,200,{ok:true});
        }
        if(path==='/cb/api/fs/move'){
          const a=safePath(o.source), b=safePath(o.destination);
          if(!a||!b) return sendJSON(res,403,{error:'forbidden'});
          fs.renameSync(a,b); return sendJSON(res,200,{ok:true});
        }
        if(path==='/cb/api/fs/write'){
          const rp=safePath(o.path); if(!rp) return sendJSON(res,403,{error:'forbidden'});
          fs.writeFileSync(rp,o.content==null?'':String(o.content),'utf8'); return sendJSON(res,200,{ok:true});
        }
      }catch(e){ return sendJSON(res,500,{error:String(e)}); }
    });
    return;
  }
  // 真实 git status（对齐 Web UI 源代码管理面板）
  // 运行中的 codebuddy agent（我的分身通讯录）
  if(path==='/cb/api/agents'){
    var arr=[];
    try{
      for(const f of fs.readdirSync(CB_SESSION_DIR)){
        if(!/\.json$/.test(f)) continue;
        try{
          var j=JSON.parse(fs.readFileSync(CB_SESSION_DIR+'/'+f,'utf8'));
          var age=Date.now()-(j.lastHeartbeat||0);
          if(age<120000){
            var title=codebuddyTitle(j.sessionId)||'';
            arr.push({pid:j.pid,sessionId:j.sessionId,kind:j.kind||'interactive',cwd:j.cwd||'',title:title,age:Math.round(age/1000)});
          }
        }catch(e){}
      }
    }catch(e){}
    return sendJSON(res,200,{ok:true,agents:arr});
  }
  // 文件内容全文搜索（对齐 Web UI ripgrep 搜索；用 grep -rn，限制大小/数量）
  if(path==='/cb/api/fs/grep'){
    const q=(u.searchParams.get('query')||'').trim();
    if(!q) return sendJSON(res,200,{ok:true,results:[]});
    const rp=safePath(u.searchParams.get('cwd')||'/workspace')||'/workspace';
    // 异步 exec：避免 grep 同步阻塞桥 event loop（会导致 iframe 其它请求挂起）
    const {exec}=require('node:child_process');
    const esc=q.replace(/[.*+?^${}()|[\]\\]/g,'\\$&');
    const cmd="grep -rn -m 2 --include='*.js' --include='*.ts' --include='*.py' --include='*.md' --include='*.json' --include='*.html' --include='*.css' --include='*.sh' --exclude-dir=node_modules --exclude-dir=.git --exclude-dir=history --exclude-dir=dist --exclude-dir=vscode-src --exclude-dir=models --exclude-dir=Qwen3.5-9B --exclude-dir=.cache -E '"+esc+"' '"+rp+"' 2>/dev/null | head -60";
    exec(cmd,{encoding:'utf8',timeout:6000,maxBuffer:1*1024*1024},function(err,out){
      if(err && !out) out='';
      const results=(out||'').split('\n').filter(Boolean).map(function(line){
        var i=line.indexOf(':'), j=line.indexOf(':',i+1);
        return {file:line.slice(0,i),line:parseInt(line.slice(i+1,j))||0,text:line.slice(j+1).trim().slice(0,200)};
      });
      try{ return sendJSON(res,200,{ok:true,results:results}); }catch(e){}
    });
    return;
  }
  if(path==='/cb/api/git/status'){
    try{
      const {execSync}=require('node:child_process');
      const out=execSync('git -C /workspace status --short 2>/dev/null',{encoding:'utf8',timeout:8000});
      const changes=out.split('\n').filter(Boolean).map(function(line){
        const code=line.slice(0,2), p=line.slice(3);
        return {status:code.trim()||'?', path:p};
      });
      return sendJSON(res,200,{ok:true,changes:changes,count:changes.length});
    }catch(e){ return sendJSON(res,200,{ok:true,changes:[],count:0,error:String(e)}); }
  }
  if(path==='/cb/api/history'){
    // 累积的实时原始数据流（完整历史）；前端用 TermBuffer 解析出 scrollback
    const id=Number(u.searchParams.get('id'));
    let arr=ptyHistory.get(id)||[];
    // 内存为空时，先从 /workspace 磁盘回放（桥重启后历史不丢）
    if(!arr.length){ const disk=loadHist(id); if(disk.length){ arr=disk; ptyHistory.set(id,arr); } }
    // 若仍无数据（该终端无输出），动态用 snapshot replay 作基线，确保显示当前屏幕。
    if(!arr.length){
      try{
        const wid='4cce8db9';
        const layout=await call('remoteterminal','$getTerminalLayoutInfo',{workspaceId:wid},12000);
        let has=false; (layout&&layout.tabs||[]).forEach(t=>(t.terminals||[]).forEach(x=>{if((x.terminal||x).id===id)has=true;}));
        const ser=await call('remoteterminal','$serializeTerminalState',[[id]],12000);
        let d=ser; if(typeof d==='string')d=JSON.parse(d);
        const s0=(d.state&&d.state[0])||{};
        const ev=(s0.replayEvent&&s0.replayEvent.events)||[];
        const replay=ev.map(e=>e.data||'').join('');
        if(replay){ arr=[replay]; ptyHistory.set(id,arr); }
      }catch(e){}
    }
    return sendJSON(res,200,{ok:true,id,chunks:arr.length,data:arr.join('')});
  }
  // 静态资源 + 终端路由（/1 /v2/59 ...）：白名单扩展名、/数字、/vN/数字，回退 index.html
  if(path==='/'||path==='/chat'||path==='/editor'||/^\/\d+$/.test(path)||/^\/v\d+(\/\d*)?$/.test(path)||/\.(html|js|css|ttf|woff2?|svg|png|ico)$/.test(path)){
    if(path.indexOf('..')>=0) return sendJSON(res,403,{error:'forbidden'});
    return serveStatic(res,path);
  }
  if(path==='/cb/api/terminals'){
    // 复刻 VS Code web：终端列表 = getTerminalLayoutInfo(workspaceId)。
    // 遍历所有出现过的 workspaceId，合并各 workspace 的 layout（这才是 web 真正显示的终端，
    // 排除 listProcesses 里那些不在任何 layout 的历史/orphan 进程）。
    (async()=>{
      try{
        const procs=await call('remoteterminal','$listProcesses',[]);
        const wids=[...new Set((procs||[]).map(p=>p.workspaceId).filter(Boolean))];
        let all=[];
        for(const wid of wids){
          try{
            const layout=await call('remoteterminal','$getTerminalLayoutInfo',{workspaceId:wid});
            (layout&&layout.tabs||[]).forEach(tab=>(tab.terminals||[]).forEach(t=>{
              const x=t.terminal||t;
              if(x&&x.id!=null) all.push({id:x.id,title:x.title||'',pid:x.pid,workspaceId:wid,cwd:x.cwd});
            }));
          }catch(e){}
        }
        // 去重（同一 id 只留一个）
        const seen={}; all=all.filter(t=>{if(seen[t.id])return false;seen[t.id]=1;return true;});
        return sendJSON(res,200,{tabs:[{terminals:all}]});
      }catch(e){ return sendJSON(res,500,{error:String(e)}); }
    })();
    return;
  }
  if(path==='/cb/api/create' && req.method==='POST'){
    log('[create] request received');
    // 通过 $createProcess 在 code-server 真正新建终端（参数结构来自 remoteTerminalChannel.ts:21）
    var wid=u.searchParams.get('workspaceId')||'-391a2e43';
    var name=u.searchParams.get('name')||'';
    try{
      // 不写死 zsh/bash：从"当前活着的最近一个终端"读取真实 shell 配置作模板（code-server 自己解析的）
      var procs0=await call('remoteterminal','$listProcesses',[]);
      var alive=(procs0||[]).filter(function(p){return p.pid!==-1;});
      var tmpl=alive.filter(function(p){return /zsh|bash|\/sh$|shell/i.test(p.title||'');}).pop() || alive[alive.length-1];
      var tplId=tmpl?tmpl.id:null, sample={};
      if(tplId!=null){
        try{ var proto=await call('remoteterminal','$serializeTerminalState',[[tplId]]);
          var pd=proto; if(typeof pd==='string') pd=JSON.parse(pd);
          sample=(pd.state&&pd.state[0])||{};
        }catch(e){}
      }
      var slc=Object.assign({},sample.shellLaunchConfig||{});
      if(!slc.executable){
        try{ slc.executable=require('node:child_process').execSync('getent passwd $(id -u) | cut -d: -f7').toString().trim(); }catch(e){}
      }
      if(name) slc.name=name;
      // cmd 参数：用 shell -c 执行指定命令（如 codebuddy --resume <sid>）
      var cmd=u.searchParams.get('cmd');
      if(cmd){
        slc.args=['-c',cmd];
        if(!slc.executable) slc.executable='/bin/sh';
      }
      delete slc.reconnectionProperties;
      var plc=sample.processLaunchConfig||{};
      var opts=plc.options||{};
      // shellIntegration.nonce 必须存在（ptyHostMain:450 读它），缺失会报 reading 'nonce'
      if(!opts.shellIntegration) opts.shellIntegration={enabled:true,suggestEnabled:true};
      if(!opts.shellIntegration.nonce) opts.shellIntegration.nonce=require('node:crypto').randomUUID();
      slc.shellIntegrationNonce=opts.shellIntegration.nonce;
      log('[create] shell template from '+tplId+' -> '+(slc.executable||'?'));
      var config={
        'terminal.integrated.env.windows':{value:{},default:[]},
        'terminal.integrated.env.osx':{value:{},default:[]},
        'terminal.integrated.env.linux':{value:{},default:[]},
        'terminal.integrated.cwd':'',
        'terminal.integrated.detectLocale':'auto'
      };
      var wf={uri:{$mid:1,external:'vscode-remote://127.0.0.1:8686/workspace',path:'/workspace',scheme:'vscode-remote',authority:'127.0.0.1:8686'},name:'workspace',index:0};
      var args={
        configuration:config,
        resolvedVariables:{},
        envVariableCollections:[],
        shellLaunchConfig:slc,
        workspaceId:wid,
        workspaceName:'workspace',
        workspaceFolders:[wf],
        activeWorkspaceFolder:wf,
        activeFileResource:undefined,
        shouldPersistTerminal:true,
        options:opts,
        cols:120, rows:30,
        unicodeVersion:sample.unicodeVersion||'11',
        resolverEnv:plc.env||{}
      };
      log('[create] calling $createProcess');
      var res2=await call('remoteterminal','$createProcess',args,20000);
      log('[create] got result');
      var newId=res2&&res2.persistentTerminalId;
      // createProcess 只建 PTY 对象，必须再调 $start 才真正 spawn shell（remotePty.ts:27/37）
      if(newId){
        try{ var started=await call('remoteterminal','$start',[newId],20000); log('[create] start result',JSON.stringify(started).slice(0,200)); }
        catch(e){ log('[create] start failed',String(e)); }
      }
      // 同步 layout：读该 workspace 全部进程 id，构造 ById layout 写回（web 刷新才看得到）
      var layoutSynced=false;
      try{
        var procs2=await call('remoteterminal','$listProcesses',[]);
        var ids=(procs2||[]).filter(x=>x.workspaceId===wid).map(x=>x.id);
        if(newId&&ids.indexOf(newId)<0) ids.push(newId);
        var byId={ workspaceId:wid, tabs:[{ isActive:true, activePersistentProcessId:newId||ids[ids.length-1],
                    terminals:ids.map(function(id){return {relativeSize:0,terminal:id};}) }], background:[] };
        await call('remoteterminal','$setTerminalLayoutInfo',byId);
        layoutSynced=true;
      }catch(e){}
      return sendJSON(res,200,{ok:true,result:res2,newId:newId,layoutSynced:layoutSynced,layoutIds:ids});
    }catch(e){ return sendJSON(res,500,{error:String(e)}); }
  }
  if(path==='/cb/api/restartpty' && req.method==='POST'){
    // 平滑重启 ptyHost（$restartPtyHost），用于让新的 scrollback 配置生效；终端会 revive
    try{ await call('remoteterminal','$restartPtyHost',[],60000); return sendJSON(res,200,{ok:true}); }
    catch(e){ return sendJSON(res,500,{error:String(e)}); }
  }
  if(path==='/cb/api/cleanup' && req.method==='POST'){
    // 清理 pid=-1 的僵尸 PTY（create 后未 start 的残留）+ 重写干净 layout
    try{
      var procs=await call('remoteterminal','$listProcesses',[]);
      var zombies=(procs||[]).filter(p=>p.pid===-1).map(p=>p.id);
      for(const zid of zombies){ try{ await call('remoteterminal','$shutdown',[zid,true]); }catch(e){} }
      // 重写每个 workspace 的 layout，只保留仍存活的进程
      var wids=[...new Set((procs||[]).map(p=>p.workspaceId).filter(Boolean))];
      for(const wid of wids){
        var alive=(await call('remoteterminal','$listProcesses',[])).filter(p=>p.workspaceId===wid&&p.pid!==-1).map(p=>p.id);
        var lay={workspaceId:wid,tabs:[{isActive:true,activePersistentProcessId:alive[alive.length-1],terminals:alive.map(id=>({relativeSize:0,terminal:id}))}],background:[]};
        try{ await call('remoteterminal','$setTerminalLayoutInfo',lay); }catch(e){}
      }
      return sendJSON(res,200,{ok:true,removed:zombies,remainingAlive:wids.length});
    }catch(e){ return sendJSON(res,500,{error:String(e)}); }
  }
  if(path==='/cb/api/kill' && req.method==='POST'){
    var kid=Number(u.searchParams.get('id'));
    try{ await call('remoteterminal','$shutdown',[kid,false]); return sendJSON(res,200,{ok:true,id:kid}); }
    catch(e){ return sendJSON(res,500,{error:String(e)}); }
  }
  if(path==='/cb/api/layout'){
    // 按 workspaceId 查 VS Code 真正显示的终端布局（getTerminalLayoutInfo）
    var wid=u.searchParams.get('workspaceId')||'';
    try{
      const data=await call('remoteterminal','$getTerminalLayoutInfo',{workspaceId:wid});
      var out=[];
      (data&&data.tabs||[]).forEach(function(tab){ (tab.terminals||[]).forEach(function(t){
        var x=t.terminal||t; if(x&&x.id!=null) out.push({id:x.id,title:x.title,pid:x.pid,workspaceId:x.workspaceId,cwd:x.cwd});
      }); });
      return sendJSON(res,200,{workspaceId:wid,terminals:out,raw:data});
    }catch(e){ return sendJSON(res,500,{error:String(e)}); }
  }
  if(path==='/cb/api/processes'){
    // 列出 ptyHost 全部进程（不受 workspaceId 过滤）
    try{
      const data=await call('remoteterminal','$listProcesses',[]);
      const out=(data||[]).map(x=>({id:x.id,pid:x.pid,title:x.title,cwd:x.cwd,workspaceId:x.workspaceId,orphan:x.isOrphan}));
      return sendJSON(res,200,{processes:out});
    }catch(e){ return sendJSON(res,500,{error:String(e)}); }
  }
  if(path==='/cb/api/enrich'){
    try{ return sendJSON(res,200,{ok:true, map:await enrichProcesses()}); }
    catch(e){ return sendJSON(res,200,{ok:false, map:{}, error:String(e)}); }
  }
  if(path==='/cb/api/snapshot'){
    // 拉终端屏幕快照：调 $serializeTerminalState，解析 replayEvent.events[].data
    let ids;
    try{ ids=(u.searchParams.get('ids')||'').split(',').map(Number).filter(Boolean); }catch(e){ ids=[]; }
    if(!ids.length) ids=[Number(u.searchParams.get('id'))||11];
    try{
      const raw=await call('remoteterminal','$serializeTerminalState',[ids]);
      let d=raw; if(typeof d==='string') d=JSON.parse(d);
      const out={};
      for(const s of (d.state||[])){
        const ev=(s.replayEvent&&s.replayEvent.events)||[];
        const first=ev[0]||{};
        out[s.id]={ title:(s.processDetails&&s.processDetails.title)||'', data:ev.map(e=>e.data||'').join(''), cols:first.cols||80, rows:first.rows||24, raw:s };
      }
      return sendJSON(res,200,{ok:true,terminals:out});
    }catch(e){ return sendJSON(res,500,{error:String(e)}); }
  }
  if(path==='/cb/api/stream'){
    const id=Number(u.searchParams.get('id'));
    res.writeHead(200,{'Content-Type':'text/event-stream; charset=utf-8','Cache-Control':'no-cache, no-transform','Connection':'keep-alive','X-Accel-Buffering':'no','Access-Control-Allow-Origin':'*'});
    try{res.write(': connected id='+id+'\n\n');}catch(e){}
    if(!clients.has(id)) clients.set(id,new Set());
    clients.get(id).add(res);
    const hb=setInterval(()=>{try{res.write(': hb\n\n');}catch(e){}},15000);
    req.on('close',()=>{clearInterval(hb);const s=clients.get(id);if(s){s.delete(res);if(!s.size)clients.delete(id);}});
    return;
  }
  if(path==='/cb/api/input'&&req.method==='POST'){
    const id=Number(u.searchParams.get('id')); let body='';
    req.on('data',c=>body+=c);
    req.on('end',async()=>{ try{ await call('remoteterminal','$input',[id,body]); sendJSON(res,200,{ok:true,id}); }catch(e){sendJSON(res,500,{error:String(e)});} });
    return;
  }
  return sendJSON(res,404,{error:'not found'});
});

(async()=>{
  server.listen(BRIDGE_PORT,'0.0.0.0',()=>log('HTTP bridge on http://0.0.0.0:'+BRIDGE_PORT));
  await connect();
})().catch(e=>{console.error(e);process.exit(1)});

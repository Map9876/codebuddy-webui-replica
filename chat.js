/* CodeBuddy Web UI 1:1 复刻 —— 数据走桥的 /cb/api/webui 代理 */
(function(){
'use strict';
var API='';
var $ = function(id){ return document.getElementById(id); };
var sessions=[], currentId=null, pinnedIds={};

function api(path,method,body){
  return fetch(API+'/cb/api/webui/'+path,{
    method:method||'GET',cache:'no-store',
    headers:body?{'content-type':'application/json'}:undefined,
    body:body?JSON.stringify(body):undefined
  }).then(function(r){return r.json();});
}
var liveId=null;  // 当前活会话（可直接在里面回复）
function loadLive(){
  return api('sessions/live').then(function(j){ liveId=(j.data||{}).sessionId||null; }).catch(function(){});
}

// 相对时间：just now / 3m ago / 11h ago（对齐 Web UI）
function ago(ts){
  if(!ts) return '';
  var s=Math.floor((Date.now()-ts)/1000);
  if(s<60) return 'just now';
  if(s<3600) return Math.floor(s/60)+'m ago';
  if(s<86400) return Math.floor(s/3600)+'h ago';
  return Math.floor(s/86400)+'d ago';
}

// 去 HTML 标签取纯文本（TSV 复制用）
function stripHtml(h){ var d=document.createElement('div'); d.innerHTML=h; return d.textContent||''; }
// HTML 转义（mdToHtml 依赖）
function esc(s){ return String(s==null?'':s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
// 轻量 Mermaid flowchart 渲染（graph TD/BT/LR/RL + -->/---> 边），SVG 自绘避免拖入整个 Vite 应用
function mermaidToSvg(code){
  var lines=code.split('\n').map(function(l){return l.trim();}).filter(Boolean);
  if(!lines.length || !/^graph\s+(TD|BT|LR|RL)$/i.test(lines[0])) return null;
  var dir=lines[0].split(/\s+/)[1].toUpperCase();
  var nodes={}, edges=[];
  lines.slice(1).forEach(function(l){
    var m=l.match(/^(\w+)(?:\(([^)]*)\))?\s*(-->|--->|--)\s*(\w+)/);
    if(m){
      var a=m[1], b=m[4];
      if(m[2]) nodes[a]=m[2]; else if(!nodes[a]) nodes[a]=a;
      if(!nodes[b]) nodes[b]=b;
      edges.push([a,b]);
    }else{
      var n=l.match(/^(\w+)(?:\(([^)]*)\))?$/);
      if(n) nodes[n[1]]=n[2]||n[1];
    }
  });
  var ids=Object.keys(nodes); if(!ids.length) return null;
  // 简易布局：TD/BT 竖排，LR/RL 横排
  var horiz=(dir==='LR'||dir==='RL');
  var W=Math.max(400,ids.length*(horiz?150:120)+80), H=ids.length*(horiz?80:56)+60;
  var pos={};
  ids.forEach(function(id,i){
    pos[id]=horiz?{x:50+i*140,y:H/2}:{x:W/2,y:40+i*52};
  });
  if(dir==='BT'||dir==='RL') ids.forEach(function(id,i){
    pos[id]=horiz?{x:W-50-i*140,y:H/2}:{x:W/2,y:H-40-i*52};
  });
  var svg='<svg class="mermaid-svg" viewBox="0 0 '+W+' '+H+'" width="100%" style="max-height:400px">';
  // 箭头
  edges.forEach(function(e){
    var a=pos[e[0]],b=pos[e[1]]; if(!a||!b)return;
    svg+='<line x1="'+a.x+'" y1="'+a.y+'" x2="'+b.x+'" y2="'+b.y+'" stroke="#8b949e" stroke-width="1.5" marker-end="url(#arrow)"/>';
  });
  svg+='<defs><marker id="arrow" markerWidth="8" markerHeight="8" refX="7" refY="3" orient="auto"><path d="M0,0 L0,6 L7,3 z" fill="#8b949e"/></marker></defs>';
  // 节点
  ids.forEach(function(id){
    var p=pos[id], label=nodes[id]||id, w=Math.max(80,label.length*7+16);
    svg+='<rect x="'+(p.x-w/2)+'" y="'+(p.y-13)+'" width="'+w+'" height="26" rx="5" fill="#efeaff" stroke="#6c4dff"/>';
    svg+='<text x="'+p.x+'" y="'+(p.y+4)+'" text-anchor="middle" font-size="11" fill="#1f2329">'+esc(label)+'</text>';
  });
  svg+='</svg>';
  return svg;
}
// 轻量 Markdown 渲染（对齐真实 Web UI react-markdown：代码块/标题/列表/粗体/表格）
function mdToHtml(src){
  var lines=String(src||'').split('\n'), out=[], i=0;
  function inline(t){
    return esc(t)
      .replace(/`([^`]+)`/g,'<code>$1</code>')
      .replace(/\[([^\]]+)\]\(([^)\s]+)\)/g,function(m,text,url){
        // 只允许安全协议，拒绝 javascript:/data: 等（XSS 防护）；url/text 均已 esc
        if(!/^(https?:\/\/|mailto:|\/|#)/i.test(url)) return m;
        return '<a href="'+url+'" target="_blank" rel="noopener noreferrer">'+text+'</a>';
      })
      .replace(/\*\*([^*]+)\*\*/g,'<strong>$1</strong>')
      .replace(/\*([^*]+)\*/g,'<em>$1</em>');
  }
  while(i<lines.length){
    var l=lines[i];
    // 代码块 ```
    if(/^```/.test(l.trim())){
      var lang=l.trim().slice(3), code=[]; i++;
      while(i<lines.length && !/^```/.test(lines[i].trim())){ code.push(lines[i]); i++; }
      i++; // 跳过闭合
      if(/^mermaid$/i.test(lang)){
        var svg=mermaidToSvg(code.join('\n'));
        if(svg){ out.push('<div class="mermaid-block">'+svg+'</div>'); continue; }
      }
      out.push('<pre class="md-code"'+(lang?' data-lang="'+esc(lang)+'"':'')+'><code>'+esc(code.join('\n'))+'</code></pre>');
      continue;
    }
    // 标题
    var h=l.match(/^(#{1,6})\s+(.*)/);
    if(h){ var lv=h[1].length; out.push('<h'+lv+' class="md-h">'+inline(h[2])+'</h'+lv+'>'); i++; continue; }
    // 表格（| 开头，第二行是 ---）
    if(/^\|.*\|/.test(l) && i+1<lines.length && /^\|[\s:|-]+\|/.test(lines[i+1])){
      var rawLines=[l];
      var head=l.split('|').filter(function(x){return x.trim();}).map(inline);
      i+=2; var rows=[], rawRows=[];
      while(i<lines.length && /^\|.*\|/.test(lines[i])){ rawRows.push(lines[i]); rows.push(lines[i].split('|').filter(function(x){return x.trim();}).map(inline)); i++; }
      var mdText=[l, lines[i-1-rawRows.length]||'', rawRows.join('\n')].join('\n');  // 原始 markdown 表格
      var tsv=[head, rows].flat ? [head.map(stripHtml)].concat(rows.map(function(r){return r.map(stripHtml);})).map(function(r){return r.join('\t');}).join('\n') : '';
      out.push('<div class="md-table-wrap"><div class="md-table-actions">'+
        '<button class="markdown-table-action" data-copy="'+esc(mdText).replace(/"/g,'&quot;')+'" data-kind="md">复制为 Markdown</button>'+
        '<button class="markdown-table-action" data-copy="'+esc(tsv).replace(/"/g,'&quot;')+'" data-kind="tsv">复制为 TSV</button></div>'+
        '<table class="md-table"><thead><tr>'+head.map(function(c){return '<th>'+c+'</th>';}).join('')+'</tr></thead><tbody>'+
        rows.map(function(r){return '<tr>'+r.map(function(c){return '<td>'+c+'</td>';}).join('')+'</tr>';}).join('')+'</tbody></table></div>');
      continue;
    }
    // 列表
    if(/^\s*[-*]\s+/.test(l)){
      var items=[];
      while(i<lines.length && /^\s*[-*]\s+/.test(lines[i])){ items.push(inline(lines[i].replace(/^\s*[-*]\s+/,''))); i++; }
      out.push('<ul class="md-ul">'+items.map(function(x){return '<li>'+x+'</li>';}).join('')+'</ul>');
      continue;
    }
    if(!l.trim()){ out.push('<br>'); i++; continue; }
    out.push('<p class="md-p">'+inline(l)+'</p>'); i++;
  }
  return out.join('');
}
// 消息复制按钮（对齐真实 Web UI .message-copy-button，触屏常驻显示）
function addCopyBtn(bubble,text){
  var b=document.createElement('button');
  b.className='message-copy-button'; b.title='复制到剪贴板';
  b.innerHTML='<span class="codicon codicon-copy"></span>';
  b.onclick=function(ev){
    ev.stopPropagation();
    if(navigator.clipboard&&navigator.clipboard.writeText) navigator.clipboard.writeText(text||'').catch(function(){});
    else { var ta=document.createElement('textarea'); ta.value=text||''; document.body.appendChild(ta); ta.select(); try{document.execCommand('copy');}catch(e){} ta.remove(); }
    b.classList.add('copied'); setTimeout(function(){b.classList.remove('copied');},1200);
  };
  bubble.appendChild(b);
}

// 我的分身（通讯录）——用 agents + 默认 CodeBuddy
var liveAgents=[];
function renderAgents(){
  var box=$('agents-list'); if(!box) return;
  box.innerHTML='';
  // 真实运行中的 codebuddy agent + New Agent 入口
  var agents=liveAgents.map(function(a){ return {name:a.title||('会话 '+a.sessionId.slice(0,8)),sid:a.sessionId,red:false}; });
  agents.push({name:'New Agent',red:true});
  agents.forEach(function(a){
    var el=document.createElement('div'); el.className='agent';
    var av=document.createElement('div'); av.className='agent-avatar'+(a.red?' red':'');
    av.textContent=a.red?'+':'🐵';
    if(!a.red){ var dot=document.createElement('span'); dot.className='dot'; av.appendChild(dot); }
    var nm=document.createElement('div'); nm.className='agent-name'; nm.textContent=a.name;
    el.appendChild(av); el.appendChild(nm);
    el.addEventListener('click',function(){
      if(a.red) return;
      // 点分身 → 真实 codebuddy --resume <sid> 载入会话（按源码 resumeSessionAsJob）
      if(a.sid){
        var cmd='codebuddy --resume '+a.sid+' --dangerously-skip-permissions --permission-mode bypassPermissions';
        fetch(API+'/cb/api/create?name=resume&cmd='+encodeURIComponent(cmd),{method:'POST'})
          .then(function(r){return r.json();})
          .then(function(j){
            if(j.ok && (j.newId||j.result?.persistentTerminalId)){
              var id=j.newId||j.result.persistentTerminalId;
              location.href='/'+id;
            }else location.href='/3';
          }).catch(function(){ location.href='/3'; });
      }
      else location.href='/3';
    });
    box.appendChild(el);
  });
}
function loadAgents(){
  fetch(API+'/cb/api/agents',{cache:'no-store'}).then(function(r){return r.json();}).then(function(j){
    liveAgents=j.agents||[];
    renderAgents();
  }).catch(function(){});
}

// 会话列表
function renderSessions(filter){
  var box=$('sessions-list'); if(!box) return;
  var q=(filter||'').toLowerCase();
  var list=sessions.filter(function(s){ return !q || (s.name||'').toLowerCase().indexOf(q)>=0; });
  box.innerHTML='';
  if(!list.length){ box.innerHTML='<div class="sb-empty">无会话</div>'; return; }
  list.forEach(function(s){
    var el=document.createElement('div'); el.className='session'+(s.id===currentId?' active':'');
    var nm=document.createElement('div'); nm.className='session-name'; nm.textContent=s.name||'(无标题)';
    var tm=document.createElement('div'); tm.className='session-time'; tm.textContent=ago(s.updatedAt);
    var meta=document.createElement('div'); meta.className='session-meta';
    meta.textContent=(s.messageCount||0)+' 条消息';
    el.appendChild(nm); el.appendChild(tm); el.appendChild(meta);
    if(pinnedIds[s.id]){
      var pin=document.createElement('span'); pin.className='session-pin codicon codicon-pinned';
      el.appendChild(pin);
    }
    // 操作按钮（hover/长按显示，对齐真实 Web UI）
    var acts=document.createElement('span'); acts.className='session-acts';
    var bPin=document.createElement('button'); bPin.className='session-act'; bPin.title=pinnedIds[s.id]?'取消置顶':'置顶';
    bPin.innerHTML='<span class="codicon '+(pinnedIds[s.id]?'codicon-pinned':'codicon-pin')+'"></span>';
    bPin.onclick=function(ev){ ev.stopPropagation(); setPin(s.id,!pinnedIds[s.id]); };
    var bRen=document.createElement('button'); bRen.className='session-act'; bRen.title='重命名';
    bRen.innerHTML='<span class="codicon codicon-edit"></span>';
    bRen.onclick=function(ev){ ev.stopPropagation(); renameSession(s); };
    var bMore=document.createElement('button'); bMore.className='session-act'; bMore.title='更多操作';
    bMore.innerHTML='<span class="codicon codicon-ellipsis"></span>';
    bMore.onclick=function(ev){ ev.stopPropagation(); var r=el.getBoundingClientRect(); showSessionMenu(r.right-10,r.bottom,s); };
    acts.appendChild(bPin); acts.appendChild(bRen); acts.appendChild(bMore); el.appendChild(acts);
    el.addEventListener('click',function(){ openSession(s.id); });
    el.addEventListener('contextmenu',function(ev){ ev.preventDefault(); showSessionMenu(ev.clientX,ev.clientY,s); });
    box.appendChild(el);
  });
}

// 会话右键菜单（对齐真实 Web UI）
var menuSession=null;
function showSessionMenu(x,y,s){
  menuSession=s;
  var m=document.getElementById('session-menu'); if(!m) return;
  m.hidden=false;
  m.style.left=Math.min(x,innerWidth-190)+'px';
  m.style.top=Math.min(y,innerHeight-180)+'px';
}
document.addEventListener('click',function(){ var m=document.getElementById('session-menu'); if(m) m.hidden=true; });
(function(){
  var m=document.getElementById('session-menu');
  if(!m) return;
  m.addEventListener('click',function(e){
    var item=e.target.closest('.sm-item'); if(!item||!menuSession) return;
    e.stopPropagation();
    var s=menuSession, act=item.dataset.act; m.hidden=true;
    if(act==='rename'){ renameSession(s); }
    else if(act==='pin'){ setPin(s.id,!pinnedIds[s.id]); }
    else if(act==='copyid'){
      if(navigator.clipboard) navigator.clipboard.writeText(s.id).catch(function(){});
      appendSystem('已复制会话 ID');
    }
    else if(act==='copycwd'){
      if(navigator.clipboard) navigator.clipboard.writeText('/workspace').catch(function(){});
      appendSystem('已复制工作目录 /workspace');
    }
    else if(act==='delete'){
      // 活跃会话（CLI 正在其中运行）不允许删除，避免删除后 CLI 会话状态混乱
      if(s.id===liveId){ alert('该会话正在运行中，无法删除。请先结束当前 CLI 会话。'); return; }
      if(!confirm('确定删除会话「'+(s.name||s.id.slice(0,8))+'」？')) return;
      api('sessions/'+encodeURIComponent(s.id),'DELETE').then(function(){
        sessions=sessions.filter(function(x){return x.id!==s.id;});
        if(currentId===s.id){ currentId=null; $('messages').innerHTML='<div class="empty-state">会话已删除</div>'; }
        renderSessions($('sb-search-input').value);
      }).catch(function(){ alert('删除失败'); });
    }
  });
})();
function setPin(id,on){
  api('sessions/pins?cwd=/workspace','PUT',{sessionId:id,pinned:on}).then(function(){
    if(on) pinnedIds[id]=true; else delete pinnedIds[id];
    loadSessions();
  }).catch(function(){});
}
function renameSession(s){
  var n=prompt('重命名会话',s.name||'');
  if(!n||n===s.name) return;
  api('sessions/'+encodeURIComponent(s.id)+'/rename','POST',{name:n}).then(function(){
    s.name=n; loadSessions();
  }).catch(function(){ alert('重命名失败'); });
}
// 键盘快捷键：r 重命名当前会话，p 置顶当前会话（对齐真实 Web UI "Press 'r'... 'p'..."）
document.addEventListener('keydown',function(e){
  if(e.target.tagName==='INPUT'||e.target.tagName==='TEXTAREA') return;
  if(!currentId) return;
  if(e.key==='r'||e.key==='R'){
    var s=sessions.filter(function(x){return x.id===currentId;})[0];
    if(s) renameSession(s);
  }else if(e.key==='p'||e.key==='P'){ setPin(currentId,!pinnedIds[currentId]); }
});
function loadSessions(){
  api('sessions').then(function(j){
    var d=j.data||{};
    sessions=(d.sessions||[]).slice().sort(function(a,b){
      var pa=pinnedIds[a.id]?1:0, pb=pinnedIds[b.id]?1:0;
      if(pa!==pb) return pb-pa;
      return (b.updatedAt||0)-(a.updatedAt||0);
    });
    renderSessions($('sb-search-input').value);
    // 加载置顶集合
    api('sessions/pins?cwd=/workspace').then(function(pj){
      var arr=((pj.data||{}).pinned)||[];
      pinnedIds={}; arr.forEach(function(id){ pinnedIds[id]=true; });
      sessions.sort(function(a,b){ var pa=pinnedIds[a.id]?1:0,pb=pinnedIds[b.id]?1:0; if(pa!==pb)return pb-pa; return (b.updatedAt||0)-(a.updatedAt||0); });
      renderSessions($('sb-search-input').value);
    }).catch(function(){});
  }).catch(function(){
    $('sessions-list').innerHTML='<div class="sb-empty">加载失败</div>';
  });
}

// 打开会话：优先 replay（含思考/消息时间线），失败回退 history 问答对
function openSession(id){
  closeRunStream();   // 离开新对话时关闭其 SSE 流
  currentRunId=null;  // 清空残留的 run id，避免后续操作误用旧运行
  currentId=id;
  closeSidebar();   // 手机上选完会话自动收起侧栏，直接看对话
  var s=sessions.filter(function(x){return x.id===id;})[0]||{};
  $('chat-title').textContent=s.name||'会话';
  $('chat-sub').textContent='workspace · CodeBuddy · '+(s.messageCount||0)+' 条消息';
  renderSessions($('sb-search-input').value);
  var box=$('messages'); box.innerHTML='<div class="sb-loading">加载对话…</div>';
  api('sessions/'+encodeURIComponent(id)+'/replay').then(function(j){
    var evs=((j.data||{}).events)||[];
    if(!evs.length) throw new Error('empty replay');
    box.innerHTML='';
    var assistantOpen=false;
    var toolEls={};   // toolCallId -> {wrap, title, status, body}
    var curThink=null;   // 当前合并中的思考块（连续 agent_thought_chunk 合并到一处）
    var curToolGroup=null, toolGroupEl=null, toolGroupCount=0;   // 连续工具调用聚合（真实 Web UI "N tools executed"）
    function endToolGroup(){ curToolGroup=null; toolGroupEl=null; toolGroupCount=0; }
    evs.forEach(function(e){
      var u=e.update||{}, type=u.sessionUpdate||'';
      // 非思考 chunk 出现 → 结束当前思考块，下一段思考会新建
      if(type!=='agent_thought_chunk') curThink=null;
      // 按"轮次"聚合工具：新的用户消息才结束当前工具组；
      // 同一轮内的 agent_message_chunk / agent_thought_chunk 不打断聚合（它们只是工具的文字说明）
      if(type==='user_message_chunk') endToolGroup();
      if(type==='tool_call'){
        // 工具聚合：连续工具调用收进一个折叠组（对齐真实 Web UI "N tools executed. Click to expand."）
        if(!curToolGroup){
          curToolGroup=document.createElement('details'); curToolGroup.className='msg-tools-group';
          toolGroupEl=document.createElement('summary'); toolGroupEl.className='tools-group-summary cursor-pointer';
          curToolGroup.appendChild(toolGroupEl); box.appendChild(curToolGroup); toolGroupCount=0;
        }
        toolGroupCount++;
        toolGroupEl.innerHTML='<span class="codicon codicon-tools"></span> '+toolGroupCount+' 个工具调用 · 点击展开';
        var tc=document.createElement('details'); tc.className='msg-tool tool-call-item';
        var sm=document.createElement('summary'); sm.className='tool-call-row cursor-pointer';
        var nm=(u._meta&&u._meta['codebuddy.ai/toolName'])||(u.title?String(u.title).split('\n')[0].slice(0,40):'工具');
        var kind=u.kind||'tool';
        sm.innerHTML='<span class="codicon codicon-tools"></span> <span class="tool-name tool-call-title"></span> <span class="tool-kind"></span>';
        sm.querySelector('.tool-name').textContent=nm;
        sm.querySelector('.tool-kind').textContent='· '+kind;
        var body=document.createElement('div'); body.className='tool-body';
        var inp=document.createElement('pre'); inp.className='tool-input';
        inp.textContent=JSON.stringify(u.rawInput||{},null,2);
        var out=document.createElement('pre'); out.className='tool-output'; out.textContent='执行中…';
        body.appendChild(inp); body.appendChild(out);
        tc.appendChild(sm); tc.appendChild(body); curToolGroup.appendChild(tc);
        toolEls[u.toolCallId]={wrap:tc,name:sm.querySelector('.tool-name'),out:out,status:'pending'};
        assistantOpen=true;
      }else if(type==='tool_call_update'){
        var te=toolEls[u.toolCallId]; if(te){
          te.status=u.status||te.status;
          var txt='';
          var c=u.content||[];
          for(var ci=0;ci<c.length;ci++){
            var cc=c[ci];
            if(cc.type==='content' && cc.content && cc.content.type==='text') txt+=cc.content.text;
          }
          if(txt) te.out.textContent=txt.slice(0,3000);
          te.wrap.classList.add('tool-done');
          // 更新所属聚合组的完成计数（对齐真实 Web UI "N tools executed"）
          var grp=te.wrap.closest('.msg-tools-group');
          if(grp){
            var done=grp.querySelectorAll('.tool-call-item.tool-done').length;
            var total=grp.querySelectorAll('.tool-call-item').length;
            var sum=grp.querySelector('.tools-group-summary');
            if(sum) sum.innerHTML='<span class="codicon codicon-tools"></span> '+total+' 个工具调用 · '+done+' 已完成 · 点击展开';
          }
          // title 是完整命令/描述（可能几百字），不要覆盖短工具名（Bash/Read…），只作 tooltip
          if(u.title){
            var tnMeta=(u._meta&&u._meta['codebuddy.ai/toolName'])||'';
            if(tnMeta) te.name.textContent=tnMeta;
            te.name.title=u.title;
          }
        }
      }else if(type==='user_message_chunk'){
        var txt=(u.content||{}).text||'';
        if(!txt.trim()) return;
        var mu=document.createElement('div'); mu.className='msg msg-user';
        var ub=document.createElement('div'); ub.className='bubble'; ub.textContent=txt;
        addCopyBtn(ub,txt); mu.appendChild(ub); box.appendChild(mu); assistantOpen=false;
      }else if(type==='agent_thought_chunk'){
        var th=(u.content||{}).text||'';
        if(!th.trim()) return;
        // 合并连续思考 chunk 到同一块（对齐真实 Web UI：一个可展开思考区，而非每 chunk 一个碎片）
        var d=curThink;
        if(!d){
          d=document.createElement('details'); d.className='msg-think assistant-process-thinking';
          var sm=document.createElement('summary'); sm.textContent='思考';
          var pre=document.createElement('div'); pre.className='think-body';
          d.appendChild(sm); d.appendChild(pre); box.appendChild(d); curThink=d;
        }
        d.querySelector('.think-body').textContent+=th;
        assistantOpen=true;
      }else if(type==='agent_message_chunk'){
        var mt=(u.content||{}).text||'';
        if(!mt.trim()) return;
        var ma=document.createElement('div'); ma.className='msg msg-assistant';
        if(!assistantOpen){ var role=document.createElement('div'); role.className='msg-role'; role.textContent='CodeBuddy'; ma.appendChild(role); assistantOpen=true; }
        var bb=document.createElement('div'); bb.className='bubble md-body'; bb.innerHTML=mdToHtml(mt);
        addCopyBtn(bb,mt); ma.appendChild(bb);
        // 复制请求 ID（对齐真实 Web UI message footer）
        var meta=u._meta||{}, reqId=meta['codebuddy.ai/conversationRequestId']||meta['codebuddy.ai/requestId']||meta['codebuddy.ai/traceId'];
        if(reqId){
          var foot=document.createElement('div'); foot.className='msg-footer';
          var idBtn=document.createElement('button'); idBtn.className='msg-id-btn';
          idBtn.title='复制请求 ID：'+reqId;
          idBtn.innerHTML='<span class="codicon codicon-tag"></span> '+reqId.slice(0,8)+'…';
          idBtn.onclick=function(){
            if(navigator.clipboard) navigator.clipboard.writeText(reqId).catch(function(){});
            idBtn.textContent='已复制 ✓'; setTimeout(function(){ idBtn.innerHTML='<span class="codicon codicon-tag"></span> '+reqId.slice(0,8)+'…'; },1200);
          };
          foot.appendChild(idBtn); ma.appendChild(foot);
        }
        box.appendChild(ma);
      }
      // 其它类型（tool_call / session_info_update 等）后续可扩展
    });
    if(!box.children.length) box.innerHTML='<div class="empty-state">该会话暂无对话</div>';
    else box.scrollTop=box.scrollHeight;
  }).catch(function(){
    // 回退 history
    api('sessions/'+encodeURIComponent(id)+'/history').then(function(j){
      var reqs=((j.data||{}).requests)||[];
      box.innerHTML='';
      if(!reqs.length){ box.innerHTML='<div class="empty-state">该会话暂无对话</div>'; return; }
      reqs.forEach(function(r){
        var mu=document.createElement('div'); mu.className='msg msg-user';
        var ub=document.createElement('div'); ub.className='bubble'; ub.textContent=r.userInput||'';
        addCopyBtn(ub,r.userInput||''); mu.appendChild(ub); box.appendChild(mu);
        var ma=document.createElement('div'); ma.className='msg msg-assistant';
        var role=document.createElement('div'); role.className='msg-role'; role.textContent='CodeBuddy';
        var bb=document.createElement('div'); bb.className='bubble md-body'; bb.innerHTML=mdToHtml(r.finalReply||'');
        addCopyBtn(bb,r.finalReply||''); ma.appendChild(role); ma.appendChild(bb); box.appendChild(ma);
      });
      box.scrollTop=box.scrollHeight;
    }).catch(function(e){ box.innerHTML='<div class="sb-empty">加载失败：'+e.message+'</div>'; });
  });
}

// 事件绑定
// 侧栏开合：手机走 body.rail-expanded + .sidebar.open 抽屉（默认收起、内容全屏）；桌面走 body.sidebar-collapsed
function isNarrow(){ return window.matchMedia && window.matchMedia('(max-width:720px)').matches; }
function isSidebarOpen(){ return isNarrow() ? document.body.classList.contains('rail-expanded') : !document.body.classList.contains('sidebar-collapsed'); }
function setSidebar(open){
  if(isNarrow()){
    document.body.classList.toggle('rail-expanded',open);
    $('sidebar').classList.toggle('open',open);
    var bd=$('sb-backdrop'); if(bd) bd.classList.toggle('show',open);
    // 展开态隐藏左上角全局按钮（侧栏内已有收起按钮），收起态才在左上角显示
    var rt=$('btn-rail-toggle'); if(rt) rt.hidden=open;
  }else{
    document.body.classList.toggle('sidebar-collapsed',!open);
  }
  // 所有收起按钮 title/aria 随状态互换（对齐真实内核）
  var label=(open?'收起侧边栏':'展开侧边栏')+' (Ctrl+B)', aria=open?'收起侧边栏':'展开侧边栏';
  ['btn-sidebar-toggle','btn-collapse-sidebar','btn-rail-toggle'].forEach(function(id){
    var btn=$(id); if(!btn) return;
    btn.title=label; btn.setAttribute('aria-label',aria);
  });
}
function closeSidebar(){ setSidebar(false); }
$('sb-search-input').addEventListener('input',function(){ renderSessions(this.value); });
$('btn-refresh').addEventListener('click',loadSessions);
$('btn-sidebar-toggle').addEventListener('click',function(){ setSidebar(!isSidebarOpen()); });
var btnRailToggle=$('btn-rail-toggle');
if(btnRailToggle) btnRailToggle.addEventListener('click',function(){ setSidebar(!isSidebarOpen()); });
var btnCollapse=$('btn-collapse-sidebar');
if(btnCollapse) btnCollapse.addEventListener('click',function(){ setSidebar(false); });
// 最近会话 icon：切换会话列表显示（对齐真实内核：展开侧栏默认是「我的分身」）
var btnRecent=$('btn-recent-sessions');
if(btnRecent) btnRecent.addEventListener('click',function(){
  var sb=$('sidebar'), show=!sb.classList.contains('show-sessions');
  sb.classList.toggle('show-sessions',show);
  btnRecent.setAttribute('aria-expanded',show?'true':'false');
  if(show) renderSessions($('sb-search-input').value);
});
// Ctrl+B / Cmd+B 切换侧栏（对齐真实内核）
document.addEventListener('keydown',function(e){
  if((e.ctrlKey||e.metaKey) && (e.key==='b'||e.key==='B')){
    var t=e.target, tag=t&&t.tagName;
    // 输入框内不拦截（保留浏览器默认行为的地方按需），但侧栏开关不干扰打字
    if(tag==='INPUT'||tag==='TEXTAREA') return;
    e.preventDefault();
    setSidebar(!isSidebarOpen());
  }
});
// 导出当前会话为 Markdown（对齐真实 Web UI 整轮对话导出）
$('btn-export').addEventListener('click',function(){
  if(!currentId){ alert('请先选择一个会话'); return; }
  var s=sessions.filter(function(x){return x.id===currentId;})[0]||{};
  api('sessions/'+encodeURIComponent(currentId)+'/history').then(function(j){
    var reqs=((j.data||{}).requests)||[];
    var md='# '+(s.name||'会话')+'\n\n';
    reqs.forEach(function(r){
      md+='## 用户\n\n'+(r.userInput||'')+'\n\n## CodeBuddy\n\n'+(r.finalReply||'')+'\n\n---\n\n';
    });
    var blob=new Blob([md],{type:'text/markdown;charset=utf-8'});
    var url=URL.createObjectURL(blob), a=document.createElement('a');
    a.href=url; a.download=(s.name||'会话').replace(/[\/\?%*:|"<>]/g,'_').slice(0,40)+'.md';
    document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
  });
});
// 新对话：用真实 Web UI 的 POST /api/v1/runs 发起独立 Agent 执行（不干扰当前 CLI 会话）
var currentRunId=null, currentRunEs=null;
function closeRunStream(){ if(currentRunEs){ try{ currentRunEs.close(); }catch(e){} currentRunEs=null; } }
function newChat(){
  closeRunStream();   // 关闭上一条新对话的 SSE 流，避免后台推送写入已脱离 DOM 的节点
  closeSidebar();     // 手机上侧栏展开会盖住主区，新建前先收起（点击 sidebar 内按钮时尤其需要）
  currentId=null; currentRunId=null;
  $('chat-title').textContent='新对话'; $('chat-sub').textContent='workspace · CodeBuddy';
  $('messages').innerHTML='<div class="empty-state">输入消息开始新对话</div>';
  renderSessions($('sb-search-input').value);
  $('composer-input').focus();
}
$('btn-new-chat').addEventListener('click',newChat);
var btnNewChatSide=$('btn-new-chat-side');
if(btnNewChatSide) btnNewChatSide.addEventListener('click',function(ev){ ev.stopPropagation(); newChat(); });
function sendNewRun(text){
  var box=$('messages'); var empty=box.querySelector('.empty-state'); if(empty) empty.remove();
  appendUserBubble(text);
  appendSystem('已发起，等待响应…');
  var msg={id:'msg-'+Date.now(),type:'message',version:'1.0',
    source:{platform:'generic',sender:{id:'web-user'},conversation:{id:'web-'+Date.now(),type:'direct'}},
    payload:{text:text}};
  api('runs','POST',msg).then(function(j){
    var runId=(j.data||{}).runId;
    if(!runId){ appendSystem('发起失败'); return; }
    currentRunId=runId;
    // SSE 流式拿回复（全局持有，切会话/新建对话时可关闭）
    closeRunStream();
    var es=new EventSource(API+'/cb/api/webui/runs/'+encodeURIComponent(runId)+'/stream');
    currentRunEs=es;
    var acc='', respDiv=null;
    es.onmessage=function(ev){
      try{
        var o=JSON.parse(ev.data);
        var d=o.data||o;
        var t='';
        if(d.update&&d.update.content&&d.update.content.text) t=d.update.content.text;
        else if(d.text) t=d.text;
        if(t){
          acc+=t;
          // 新对话回复同样走 Markdown 渲染（与打开历史会话一致），复制用原始文本
          if(!respDiv){ respDiv=document.createElement('div'); respDiv.className='msg msg-assistant';
            var role=document.createElement('div'); role.className='msg-role'; role.textContent='CodeBuddy';
            var bb=document.createElement('div'); bb.className='bubble md-body'; bb.innerHTML=mdToHtml(acc);
            // 新对话复制按钮：onclick 动态读最新 bubble 文本（流式过程中 acc 持续增长）
            var cp=document.createElement('button'); cp.className='message-copy-button'; cp.title='复制到剪贴板';
            cp.innerHTML='<span class="codicon codicon-copy"></span>';
            cp.onclick=function(ev){ ev.stopPropagation();
              var txt=respDiv.querySelector('.bubble')?.innerText||'';
              if(navigator.clipboard&&navigator.clipboard.writeText) navigator.clipboard.writeText(txt).catch(function(){});
              cp.classList.add('copied'); setTimeout(function(){cp.classList.remove('copied');},1200);
            };
            respDiv.appendChild(role); respDiv.appendChild(bb); respDiv.appendChild(cp); box.appendChild(respDiv);
          }else{ var bub=respDiv.querySelector('.bubble'); if(bub) bub.innerHTML=mdToHtml(acc); }
          box.scrollTop=box.scrollHeight;
        }
      }catch(e){}
    };
    es.onerror=function(){ es.close(); if(currentRunEs===es) currentRunEs=null; };
  }).catch(function(e){ appendSystem('发送失败：'+e.message); });
}
var sbBackdrop=document.getElementById('sb-backdrop');
if(sbBackdrop) sbBackdrop.addEventListener('click',closeSidebar);
document.querySelectorAll('.rail-btn').forEach(function(b){
  b.addEventListener('click',function(){
    var v=b.dataset.view;
    // 编辑页点任意一级入口（资源管理器除外）→ 先回对话视图；二级图标(.rail-sidetab)不参与
    if(location.hash==='#/editor-page' && v!=='files' && !b.classList.contains('rail-sidetab')){
      location.hash=''; applyView();
      if(v==='agents'){ document.querySelectorAll('.rail-btn').forEach(function(x){x.classList.remove('active');}); b.classList.add('active'); }
      return;
    }
    if(v==='agents'||v==='sessions'){
      // 已打开且点的是当前激活项 → 关闭；否则打开
      var isActive=b.classList.contains('active');
      var wasOpen=$('sidebar').classList.contains('open');
      document.querySelectorAll('.rail-btn').forEach(function(x){x.classList.remove('active');});
      b.classList.add('active');
      if(isActive && wasOpen){ closeSidebar(); }
      else {
        setSidebar(true);
        if(v==='sessions' && isNarrow()){
          // 点「会话」入口 → 直接展开会话列表（对齐真实内核）
          $('sidebar').classList.add('show-sessions');
          var br=$('btn-recent-sessions'); if(br) br.setAttribute('aria-expanded','true');
        }
        renderSessions('');
      }
    }else if(v==='files'){
      // 资源管理器入口：切到 #/editor-page 全屏编辑器视图（对应真实 Web UI 的 editor-page）
      location.hash='#/editor-page';
    }else{
      document.querySelectorAll('.rail-btn').forEach(function(x){x.classList.remove('active');});
      b.classList.add('active');
      closeSidebar();
      setWorkbench(false);
    }
  });
});
// 工作目录显示（对齐真实 Web UI 输入卡片顶部）
var cwdValue='/workspace';
(function(){
  var el=document.getElementById('cwd-label');
  if(el && liveAgents.length && liveAgents[0].cwd){ cwdValue=liveAgents[0].cwd; el.textContent=cwdValue; }
  var meta=document.getElementById('composer-meta');
  if(meta) meta.onclick=function(){
    var v=prompt('工作目录',cwdValue);
    if(v){ cwdValue=v; var l=document.getElementById('cwd-label'); if(l) l.textContent=v; }
  };
})();
function sendMessage(){
  var input=$('composer-input');
  var text=input.value.trim();
  if(!text) return;
  // 无当前会话 → 新对话（runs API），安全测试
  if(!currentId){ input.value=''; sendNewRun(text); return; }
  // 只有当前活会话能直接 reply；其它会话需先 resume（后续做）
  if(!liveId || currentId!==liveId){
    appendSystem('该会话未激活，暂不能在此回复（自动载入 --resume 待实现）');
    return;
  }
  input.value='';
  appendUserBubble(text);   // 乐观显示用户消息
  api('sessions/'+encodeURIComponent(currentId)+'/reply','POST',{text:text})
    .then(function(j){
      if(j.data && j.data.delivered){
        appendSystem('已投递，等待回复…');
        pollReply();
      }else{
        appendSystem('投递失败：'+(j.error||'未知'));
      }
    }).catch(function(e){ appendSystem('发送失败：'+e.message); });
}
function appendUserBubble(text){
  var box=$('messages'); var empty=box.querySelector('.empty-state'); if(empty) empty.remove();
  var mu=document.createElement('div'); mu.className='msg msg-user';
  var ub=document.createElement('div'); ub.className='bubble'; ub.textContent=text;
  addCopyBtn(ub,text); mu.appendChild(ub); box.appendChild(mu); box.scrollTop=box.scrollHeight;
}
function appendSystem(text){
  var box=$('messages'); var d=document.createElement('div');
  d.className='msg-sys'; d.style.cssText='color:var(--fg-muted);font-size:11px;text-align:center;padding:8px';
  d.textContent=text; box.appendChild(d); box.scrollTop=box.scrollHeight;
}
// 轮询 history：finalReply 变化即渲染新回复
function pollReply(){
  var ticks=0;
  var timer=setInterval(function(){
    ticks++;
    api('sessions/'+encodeURIComponent(currentId)+'/history').then(function(j){
      var reqs=((j.data||{}).requests)||[];
      var last=reqs[reqs.length-1];
      if(last && last.finalReply){
        // 若最后一条已是新回复则停止（简单：有 reply 就重渲染一次后停）
        clearInterval(timer);
        // 重渲染整段对话
        openSession(currentId);
      }
    });
    if(ticks>60) clearInterval(timer);  // 最多 60 次（约 2 分钟）
  },2000);
}
$('btn-send').addEventListener('click',sendMessage);
$('composer-input').addEventListener('keydown',function(e){
  if(e.key==='Enter'&&!e.shiftKey){ e.preventDefault(); sendMessage(); }
});

// ===== 视图切换：#/editor-page → 全屏编辑器（真实 Web UI 的 editor-page）=====
function applyView(){
  var isEditor=(location.hash==='#/editor-page');
  var host=document.getElementById('editor-host');
  // editor 页保留最左 rail（统一导航栏），只隐藏对话页的 sidebar/main
  var sb=document.getElementById('sidebar'), main=document.getElementById('main');
  if(host) host.hidden=!isEditor;
  if(sb) sb.style.display=isEditor?'none':'';
  if(main) main.style.display=isEditor?'none':'';
  // 左上角收起按钮只在对话页显示；编辑器页不显示（对齐真实内核）
  var rt=$('btn-rail-toggle'); if(rt) rt.hidden=isEditor;
  // 一级入口始终固定显示，不随视图切换；编辑器二级图标独立放下面，仅编辑器页出现
  var side=document.getElementById('rail-sidetabs'); if(side) side.hidden=!isEditor;
  // 编辑页：清掉一级 active、二级首项(files)高亮；对话页：恢复一级高亮、清二级 active
  var navBtns=document.querySelectorAll('#rail-nav .rail-btn');
  if(isEditor){ navBtns.forEach(function(b){ b.classList.remove('active'); }); }
  else if(!document.querySelector('#rail-nav .rail-btn.active')){
    // 回对话：一级无高亮则恢复「我的分身」为默认
    var def=document.querySelector('#rail-nav .rail-btn[data-view=agents]'); if(def) def.classList.add('active');
  }
  if(side) side.querySelectorAll('.rail-sidetab').forEach(function(b,i){ b.classList.toggle('active',isEditor&&i===0); });
  // 左下角「回到对话」按钮删除（多余）：editor 页也不显示
  var back=document.getElementById('btn-back-chat'); if(back) back.hidden=true;
  // 手机：编辑页保留最左 rail（不全屏，一级入口可见）；对话页收起 rail 内容全屏
  if(isNarrow()){
    document.body.classList.toggle('rail-expanded',isEditor);
    if(!isEditor){ var bd=$('sb-backdrop'); if(bd) bd.classList.remove('show'); var sbx=$('sidebar'); if(sbx) sbx.classList.remove('open'); }
  }
  // 进 editor 页：手机端通知 iframe 展开文件列表（否则 explorer 隐藏、看不到文件）
  if(isEditor){
    var frame=document.getElementById('editor-frame');
    var notify=function(){
      if(frame && frame.contentWindow) frame.contentWindow.postMessage({type:'cb:open-explorer'},'*');
    };
    if(frame && !frame.dataset.ready){
      // 首次加载：必须等 iframe load 完成后再发消息，否则其 message listener 尚未注册，消息丢失
      frame.addEventListener('load',function(){ frame.dataset.ready='1'; notify(); },{once:true});
      if(frame.contentDocument && frame.contentDocument.readyState==='complete'){ frame.dataset.ready='1'; notify(); }
    }else notify();
  }
}
// 编辑页底部返回对话按钮
var backBtn=document.getElementById('btn-back-chat');
if(backBtn) backBtn.onclick=function(){ location.hash=''; applyView(); };
window.addEventListener('hashchange',applyView);
applyView();
// 动态 4 icon 点击 → 通知 iframe 切面板
var sidePanelOpen=true, activeSidePanel='files';   // 编辑器页侧栏展开状态（进入时列表默认展开）
document.querySelectorAll('.rail-sidetab').forEach(function(b){
  b.addEventListener('click',function(){
    var frame=document.getElementById('editor-frame'), p=b.dataset.panel;
    var same=(p===activeSidePanel);
    if(same && sidePanelOpen){
      // 再次点当前入口 → 关闭侧栏（对齐 VS Code toggle）
      sidePanelOpen=false;
      b.classList.remove('active');
      if(frame&&frame.contentWindow) frame.contentWindow.postMessage({type:'cb:panel-toggle'},'*');
    }else{
      sidePanelOpen=true; activeSidePanel=p;
      document.querySelectorAll('.rail-sidetab').forEach(function(x){x.classList.remove('active');});
      b.classList.add('active');
      if(frame&&frame.contentWindow) frame.contentWindow.postMessage({type:'cb:panel',panel:p},'*');
    }
  });
});
// 编辑器 iframe 内点"智能体/回到对话"→ 切回对话视图
window.addEventListener('message',function(e){
  if(e.data==='cb:back-to-chat'){ location.hash=''; applyView(); }
  if(e.data==='cb:file-opened'){ sidePanelOpen=false; }   // 点文件后列表收起，同步 toggle 状态
  if(e.data && e.data.type==='cb:panel' && e.data.fromIframe){ sidePanelOpen=true; }  // iframe 内重开列表
});

// ===== 右侧工作台：资源管理器（真实 fs API）/ 搜索 / SCM / 终端 =====
var ftRoot='/workspace';
// 独立 fs API（桥自己用 Node fs 实现，不依赖 codebuddy web UI）
function fsApi(path,method,body){
  return fetch(API+'/cb/api/fs/'+path,{method:method||'GET',cache:'no-store',
    headers:body?{'content-type':'application/json'}:undefined,
    body:body?JSON.stringify(body):undefined}).then(function(r){return r.json();});
}
function fsList(path){
  return fsApi('list','POST',{path:path}).then(function(j){ return j.entries||[]; }).catch(function(){ return []; });
}
function fsRead(path){ return fsApi('read?path='+encodeURIComponent(path)); }
function fileIcon(e){
  if(e.type==='directory') return '<span class="ico folder codicon codicon-folder"></span>';
  var n=(e.name||'').toLowerCase();
  if(/\.(md|txt|json|yml|yaml|log)$/.test(n)) return '<span class="ico codicon codicon-file-text"></span>';
  if(/\.(png|jpg|svg|webp|gif)$/.test(n)) return '<span class="ico codicon codicon-file-image"></span>';
  if(/\.(js|ts|py|go|java|sh)$/.test(n)) return '<span class="ico codicon codicon-file-code"></span>';
  return '<span class="ico codicon codicon-file"></span>';
}
// 统一渲染一层目录到 container（真实 API，懒加载；目录可展开，文件点击打开编辑器）
function renderDirInto(path,container,depth,showLoading){
  if(showLoading) container.innerHTML='<div class="ft-loading">加载中…</div>';
  fsList(path).then(function(entries){
    container.innerHTML='';
    if(!entries.length){ container.innerHTML='<div class="ft-loading">空目录</div>'; return; }
    entries.sort(function(a,b){ if(a.type!==b.type) return a.type==='directory'?-1:1; return a.name.localeCompare(b.name); });
    entries.forEach(function(e){
      var row=document.createElement('div'); row.className='ft-row'; row.style.paddingLeft=(depth*12)+'px';
      var chev='<span class="chev'+(e.type==='directory'?'':' codicon codicon-chevron-right')+'">'+(e.type==='directory'?'▸':'')+'</span>';
      row.innerHTML=chev+fileIcon(e)+'<span class="nm"></span>';
      row.querySelector('.nm').textContent=e.name;
      if(e.type==='directory'){
        var sub=null;
        row.addEventListener('click',function(){
          var c=row.querySelector('.chev'); if(c) c.classList.toggle('open');
          if(sub){ sub.hidden=!sub.hidden; return; }
          sub=document.createElement('div');
          row.parentNode.insertBefore(sub,row.nextSibling);
          renderDirInto(e.path,sub,depth+1,false);
        });
      }else{
        row.addEventListener('click',function(){ openEditor(e.path,e.name); });
      }
      container.appendChild(row);
    });
  });
}
function renderDir(path,container,depth){ renderDirInto(path,container,depth,true); }
function loadFileTree(){ renderDir(ftRoot,document.getElementById('file-tree'),0); }
// tab 切换
function showWbTab(name){
  var ed=document.getElementById('wb-editor');
  // 离开资源管理器 tab 时关掉编辑器；点回 explorer 时也关掉（回到文件树）
  if(ed && !ed.hidden){ ed.hidden=true; var ex=document.getElementById('wb-explorer'); if(ex) ex.hidden=false; }
  ['explorer','search','scm','terminal'].forEach(function(t){
    var p=document.getElementById('wb-'+t); if(p) p.hidden=(t!==name);
  });
  document.querySelectorAll('.wb-tab[data-tab]').forEach(function(b){ b.classList.toggle('active',b.dataset.tab===name); });
  if(name==='explorer' && !document.getElementById('file-tree').children.length) loadFileTree();
}
document.querySelectorAll('.wb-tab[data-tab]').forEach(function(b){
  b.addEventListener('click',function(){ showWbTab(b.dataset.tab); });
});
function setWorkbench(open){
  var w=document.getElementById('workbench'); if(w) w.classList.toggle('open',open);
}
var wbToggle=document.getElementById('btn-workbench-toggle');
if(wbToggle) wbToggle.addEventListener('click',function(){ setWorkbench(!document.getElementById('workbench').classList.contains('open')); });
var wbClose=document.getElementById('wb-close');
if(wbClose) wbClose.addEventListener('click',function(){ setWorkbench(false); });
// 文件搜索（ripgrep 模糊）
var searchTimer=null;
var wbSearchInput=document.getElementById('wb-search-input');
if(wbSearchInput) wbSearchInput.addEventListener('input',function(){
  var q=this.value.trim(); var box=document.getElementById('wb-search-results');
  if(!q){ box.innerHTML=''; return; }
  clearTimeout(searchTimer);
  searchTimer=setTimeout(function(){
    box.innerHTML='<div class="ft-loading">搜索中…</div>';
    fsApi('search?query='+encodeURIComponent(q)+'&limit=50').then(function(j){
      var arr=j.results||[];
      box.innerHTML='';
      arr.forEach(function(r){
        var d=document.createElement('div'); d.className='sr';
        d.textContent=(r.path||r.name||'').replace(ftRoot,''); d.title=r.path||'';
        d.addEventListener('click',function(){ openEditor(r.path,r.name); });
        box.appendChild(d);
      });
      if(!arr.length) box.innerHTML='<div class="ft-loading">无结果</div>';
    }).catch(function(){ box.innerHTML='<div class="ft-loading">搜索失败</div>'; });
  },300);
});
// ===== 点击文件打开编辑器（标签 + 面包屑 + 行号代码 + 状态栏，依据源码结构）=====
function langOf(name){
  var n=(name||'').toLowerCase();
  if(/\.md$/.test(n)) return 'Markdown';
  if(/\.json$/.test(n)) return 'JSON';
  if(/\.(yml|yaml)$/.test(n)) return 'YAML';
  if(/\.js$/.test(n)) return 'JavaScript';
  if(/\.ts$/.test(n)) return 'TypeScript';
  if(/\.py$/.test(n)) return 'Python';
  if(/\.sh$/.test(n)) return 'Shell';
  if(/\.go$/.test(n)) return 'Go';
  if(/\.(html|htm)$/.test(n)) return 'HTML';
  if(/\.css$/.test(n)) return 'CSS';
  if(/\.(png|jpg|svg|webp|gif)$/.test(n)) return '图片';
  return '纯文本';
}
function openEditor(path,name){
  var ed=document.getElementById('wb-editor'); if(!ed) return;
  ed.hidden=false;
  document.getElementById('wb-explorer').hidden=true;
  document.getElementById('ed-tab-name').textContent=name||path.split('/').pop();
  document.getElementById('ed-breadcrumb').textContent=path.replace(ftRoot,'workspace');
  document.getElementById('ed-lang').textContent=langOf(name||path);
  document.getElementById('ed-branch').textContent='main';
  document.getElementById('ed-lncol').textContent='第 1 行，第 1 列';
  var code=document.getElementById('ed-code');
  code.innerHTML='<div class="ft-loading">加载文件…</div>';
  fsRead(path).then(function(j){
    if(!j.ok){ code.innerHTML='<div class="ft-error">'+(j.error||'读取失败')+'</div>'; return; }
    if(j.binary){ code.innerHTML='<div class="ft-error">二进制文件（'+j.size+' 字节）无法预览</div>'; return; }
    var text=j.content||'';
    code.innerHTML='';
    var frag=document.createDocumentFragment();
    text.split('\n').forEach(function(line,i){
      var row=document.createElement('div'); row.className='ed-line';
      var ln=document.createElement('span'); ln.className='ed-ln'; ln.textContent=(i+1);
      var tx=document.createElement('span'); tx.className='ed-txt'; tx.textContent=line||' ';
      row.appendChild(ln); row.appendChild(tx); frag.appendChild(row);
    });
    code.appendChild(frag);
    // 点击行更新行列号（对齐状态栏）
    code.onclick=function(e){
      var line=e.target.closest('.ed-line'); if(!line) return;
      var ln=Number(line.querySelector('.ed-ln')?.textContent)||1;
      var col=1;
      document.getElementById('ed-lncol').textContent='第 '+ln+' 行，第 '+col+' 列';
    };
  });
}
var edClose=document.getElementById('ed-tab-close');
if(edClose) edClose.addEventListener('click',function(e){
  e.stopPropagation();
  document.getElementById('wb-editor').hidden=true;
  document.getElementById('wb-explorer').hidden=false;
});
loadFileTree();

// 表格复制按钮事件委托（复制为 Markdown / TSV）
document.addEventListener('click',function(e){
  var btn=e.target.closest('.markdown-table-action'); if(!btn) return;
  e.stopPropagation();
  var txt=btn.getAttribute('data-copy')||'';
  if(navigator.clipboard) navigator.clipboard.writeText(txt).catch(function(){});
  var old=btn.textContent; btn.textContent='已复制 ✓';
  setTimeout(function(){ btn.textContent=old; },1200);
});
loadAgents();
loadLive();
loadSessions();
// 全局长按提示：手机长按任意按钮显示其 title 说明（对齐桌面 hover tooltip）
(function(){
  var tip=document.createElement('div'); tip.className='longpress-tip'; tip.hidden=true;
  document.body.appendChild(tip);
  var timer=null, curBtn=null;
  function hide(){ tip.hidden=true; if(timer){clearTimeout(timer);timer=null;} curBtn=null; }
  document.addEventListener('touchstart',function(e){
    var btn=e.target.closest('button'); if(!btn) return;
    var txt=btn.title||btn.getAttribute('aria-label')||btn.dataset.hint||'';
    if(!txt) return;
    curBtn=btn;
    timer=setTimeout(function(){
      if(curBtn!==btn) return;
      var r=btn.getBoundingClientRect();
      tip.textContent=txt; tip.hidden=false;
      var tw=tip.offsetWidth||120;
      tip.style.left=Math.max(4,Math.min(innerWidth-tw-4, r.left+r.width/2-tw/2))+'px';
      tip.style.top=Math.max(4,r.bottom+6)+'px';
    },450);
  },{passive:true});
  ['touchend','touchmove','touchcancel'].forEach(function(ev){
    document.addEventListener(ev,hide,{passive:true});
  });
  document.addEventListener('click',hide,true);
})();
// URL 深链：?session=<id> 打开指定会话（对齐真实 Web UI"地址栏带会话 ID"）
(function(){
  var sid=new URLSearchParams(location.search).get('session');
  if(sid) setTimeout(function(){ openSession(sid); },600);
})();
// 键盘弹起时保持消息区贴底：与终端页 applyKb 同口径——只在用户本来就贴底时跟随，
// 上滑看历史时保持位置不动（避免键盘弹出把历史顶走）。
(function(){
  if(!window.visualViewport) return;
  var vv=window.visualViewport, baseH=window.innerHeight;
  var lastKb=0;
  vv.addEventListener('resize',function(){
    var kb=Math.max(0,baseH-vv.height);
    if(kb<=0){ lastKb=0; return; }
    lastKb=kb;
    var box=$('messages');
    if(!box) return;
    // 贴底（80px 内）才跟随；用户正在看更早消息则不打扰
    if(box.scrollHeight-box.scrollTop-box.clientHeight<=80){
      requestAnimationFrame(function(){ box.scrollTop=box.scrollHeight; });
    }
  });
})();
// 手机默认侧栏收起、内容全屏（对齐真实内核）：左上角「展开侧边栏」按钮是唯一入口。
// 收起态按钮 title 已是"展开侧边栏"（HTML 初始），无需自动展开；仅同步一次状态。
(function(){
  if(isSidebarOpen()) return;   // 默认收起，按钮图标/title 已正确
  setSidebar(false);
})();
})();

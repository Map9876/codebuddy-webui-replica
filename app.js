(function(){
  'use strict';
  var API = '';
  var $ = function(s){ return document.querySelector(s); };
  var log=$('#log'), input=$('#input');
  var picker=$('#term-picker'), pickerName=$('#term-picker-name');
  var drawer=$('#term-drawer'), menu=$('#more-menu');

  // 终端行专用容器（输入反馈行走 log，不干扰 diff 的行索引）
  var linesEl=document.createElement('div');
  linesEl.id='lines';
  log.insertBefore(linesEl, log.firstChild);

  var terms=[], activeId=null, codeMap={};
  var state={};       // id -> { tb, lines:[key], rows }  每个终端一个持久 TermBuffer
  var es=null;        // 当前 EventSource（实时流）
  var esId=null;
  var fetchTimer=null;
  var lastDataId=null;
  // 分栏从属模式：iframe 里加载的副终端，隐藏自己的工具栏/边栏，由父页面统一提供 chrome
  var EMBED=new URLSearchParams(location.search).get('embed')==='1';

  function cleanANSI(s){
    return String(s).replace(/\x1b\[[0-?]*[ -/]*[@-~]/g,'').replace(/\x1b\][^\x07]*\x07/g,'').replace(/\r/g,'');
  }
  function scrollBottom(){ requestAnimationFrame(function(){ log.scrollTop=log.scrollHeight; }); }

  // ---- 单行渲染 / key ----
  function lineKey(segs){
    var k='';
    for(var i=0;i<segs.length;i++){
      var s=segs[i];
      k+=s.text+'\u0001'+(s.fg||'')+'\u0002'+(s.bg||'')+'\u0003'+(s.bold?1:0)+(s.dim?1:0)+(s.italic?1:0)+(s.underline?1:0)+(s.reverse?1:0)+(s.strike?1:0)+'\u0004';
    }
    return k;
  }
  function esc(s){ return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
  // 把过亮的文字色压暗（浅色背景可读）；保留绿/蓝等彩色的色相
  function readableFg(c){
    if(!c) return c;
    var m=c.match(/rgb\((\d+),(\d+),(\d+)\)/);
    if(m){
      var r=+m[1],g=+m[2],b=+m[3];
      var lum=(0.299*r+0.587*g+0.114*b)/255;
      if(lum>0.62){ var k=0.62/lum; r=Math.round(r*k);g=Math.round(g*k);b=Math.round(b*k); }
      return 'rgb('+r+','+g+','+b+')';
    }
    if(/^#[0-9a-f]{6}$/i.test(c)){
      var n=parseInt(c.slice(1),16),R=(n>>16)&255,G=(n>>8)&255,B=n&255;
      var L=(0.299*R+0.587*G+0.114*B)/255;
      if(L>0.62){ var k2=0.62/L; R=Math.round(R*k2);G=Math.round(G*k2);B=Math.round(B*k2);
        return 'rgb('+R+','+G+','+B+')'; }
    }
    return c;
  }
  function lineHTML(segs){
    var inner='';
    for(var i=0;i<segs.length;i++){
      var s=segs[i], st='', fg=s.fg, bg=s.bg;
      if(s.reverse){ var t=fg; fg=bg||'#fafafd'; bg=t||'#202020'; }
      // TUI 按深色终端配色输出亮色文字（如 rgb(184,191,197)），在浅色 chat 背景上看不清 → 自动加深保证可读
      if(fg && !bg){ fg=readableFg(fg); }
      if(fg) st+='color:'+fg+';';
      if(bg) st+='background:'+bg+';';
      if(s.bold) st+='font-weight:700;';
      if(s.dim) st+='opacity:.6;';
      if(s.italic) st+='font-style:italic;';
      if(s.underline) st+='text-decoration:underline;';
      if(s.strike) st+='text-decoration:line-through;';
      if(s.__cursor) inner+='<span class="term-cursor"></span>';
      else inner+='<span'+(st?' style="'+st+'"':'')+'>'+esc(s.text)+'</span>';
    }
    return inner;
  }
  function makeLineEl(segs){
    var d=document.createElement('div');
    d.className='term-line';
    // 纯 ─ 分隔线是 TUI 输入区的边框，在手机窄屏不要被 pre-wrap 折成两行
    var t=textOf(segs).trim();
    if(/^─{3,}$/.test(t)) d.classList.add('hr-line');
    d.innerHTML=lineHTML(segs);
    d.dataset.k=lineKey(segs);   // 用于公共前缀 diff（避免每次重建 DOM）
    return d;
  }
  function textOf(segs){ var t=''; for(var i=0;i<segs.length;i++) t+=segs[i].text; return t; }
  function compressBlank(lines){
    var out=[], blanks=0;
    for(var i=0;i<lines.length;i++){
      if(!textOf(lines[i]).trim()){ blanks++; if(blanks>1) continue; }
      else blanks=0;
      out.push(lines[i]);
    }
    return out;
  }

  // rAF 节流：一帧内多次 SSE chunk 只重绘一次 DOM（streaming 高频 token 不卡顿、不丢数据）
  var renderPending={};
  function scheduleRender(id){
    if(renderPending[id]) return;
    renderPending[id]=true;
    requestAnimationFrame(function(){ renderPending[id]=false; renderRows(id); });
  }
  // ---- 增量更新：重建尾部窗口 DOM（400 行，很快），保住滚动位置 ----
  function renderRows(id){
    if(activeId!==id) return;
    // 输入期间冻结 headless 渲染：zsh 用 wcwidth=2 算 emoji，headless 算1，
    // 重绘序列会让 headless 的输入行错乱重复。冻结到回车后再渲染 zsh 提交后的正确行。
    if(typing) return;
    var st=state[id]; if(!st||!st.box) return;
    var atBottom=(log.scrollHeight-log.scrollTop-log.clientHeight)<=80;
    var keepTop=log.scrollTop;

    var newLines=compressBlank(st.tb.render());
    st.segs=newLines;
    st.lines=newLines.map(lineKey);
    var start=Math.max(0, newLines.length-WINDOW);
    st.shownFrom=start;
    var win=newLines.slice(start);
    var oldKeys=[];   // 两分支共用：普通 shell 的 diff 用；TUI 分支保持空数组（下方 hadNew 计算会访问）
    // TUI 终端：AI streaming 靠光标定位整屏重绘，diff 的前缀比较会漏掉"内容被重绘但 key 未变"的行
    // → 直接全量重建尾部窗口（codebuddy TUI 经 compressBlank 后只有几十行，极快，保证每次刷新都正确）
    if(isTui()){
      st.box.innerHTML='';
      for(var q=0;q<win.length;q++) st.box.appendChild(makeLineEl(win[q]));
    }else{
      // 普通 shell：几万行，用公共前缀 diff 只增删/替换变化行
      var newKeys=win.map(lineKey);
      for(var j=0;j<st.box.children.length;j++) oldKeys.push(st.box.children[j].dataset.k||'');
      var p=0, mx=Math.min(oldKeys.length,newKeys.length);
      while(p<mx && oldKeys[p]===newKeys[p]) p++;
      while(st.box.children.length>p) st.box.removeChild(st.box.lastChild);
      for(var k=p;k<win.length;k++) st.box.appendChild(makeLineEl(win[k]));
    }

    // 自动跟随：贴底时跟随新输出；用户上滑看历史时保持。用户松手 >1s 后，若有新内容则恢复跟底。
    var now=Date.now();
    var userActive=(now<userScrollingUntil);   // touchmove/wheel 后 800ms 内算用户主动
    var justTouched=(now<userTouchEndUntil);   // 松手后 1s 内不强制拉回
    var hadNew=st.box.children.length>oldKeys.length;
    if(!userActive && !justTouched && (atBottom || hadNew)) scrollBottom();
    else log.scrollTop=keepTop;
    renderTyping();
  }

  // ---- 上滑到顶：无感加载更早的行（每次多显示 WINDOW 行）----
  // 只有"用户主动滑动"才触发上滑加载；键盘弹出导致的 scroll 不算（否则页面上滚）
  var userScrollingUntil=0;
  var userTouchEndUntil=0;
  log.addEventListener('touchstart',function(){ userScrollingUntil=Date.now()+10000; },{passive:true}); // 触摸中：不自动跟随
  log.addEventListener('touchend',function(){ userScrollingUntil=Date.now()+300; userTouchEndUntil=Date.now()+1000; },{passive:true}); // 松手1s内不拉回
  log.addEventListener('touchcancel',function(){ userScrollingUntil=Date.now()+300; userTouchEndUntil=Date.now()+1000; },{passive:true});
  log.addEventListener('touchmove',function(){ userScrollingUntil=Date.now()+300; },{passive:true});
  log.addEventListener('wheel',function(){ userScrollingUntil=Date.now()+800; userTouchEndUntil=Date.now()+1000; },{passive:true});
  log.addEventListener('scroll',function(){
    if(Date.now()>userScrollingUntil) return;          // 非用户主动滑动（如键盘弹出）忽略
    if(activeId==null || log.scrollTop>40) return;
    var st=state[activeId]; if(!st||!st.box) return;
    var from=st.shownFrom;
    if(from<=0) return;
    var newFrom=Math.max(0, from-WINDOW);
    var beforeH=st.box.scrollHeight;
    var frag=document.createDocumentFragment();
    for(var i=newFrom;i<from;i++) frag.appendChild(makeLineEl(st.segs[i]));
    st.box.insertBefore(frag, st.box.firstChild);
    st.shownFrom=newFrom;
    log.scrollTop += (st.box.scrollHeight-beforeH);    // 精确保持视口：新内容高度
  });

  // ---- 回底部按钮 + 顶栏空格提示 ----
  var toBottom=document.getElementById('to-bottom');
  var spaceHint=document.getElementById('space-hint');
  function atBottom(){ return (log.scrollHeight-log.scrollTop-log.clientHeight)<=60; }
  function updateBottomBtn(){
    if(!toBottom) return;
    if(!atBottom()){ toBottom.classList.add('show'); if(spaceHint) spaceHint.classList.add('blink'); }
    else{ toBottom.classList.remove('show'); if(spaceHint) spaceHint.classList.remove('blink'); }
  }
  log.addEventListener('scroll',updateBottomBtn,{passive:true});
  if(toBottom) toBottom.addEventListener('click',function(e){
    e.stopPropagation();
    log.scrollTo({top:log.scrollHeight,behavior:'smooth'});   // 平滑回底
  });
  // 空格键回底（终端非输入态时）
  document.addEventListener('keydown',function(e){
    if(document.activeElement===input) return;
    if(e.code==='Space'){ e.preventDefault(); log.scrollTo({top:log.scrollHeight,behavior:'smooth'}); }
  });
  updateBottomBtn();

  // ---- 基线：拉一次 history，建立持久 TermBuffer 并全量渲染 ----
  var WINDOW=400;   // 首次只渲染尾部 400 行，上滑到顶无感加载更早的
  async function initTerm(id){
    var snap=await fetch(API+'/cb/api/snapshot?ids='+encodeURIComponent(id),{cache:'no-store'}).then(function(r){return r.json();});
    var st0=snap.terminals && snap.terminals[id];
    // cols 必须用 PTY 真实值：zsh 重绘序列按此列数算光标，用错列数会输入错乱
    var cols=st0&&st0.cols||120, rows=st0&&st0.rows||30;
    var hist=await fetch(API+'/cb/api/history?id='+encodeURIComponent(id),{cache:'no-store'}).then(function(r){return r.json();});
    var data=(hist.ok&&hist.chunks>0)?hist.data:(st0?st0.data:'');

    // 用 VS Code 同款 @xterm/headless 做协议层（精确列网格/box-drawing/光标）
    var screen=new XtermScreen(cols, rows, !!codeMap[id]);   // codebuddy TUI：只读当前屏幕，避免重绘帧重复
    await new Promise(function(res){ screen.write(data||'', res); });
    var lines=compressBlank(screen.render());

    var box=document.createElement('div');
    box.className='term-box';
    var start=Math.max(0, lines.length-WINDOW);
    for(var i=start;i<lines.length;i++) box.appendChild(makeLineEl(lines[i]));
    // codebuddy 标志随 state 保存：isTui() 据此判断，避免信任对话框等无 ⏵⏵ 关键词的 TUI 被误判成普通 shell
    state[id]={ tb:screen, lines:lines.map(lineKey), segs:lines, rows:rows, box:box, shownFrom:start, codebuddy:!!codeMap[id] };

    if(activeId===id){
      linesEl.innerHTML='';
      linesEl.appendChild(box);
      scrollBottom(); renderTyping();
    }
  }

  // ---- 实时流：EventSource 订阅 onProcessData，chunk 增量写入 TermBuffer ----
  function connectStream(id){
    if(es){ try{ es.close(); }catch(e){} es=null; }
    esId=id;
    es=new EventSource(API+'/cb/api/stream?id='+encodeURIComponent(id));
    es.onmessage=function(ev){
      if(activeId!==id) return;
      var st=state[id]; if(!st) return;
      try{
        var o=JSON.parse(ev.data);
        if(o.id!==id || !o.data) return;
        st.tb.write(o.data);                    // 数据全部写进 headless buffer（其内部排队保证顺序正确）
        scheduleRender(id);                     // DOM 刷新节流到 rAF：一帧多次 chunk 只重绘一次，streaming 才流畅不卡
      }catch(e){}
    };
    es.onerror=function(){ /* EventSource 自动重连；不打断 UI */ };
  }

  function switchTo(id){
    if(activeId===id && state[id]) return;
    // 缓存上一个终端的 DOM 容器（脱链但不销毁）
    if(activeId!=null && state[activeId] && state[activeId].box){
      if(state[activeId].box.parentNode) state[activeId].box.parentNode.removeChild(state[activeId].box);
    }
    activeId=id;
    if(location.pathname!==('/'+id)) history.replaceState(null,'','/'+id);
    renderDrawer(); renderPicker(); renderRail();
    lastDataId=null;

    var st=state[id];
    if(st && st.box){                    // 有缓存：直接挂回，零加载
      linesEl.appendChild(st.box);
      scrollBottom();
      connectStream(id);
      return;
    }
    // 无缓存：显示 loading，异步初始化
    linesEl.innerHTML='<div class="term-line sysline">加载中…</div>';
    (async function(){
      try{ await initTerm(id); }catch(e){}
      if(activeId===id){ connectStream(id); }
    })();
  }

  // ---- 内核级输入：按键实时发给 PTY，TUI 回显到它自己的输入区（两条横线之间）----
  // 不再前端模拟 typing 行——codebuddy TUI 的 > 提示符/光标块是 PTY 回显出来的，
  // 逐字符发送让输入直接显示在 TUI 的真实位置，完全还原原生终端。
  function sendKeys(keys){ // 发按键到 PTY（不等待，fire-and-forget 保证输入无延迟）
    if(activeId==null || !keys) return;
    fetch(API+'/cb/api/input?id='+encodeURIComponent(activeId),{method:'POST',body:keys}).catch(function(){});
  }
  // 输入期间冻结 headless 渲染 + 纯文本乐观行显示（无箭头/无光标块）。
  // 原因：headless 把 emoji 算1列、zsh 算2列，重绘序列会让 headless 输入行重复错乱；
  // 冻结到回车后，zsh 提交时 \r 清行重绘，headless 显示的就是最终正确行。
  var typing='';
  function renderTyping(){
    // 清掉旧的 typing 内联 span（可能挂在任意行）
    var olds=log.querySelectorAll('.typing-inline');
    for(var i=0;i<olds.length;i++) olds[i].remove();
    if(!typing) return;
    // 把输入文本直接追加到当前终端最后一行的末尾（提示符行），视觉上与提示符同一行
    var st=state[activeId];
    var last=(st&&st.box)?st.box.querySelector('.term-line:last-child'):null;
    if(!last) return;
    var sp=document.createElement('span');
    sp.className='typing-inline';
    sp.textContent=typing;
    last.appendChild(sp);
    scrollBottom();
  }
  function send(){
    if(activeId==null) return;
    typing=''; input.value=''; renderTyping();   // 清乐观行 → 解冻 renderRows
    sendKeys('\r');   // 纯原生：回车就是 \r，对接后端，不做任何前端智能判断
    setTimeout(function(){ var st=state[activeId]; if(st) renderRows(activeId); }, 120);
  }
  // TUI 终端（codebuddy 交互界面）：输入靠 PTY 回显到真实输入区（两条横线间），不用乐观行。
  // 普通 shell：zsh syntax-highlight 重绘序列 + emoji 宽度不一致会让 headless 回显错乱，用乐观行。
  function isTui(){
    var st=state[activeId]; if(!st) return false;
    // enrich 识别的 codebuddy 终端一律按 TUI 处理：信任文件夹对话框等弹窗没有 ⏵⏵
    // 关键词，单靠关键词会误判成普通 shell → 输入走乐观行 → 弹窗上叠加错乱文本。
    // 与 renderPicker() 的 t.codebuddy 判断保持一致；codeMap 作为时序兜底。
    if(st.codebuddy || codeMap[activeId]) return true;
    if(st._isTui!==undefined) return st._isTui;   // 缓存：避免每次按键 join 几万行（卡顿元凶）
    // 只看屏幕末尾 60 行即可判断 TUI 输入区（⏵⏵/bypass 在底部），不全量 join
    var all=st.tb.render();
    var tail=all.slice(-60).map(function(r){return r.map(function(s){return s.text;}).join('');}).join('\n');
    st._isTui=/⏵⏵|bypass permissions|to cycle|Enter to confirm|Esc to exit|Enter to continue|Trust this folder/.test(tail);
    return st._isTui;
  }
  var composing=false;
  input.addEventListener('compositionstart',function(){ composing=true; });
  input.addEventListener('compositionend',function(e){
    composing=false;
    var v=input.value||e.data;
    if(isTui()){ sendKeys(v); input.value=''; scrollBottom(); return; }
    if(v.length>typing.length){ sendKeys(v.slice(typing.length)); typing=v; }
    renderTyping(); scrollBottom();
  });
  input.addEventListener('beforeinput',function(e){
    if(e.inputType==='deleteContentBackward'){
      sendKeys('\x7f');
      if(!isTui() && typing.length) typing=typing.slice(0,-1);
      if(!isTui()) renderTyping();
    }
    else if(e.inputType==='deleteContentForward'){ sendKeys('\x1b[3~'); }
  });
  input.addEventListener('input',function(e){
    if(composing || e.isComposing) return;
    var v=input.value;
    if(isTui()){ sendKeys(v); input.value=''; scrollBottom(); return; }  // TUI：直接发，回显到真实输入区
    if(v.length>typing.length){ sendKeys(v.slice(typing.length)); typing=v; renderTyping(); scrollBottom(); }
    else if(v.length<typing.length){ typing=v; renderTyping(); }
  });
  function appendLine(text, cls){
    var d=document.createElement('div');
    d.className='term-line '+(cls||'');
    d.textContent=cleanANSI(text);
    log.appendChild(d);
    scrollBottom();
  }

  // ---- 列表 / 工具栏 / 交互 ----
  function termLabel(t){
    if(t.codebuddy) return t.title || 'codebuddy · 新会话';
    return t.title || ('Terminal '+t.id);
  }
  // 文字一律用 data-* + CSS ::before content 显示（伪元素内容无法被选中/复制）
  function setData(el, name, num){
    el.dataset.name=name||'';
    if(num!=null) el.dataset.num=String(num);
  }
  function renderDrawer(){
    drawer.innerHTML='';
    terms.forEach(function(t){
      var it=document.createElement('div');
      it.className='drawer-item'+(t.id===activeId?' active':'');
      if(t.codebuddy){
        var img=document.createElement('img');
        img.src='./codebuddy.svg'; img.alt=''; img.title=''; img.draggable=false;
        img.style.cssText='width:12px;height:12px;flex:0 0 auto';
        it.appendChild(img);
        var nm=document.createElement('span'); nm.className='d-name'; setData(nm, termLabel(t)); it.appendChild(nm);
        var id=document.createElement('span'); id.className='d-id'; setData(id,'',t.id); it.appendChild(id);
      }else{
        var ci=document.createElement('span'); ci.className='codicon codicon-terminal'; it.appendChild(ci);
        var nm2=document.createElement('span'); nm2.className='d-name'; setData(nm2, termLabel(t)); it.appendChild(nm2);
        var id2=document.createElement('span'); id2.className='d-id'; setData(id2,'',t.id); it.appendChild(id2);
      }
      it.addEventListener('click',function(){ switchTo(t.id); drawer.hidden=true; });
      drawer.appendChild(it);
    });
  }
  function renderPicker(){
    pickerName.textContent='';
    var t=terms.filter(function(x){return x.id===activeId;})[0];
    if(!t){ setData(pickerName,'Terminal'); return; }
    if(t.codebuddy){
      var img=document.createElement('img');
      img.src='./codebuddy.svg'; img.alt=''; img.title=''; img.draggable=false;
      img.style.cssText='width:18px;height:18px;vertical-align:middle;margin-right:2px';
      pickerName.appendChild(img);
    }
    setData(pickerName, termLabel(t));   // 文字走 ::before，不可复制
    // 用 enrich 识别的 codebuddy 标志（比 isTui 关键词更可靠：信任对话框等状态也算 TUI）
    var isTU=!!(t && t.codebuddy);
    $('#btn-up').hidden=!isTU; $('#btn-down').hidden=!isTU;   // 仅 codebuddy 终端显示上下键
    var tk=$('#tui-keys'); if(tk) tk.hidden=!isTU;          // TUI 辅助键条：Esc/⇧Tab/Enter（手机无物理键盘）
  }
  // 右侧窄边栏：一列终端 icon，点击切换；current 高亮
  var railList=$('#rail-list');
  function renderRail(){
    if(!railList) return;
    railList.innerHTML='';
    terms.forEach(function(t){
      var it=document.createElement('div');
      it.className='rail-item'+(t.id===activeId?' active':'');
      // 不设 title（tooltip 长按也会复制）；文字走 data-* + 伪元素
      if(t.codebuddy){
        var img=document.createElement('img');
        img.src='./codebuddy.svg'; img.alt=''; img.title=''; img.draggable=false;
        img.style.cssText='width:12px;height:12px;flex:0 0 auto';
        it.appendChild(img);
        var num=document.createElement('span'); num.className='rail-num'; setData(num,'',t.id); it.appendChild(num);
        var nm=document.createElement('span'); nm.className='rail-name'; setData(nm, termLabel(t)); it.appendChild(nm);
      }else{
        var ci=document.createElement('span'); ci.className='codicon codicon-terminal'; it.appendChild(ci);
        var num2=document.createElement('span'); num2.className='rail-num'; setData(num2,'',t.id); it.appendChild(num2);
        var nm2=document.createElement('span'); nm2.className='rail-name'; setData(nm2, termLabel(t)); it.appendChild(nm2);
      }
      // 长按 500ms 弹出完整标题说明（伪元素 content，不可复制）
      var holdTid=null;
      function showHold(){
        var tip=document.getElementById('rail-tip'); if(!tip) return;
        tip.dataset.name=termLabel(t);
        var r=it.getBoundingClientRect();
        tip.style.top=Math.round(r.top)+'px';
        tip.style.right=Math.round(window.innerWidth-r.left+6)+'px';
        tip.hidden=false;
      }
      function clearHold(){ if(holdTid){clearTimeout(holdTid);holdTid=null;} var tip=document.getElementById('rail-tip'); if(tip) tip.hidden=true; }
      it.addEventListener('touchstart',function(e){ holdTid=setTimeout(showHold,500); },{passive:true});
      it.addEventListener('touchend',clearHold);
      it.addEventListener('touchmove',clearHold,{passive:true});
      it.addEventListener('touchcancel',clearHold);
      it.addEventListener('mouseleave',clearHold);
      it.addEventListener('click',function(){ clearHold(); switchTo(t.id); });
      railList.appendChild(it);
    });
  }
  async function fetchTerms(){
    try{
      var r=await fetch(API+'/cb/api/terminals',{cache:'no-store'});
      var j=await r.json();
      var list=[];
      (j.tabs||[]).forEach(function(tab){ (tab.terminals||[]).forEach(function(t){
        if(t.id==null||t.pid===-1) return;
        list.push({id:t.id,title:t.title||'Terminal '+t.id,ws:t.workspaceId});
      }); });
      // 识别哪个终端在跑 codebuddy，并取会话标题（ai-title / 第一条实质消息）
      try{
        var er=await fetch(API+'/cb/api/enrich',{cache:'no-store'}).then(function(r){return r.json();});
        if(er.ok && er.map){
          codeMap={};
          list.forEach(function(t){
            var e=er.map[t.id];
            if(e && e.codebuddy){
              codeMap[t.id]=true;
              t.codebuddy=true; t.sessionId=e.sessionId;
              // 总是覆盖（空则用空串，让 termLabel 显示"codebuddy · 新会话"），
              // 否则会保留 /usr/bin/zsh / node 这种无意义的终端原始标题
              t.title=e.title||'';
            }
          });
        }
      }catch(e){}
      terms=list;
      renderDrawer(); renderPicker(); renderRail();
      $('#conn-state') && ($('#conn-state').textContent='');
      if(activeId==null && terms.length){
        var m=location.pathname.match(/^\/(\d+)\/?$/);
        var want=m?Number(m[1]):terms[0].id;
        var hit=terms.some(function(t){return t.id===want;});
        switchTo(hit?want:terms[0].id);
      }
      else if(!terms.length) setLog('// 未发现终端，在 code-server 里开一个终端后点 ⟳ 刷新。','sysline');
    }catch(e){ setLog('// 连不上桥：'+e.message,'sysline'); }
  }
  function setLog(text, kind){
    linesEl.innerHTML='';
    var tb=new TermBuffer(80,24);
    tb.write(String(text).replace(/\r/g,''));
    linesEl.innerHTML=tb.toHTML();
    scrollBottom();
  }

  input.addEventListener('keydown',function(e){
    // 只处理回车提交；方向键/Esc 等一律不拦截——它们可能有输入法或 TUI 自己的语义，无法预知
    if(e.isComposing) return;
    if(e.key==='Enter'&&!e.shiftKey){ e.preventDefault(); send(); }
  });
  log.addEventListener('click',function(){ input.focus(); });

  picker.addEventListener('click',function(e){ e.stopPropagation(); menu.hidden=true; drawer.hidden=!drawer.hidden; });
  $('#btn-new').addEventListener('click',async function(){
    var btn=this; btn.disabled=true;
    var creating=$('#creating'); if(creating) creating.hidden=false;   // 灰度缓冲动画出现
    var started=Date.now();
    try{
      var r=await fetch(API+'/cb/api/create',{method:'POST'});
      var j=await r.json();
      if(j.ok && j.newId){ await fetchTerms(); switchTo(j.newId); }
      else appendLine('// 新建失败：'+(j.error||'unknown'),'sysline');
    }catch(e){ appendLine('// 新建失败：'+e.message,'sysline'); }
    finally{
      var wait=Math.max(0, 450-(Date.now()-started));                   // 至少显示450ms，避免一闪而过
      setTimeout(function(){ if(creating) creating.hidden=true; btn.disabled=false; }, wait);
    }
  });
  // ===== 拆分终端（VS Code 核心能力）：新建同 workspace 终端并在右侧 iframe 并排显示 =====
  // 每个 pane 是完整独立的终端视图（自带 PTY 流/输入/渲染），避免把单终端架构改造成多实例状态机。
  var splitState={ active:false, frame:null, id:null };
  var btnSplit=$('#btn-split');
  function updateSplitBtn(){
    if(!btnSplit) return;
    btnSplit.title=splitState.active?'关闭拆分终端':'拆分终端';
    btnSplit.innerHTML='<span class="codicon '+(splitState.active?'codicon-close':'codicon-split-horizontal')+'"></span>';
  }
  function closeSplit(){
    var host=$('#split-host'); if(host){ host.hidden=true; host.innerHTML=''; }
    var dead=splitState.id;   // 关闭拆分 pane 时终止其 PTY，避免残留僵尸终端（VS Code 行为）
    splitState.active=false; splitState.frame=null; splitState.id=null;
    document.body.classList.remove('is-split');
    updateSplitBtn();
    if(dead!=null){ fetch(API+'/cb/api/kill?id='+encodeURIComponent(dead),{method:'POST'}).catch(function(){}); }
  }
  async function toggleSplit(){
    if(splitState.active){ closeSplit(); return; }
    var host=$('#split-host'); if(!host) return;
    // 用桥的 create 在 code-server 真实新建终端（同 workspace），复用与"新建终端"相同的后端路径
    var btn=btnSplit; if(btn) btn.disabled=true;
    try{
      var wid=(terms.filter(function(t){return t.id===activeId;})[0]||{}).ws||'-391a2e43';
      var r=await fetch(API+'/cb/api/create?workspaceId='+encodeURIComponent(wid),{method:'POST'});
      var j=await r.json();
      if(!j.ok||!j.newId){ appendLine('// 拆分失败：'+(j.error||'unknown'),'sysline'); return; }
      splitState.active=true; splitState.id=j.newId;
      host.hidden=false;
      host.innerHTML='<div class="split-sash" title="拖动调整分栏大小"></div>'+
        '<div class="split-pane"><iframe class="split-frame" src="/'+j.newId+'?embed=1" title="拆分终端"></iframe>'+
        '<button class="split-close" title="关闭拆分终端"><span class="codicon codicon-close"></span></button></div>';
      splitState.frame=host.querySelector('.split-frame');
      document.body.classList.add('is-split');
      updateSplitBtn();
      var cb=host.querySelector('.split-close');
      if(cb) cb.addEventListener('click',closeSplit);
      // sash 拖动：调整左右分栏比例（对齐 VS Code 可拖动 sash）
      var sa=host.querySelector('.split-sash'), dragging=false, sx=0, sw=0;
      sa.addEventListener('pointerdown',function(e){ dragging=true; sx=e.clientX; sw=host.getBoundingClientRect().width; sa.setPointerCapture(e.pointerId); e.preventDefault(); });
      window.addEventListener('pointermove',function(e){
        if(!dragging) return;
        var w=Math.max(120,Math.min(innerWidth*0.75, sw-(sx-e.clientX)));
        host.style.width=w+'px';
      });
      window.addEventListener('pointerup',function(){ dragging=false; });
    }catch(e){ appendLine('// 拆分失败：'+e.message,'sysline'); }
    finally{ if(btn) btn.disabled=false; }
  }
  if(btnSplit) btnSplit.addEventListener('click',toggleSplit);
  // 分栏从属模式：隐藏自身 chrome，让出整块区域给终端内容
  if(EMBED){
    document.body.classList.add('embed-terminal');
    ['#terminal-toolbar','#term-rail','#to-bottom','#more-menu','#term-drawer','#tui-keys'].forEach(function(sel){
      var el=$(sel); if(el) el.style.display='none';
    });
    if(log) log.style.paddingRight='0';
  }
  updateSplitBtn();
  // TUI 上下选择：手机键盘没有方向键，点按钮发 ESC[A / ESC[B
  function sendArrow(seq){ if(activeId==null) return; sendKeys(seq); input.focus(); }
  $('#btn-up').addEventListener('click',function(e){ e.stopPropagation(); sendArrow('\x1b[A'); });
  $('#btn-down').addEventListener('click',function(e){ e.stopPropagation(); sendArrow('\x1b[B'); });
  // TUI 辅助键：Esc / Shift+Tab / Enter → 真实 TUI 的退出/切换权限模式/确认
  var tkeySeq={esc:'\x1b', stab:'\x1b[Z', enter:'\r'};
  document.querySelectorAll('.tkey').forEach(function(b){
    b.addEventListener('click',function(e){
      e.stopPropagation();
      sendKeys(tkeySeq[b.dataset.key]||'');   // 不发 input.focus()：避免弹出软键盘遮挡 TUI
      log.scrollTop=log.scrollHeight;
    });
  });
  $('#btn-menu').addEventListener('click',function(e){ e.stopPropagation(); menu.hidden=!menu.hidden; $('#menu-confirm').hidden=true; });
  document.addEventListener('click',function(e){
    if(!menu.hidden && !menu.contains(e.target)){ menu.hidden=true; $('#menu-confirm').hidden=true; }
    if(!drawer.hidden && !drawer.contains(e.target) && e.target!==picker && !picker.contains(e.target)) drawer.hidden=true;
  });
  $('#menu-kill').addEventListener('click',function(e){ e.stopPropagation(); $('#menu-confirm').hidden=false; });
  $('#btn-confirm-kill').addEventListener('click',async function(){
    if(activeId==null) return;
    var id=activeId;
    try{
      await fetch(API+'/cb/api/kill?id='+encodeURIComponent(id),{method:'POST'});
      menu.hidden=true; $('#menu-confirm').hidden=true;
      delete state[id]; activeId=null; await fetchTerms();
      appendLine('// Terminal '+id+' killed','sysline');
    }catch(e){ appendLine('// 删除失败：'+e.message,'sysline'); }
  });
  $('#btn-cancel-kill').addEventListener('click',function(){ $('#menu-confirm').hidden=true; });
  $('#btn-close').addEventListener('click',function(){ drawer.hidden=true; menu.hidden=true; });
  // 右侧窄边栏收起/展开
  var rail=$('#term-rail');

  // sash：拖动边缘调整右侧栏宽度（仿 VS Code sash，按住显示蓝色线）
  var sash=$('#rail-sash');
  if(sash){
    var dragging=false, startX=0, startW=56, expandedW=56;
    sash.addEventListener('dragstart',function(e){ e.preventDefault(); });
    sash.addEventListener('pointerdown',function(e){
      if(rail.classList.contains('collapsed')) return;
      dragging=true; startX=e.clientX; startW=rail.getBoundingClientRect().width;
      sash.classList.add('dragging'); e.preventDefault(); e.stopPropagation();
    });
    // 监听挂 window：rail 变宽时 sash 会移动，挂 sash 会丢事件导致"只能拖一点"
    window.addEventListener('pointermove',function(e){
      if(!dragging) return;
      var w=Math.max(34,Math.min(window.innerWidth*0.7, startW+(startX-e.clientX)));
      expandedW=w; rail.style.width=w+'px';
      rail.classList.toggle('wide', w>63);
      log.style.paddingRight=(w+10)+'px';
    });
    function endDrag(){ if(!dragging) return; dragging=false; sash.classList.remove('dragging'); }
    window.addEventListener('pointerup',endDrag);
    window.addEventListener('pointercancel',endDrag);
    // toggle：收起时清掉 inline width（否则 CSS 的 22px 被覆盖，挡住主体文字）
    $('#rail-toggle').addEventListener('click',function(){
      var col=rail.classList.toggle('collapsed');
      if(col){ rail.style.width=''; log.style.paddingRight='32px'; }
      else { rail.style.width=expandedW+'px'; rail.classList.toggle('wide',expandedW>63); log.style.paddingRight=(expandedW+10)+'px'; }
    },true);
  }

  // v4 裁剪：app 高度固定，终端内容区高度缩到键盘上方（键盘区不显示，靠内部滚动看被遮内容）
  var baseH=window.innerHeight, vv=window.visualViewport;
  function applyKb(){
    var kb=vv?Math.max(0,baseH-vv.height):0;
    var app=document.getElementById('app');
    app.style.height=baseH+'px';
    app.style.transform='none';
    var l=document.getElementById('log');
    l.style.maxHeight=Math.max(80,baseH-kb-38)+'px';
    // 只有用户本来就贴着底部时，键盘弹出才跟随滚到底；上滑看历史时保持位置不动
    if(kb>0 && (l.scrollHeight-l.scrollTop-l.clientHeight)<=80){
      requestAnimationFrame(function(){ l.scrollTop=l.scrollHeight; });
    }
  }
  if(vv){ vv.addEventListener('resize',applyKb); vv.addEventListener('scroll',applyKb); }
  applyKb();

  fetchTerms();
  fetchTimer=setInterval(fetchTerms,15000);
})();

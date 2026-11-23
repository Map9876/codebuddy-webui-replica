/* 资源管理器全屏页面 —— 独立 fs API（不依赖 codebuddy web UI） */
(function(){
'use strict';
var API='', ROOT='/workspace';
var $ = function(id){ return document.getElementById(id); };
var tabs=[];          // [{path,name,content,lines,mode}]
var monacoEditor=null; // 真 Monaco 实例
var showHidden=false; // 显示隐藏文件
var activeTab=null;

function fsApi(path,method,body){
  return fetch(API+'/cb/api/fs/'+path,{method:method||'GET',cache:'no-store',
    headers:body?{'content-type':'application/json'}:undefined,
    body:body?JSON.stringify(body):undefined}).then(function(r){return r.json();});
}
function fsList(path){ return fsApi('list','POST',{path:path}).then(function(j){return j.entries||[];}).catch(function(){return [];}); }
function fsRead(path){ return fsApi('read?path='+encodeURIComponent(path)); }
function fsWrite(path,content){ return fsApi('write','POST',{path:path,content:content}); }
function fsRemove(path){ return fsApi('remove','POST',{path:path}); }
function fsMkdir(path){ return fsApi('mkdir','POST',{path:path}); }
function fsMove(a,b){ return fsApi('move','POST',{source:a,destination:b}); }

// 文件类型彩色图标（真实 CodeBuddy Web UI 的 Devicon 类）
function fileTypeIcon(name){
  var n=(name||'').toLowerCase();
  if(/\.html?$/.test(n)) return '<i class="html5-icon medium-orange fticon"></i>';
  if(/\.css$/.test(n)) return '<i class="css3-icon medium-blue fticon"></i>';
  if(/\.js$/.test(n)) return '<i class="js-icon medium-yellow fticon"></i>';
  if(/\.py$/.test(n)) return '<i class="python-icon medium-blue fticon"></i>';
  if(/\.md$/.test(n)) return '<i class="markdown-icon medium-blue fticon"></i>';
  if(/\.pdf$/.test(n)) return '<i class="pdf-icon medium-red fticon"></i>';
  if(/\.(png|jpg|svg|webp|gif)$/.test(n)) return '<i class="image-icon medium-purple fticon"></i>';
  if(/\.json$/.test(n)) return '<i class="json-icon medium-yellow fticon"></i>';
  return '';
}
function fileIcon(e){
  if(e.type==='directory') return '<span class="ico folder codicon codicon-folder"></span>';
  var ft=fileTypeIcon(e.name);
  if(ft) return ft;
  var n=(e.name||'').toLowerCase();
  if(/\.(txt|yml|yaml|log)$/.test(n)) return '<span class="ico codicon codicon-file-text"></span>';
  if(/\.(ts|go|java|sh)$/.test(n)) return '<span class="ico codicon codicon-file-code"></span>';
  return '<span class="ico codicon codicon-file"></span>';
}
function langOf(name){
  var n=(name||'').toLowerCase();
  if(/\.md$/.test(n)) return 'md';
  if(/\.json$/.test(n)) return 'json';
  if(/\.(yml|yaml)$/.test(n)) return 'yaml';
  if(/\.js$/.test(n)) return 'js';
  if(/\.ts$/.test(n)) return 'ts';
  if(/\.py$/.test(n)) return 'py';
  if(/\.sh$/.test(n)) return 'shell';
  if(/\.go$/.test(n)) return 'go';
  if(/\.(html|htm)$/.test(n)) return 'html';
  if(/\.css$/.test(n)) return 'css';
  if(/\.pdf$/.test(n)) return 'pdf';
  return 'plaintext';
}

// ===== 文件树：懒加载 + 行内删除 =====
function renderTree(path,container,depth,loading){
  if(loading) container.innerHTML='<div class="ft-loading">加载中…</div>';
  fsList(path).then(function(entries){
    container.innerHTML='';
    if(!entries.length){ container.innerHTML='<div class="ft-loading">空目录</div>'; return; }
    if(!showHidden) entries=entries.filter(function(e){return e.name.charAt(0)!=='.';});
    entries.sort(function(a,b){ if(a.type!==b.type) return a.type==='directory'?-1:1; return a.name.localeCompare(b.name); });
    entries.forEach(function(e){
      var row=document.createElement('div'); row.className='ft-row'; row.style.paddingLeft=(depth*12)+'px';
      row.innerHTML='<span class="chev'+(e.type==='directory'?'':' codicon codicon-chevron-right')+'">'+(e.type==='directory'?'▸':'')+'</span>'+
        fileIcon(e)+'<span class="nm"></span><button class="row-act" title="删除"><span class="codicon codicon-trash"></span></button>';
      row.querySelector('.nm').textContent=e.name;
      // 删除按钮
      var del=row.querySelector('.row-act');
      del.addEventListener('click',function(ev){
        ev.stopPropagation();
        if(!confirm('确定删除 '+(e.type==='directory'?'文件夹':'文件')+'「'+e.name+'」？')) return;
        fsRemove(e.path).then(function(j){
          if(j.ok){ row.remove(); closeTabIfOpen(e.path); }
          else alert('删除失败：'+(j.error||'未知'));
        });
      });
      if(e.type==='directory'){
        var sub=null;
        row.addEventListener('click',function(){
          var c=row.querySelector('.chev'); if(c) c.classList.toggle('open');
          if(sub){ sub.hidden=!sub.hidden; return; }
          sub=document.createElement('div');
          row.parentNode.insertBefore(sub,row.nextSibling);
          renderTree(e.path,sub,depth+1,false);
        });
      }else{
        row.addEventListener('click',function(){ openFile(e.path,e.name,row); });
      }
      container.appendChild(row);
    });
  });
}
function closeTabIfOpen(path){
  var i=tabs.findIndex(function(t){return t.path===path;});
  if(i>=0) closeTab(i);
}
function refreshTree(){ renderTree(ROOT,$('file-tree'),0,true); }

// ===== 多标签 =====
var dragIdx=null;
// 标记 tab 脏状态：只更新 tab DOM，不重建编辑器（避免光标/滚动丢失）
function markDirty(t,dirty){
  if(t.dirty===dirty) return;
  t.dirty=dirty;
  renderTabs();
}
function renderTabs(){
  var box=$('tabs'); box.innerHTML='';
  tabs.forEach(function(t,i){
    var el=document.createElement('div');
    el.className='tab'+(t===activeTab?' active':'');
    el.draggable=true;   // 真实 Web UI: editor-tab draggable="true"
    var fti=fileTypeIcon(t.name);
    el.innerHTML=(fti||'<span class="tico codicon codicon-file-code"></span>')+
      '<span class="tname"></span>'+(t.dirty?'<span class="tdirty codicon codicon-circle-filled" title="未保存"></span>':'')+
      '<span class="tclose codicon codicon-close"></span>';
    el.querySelector('.tname').textContent=t.name;
    el.addEventListener('click',function(){ activeTab=t; renderTabs(); renderEditor(); });
    el.querySelector('.tclose').addEventListener('click',function(ev){ ev.stopPropagation(); closeTab(i); });
    // 拖拽重排（HTML5 DnD，对齐真实可拖拽标签）
    el.addEventListener('dragstart',function(ev){ dragIdx=i; ev.dataTransfer.effectAllowed='move'; el.style.opacity='.5'; });
    el.addEventListener('dragend',function(){ el.style.opacity=''; });
    el.addEventListener('dragover',function(ev){ ev.preventDefault(); ev.dataTransfer.dropEffect='move'; el.classList.add('dragover'); });
    el.addEventListener('dragleave',function(){ el.classList.remove('dragover'); });
    el.addEventListener('drop',function(ev){
      ev.preventDefault(); el.classList.remove('dragover');
      if(dragIdx==null||dragIdx===i) return;
      var moved=tabs.splice(dragIdx,1)[0];
      tabs.splice(i,0,moved);
      dragIdx=null; renderTabs();
    });
    box.appendChild(el);
  });
}
function closeTab(i){
  tabs.splice(i,1);
  if(activeTab && tabs.indexOf(activeTab)<0) activeTab=tabs[tabs.length-1]||null;
  renderTabs(); renderEditor();
}
// 手机：点文件后文件列表全屏抽屉收起、文件区从右侧滑入全屏（对齐真实 Web UI 抽屉式弹入）
function showFileOnMobile(){
  if(innerWidth>720) return;
  var ea=document.getElementById('editor-area'); if(ea) ea.classList.add('file-open');
  window.__fileOpenedOnce=true;
  // 文件列表保持在底层（open），内容浮层覆盖其上；关闭浮层直接露出列表
}
function openFile(path,name,row,cb){
  showFileOnMobile();
  // 已打开则聚焦
  var exist=tabs.find(function(t){return t.path===path;});
  if(exist){ activeTab=exist; renderTabs(); renderEditor(); if(cb) cb(); return; }
  $('editor-body').innerHTML='<div class="ft-loading">读取文件…</div>';
  fsRead(path).then(function(j){
    if(!j.ok){ $('editor-body').innerHTML='<div class="ft-error">'+(j.error||'读取失败')+'</div>'; return; }
    if(j.binary){ $('editor-body').innerHTML='<div class="ft-error">二进制文件（'+j.size+' 字节）无法文本预览</div>'; return; }
    var t={path:path,name:name,content:j.content||'',mode:'code'};
    tabs.push(t); activeTab=t;
    document.querySelectorAll('.ft-row').forEach(function(r){r.classList.remove('active');});
    if(row) row.classList.add('active');
    renderTabs(); renderEditor(); if(cb) cb();
  });
}

// ===== 编辑器渲染（代码 / Markdown 预览）=====
function esc(s){ return s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;'); }
function highlight(line,lang){
  // 轻量多语言高亮：按语言分支，配色对齐真实 Web UI Monaco 浅色主题
  var out=esc(line), L=lang||'plaintext';
  // 字符串（引号内）→ 蓝（通用）
  out=out.replace(/(&quot;[^&]*?&quot;|'[^']*?')/g,'<span class="k-str">$1</span>');
  if(L==='html'||L==='md'){
    if(/^\s*(<!--|\*)/.test(line)) return '<span class="k-com">'+out+'</span>';
    out=out.replace(/(&lt;\/?)([\w-]+)/g,'$1<span class="k-tag">$2</span>');
    out=out.replace(/\s([a-zA-Z-]+)(?==)/g,' <span class="k-attr">$1</span>');
  }else if(L==='py'){
    if(/^\s*#/.test(line)) return '<span class="k-com2">'+out+'</span>';
    out=out.replace(/\b(def|class|if|elif|else|for|while|import|from|return|try|except|with|as|in|not|and|or|lambda|yield|pass|None|True|False|self)\b/g,'<span class="k-kw">$1</span>');
  }else if(L==='js'||L==='ts'){
    if(/^\s*\/\//.test(line)) return '<span class="k-com2">'+out+'</span>';
    out=out.replace(/\b(const|let|var|function|return|async|await|if|else|for|while|import|export|from|class|new|this|extends|default)\b/g,'<span class="k-kw">$1</span>');
  }else if(L==='json'){
    out=out.replace(/(&quot;[\w-]+&quot;)(\s*:)/g,'<span class="k-attr">$1</span>$2');
    out=out.replace(/:\s*(\d+)/g,': <span class="k-num">$1</span>');
  }else if(L==='css'){
    out=out.replace(/([.#][\w-]+)\s*\{/g,'<span class="k-tag">$1</span> {');
    out=out.replace(/([\w-]+)(\s*:)/g,'<span class="k-attr">$1</span>$2');
  }else if(L==='shell'){
    if(/^\s*#/.test(line)) return '<span class="k-com2">'+out+'</span>';
  }
  return out;
}
// 按真实 Web UI：canvas minimap 把每行代码画成彩色小条
function drawMinimap(canvas,content){
  if(!canvas) return;
  var lines=content.split('\n');
  var lh=2;                       // 每行缩略高度
  var h=Math.max(120,lines.length*lh);
  canvas.height=h; canvas.style.height=h+'px';
  var x=canvas.getContext('2d');
  if(!x) return;
  x.clearRect(0,0,canvas.width,h);
  lines.forEach(function(line,i){
    var y=i*lh, xx=0;
    // 按 token 粗略上色（与代码高亮同色系）
    var tokens=line.match(/\S+\s*/g)||[];
    tokens.forEach(function(tk){
      var w=Math.min(canvas.width-xx, Math.max(1,tk.length*1.1));
      var color='#c8cdd4';
      if(/^\/\//.test(tk.trim())||/^#/.test(tk.trim())) color='#7a8a7a';
      else if(/^["']/.test(tk.trim())) color='#9aa5d6';
      else if(/^(const|let|var|function|return|if|class|import|export|div|html|body|head)$/.test(tk.trim())) color='#c98a9a';
      else if(/<\/?[\w-]+>?/.test(tk)) color='#8aab8a';
      x.fillStyle=color; x.fillRect(xx,y,w,lh-0.5);
      xx+=w; if(xx>=canvas.width) return;
    });
  });
}
function renderEditor(){
  var body=$('editor-body');
  if(!activeTab){ body.innerHTML='<div class="ed-empty"><div class="ed-empty-logo"><img src="./codebuddy.svg" alt=""></div><div>选择左侧文件开始编辑</div><div class="ed-empty-sub">支持多标签 · 删除 · 下载 · Markdown 预览</div></div>'; return; }
  var t=activeTab;
  if(t.mode==='md'||t.mode==='preview'){
    renderMarkdown(body,t);
    return;
  }
  // 真 Monaco（内核级语法高亮 + 编辑）——从 CodeBuddy Web UI npm 包提取
  if(window.__monacoReady && window.__monaco){
    if(monacoEditor){ try{ monacoEditor.dispose(); }catch(e){} monacoEditor=null; }
    body.innerHTML='<div class="editor-view">'+
      '<div class="breadcrumb"><span>workspace</span><span class="sep">›</span><span id="ed-crumb"></span>'+
        '<span class="ed-actions">'+
          '<button class="ed-act" id="ed-save" title="保存 (Ctrl+S)"><span class="codicon codicon-save"></span></button>'+
          '<button class="ed-act" id="ed-md" title="预览（Markdown / HTML）"><span class="codicon codicon-eye"></span></button>'+
          '<button class="ed-act" id="ed-download" title="下载文件"><span class="codicon codicon-cloud-download"></span></button>'+
        '</span></div>'+
      '<div id="monaco-host" class="monaco-host"></div></div>';
    // 面包屑：workspace › a › b › file，点击文件夹段跳到该文件树
    (function(){
      var crumb=document.getElementById('ed-crumb'); if(!crumb) return;
      crumb.textContent='';
      var rel=t.path.replace(ROOT,'').replace(/^\//,'');
      var parts=rel.split('/');
      parts.forEach(function(part,i){
        if(i>0){ var sep=document.createElement('span'); sep.className='sep'; sep.textContent='›'; crumb.appendChild(sep); }
        var seg=document.createElement('span');
        seg.textContent=part;
        if(i<parts.length-1){
          seg.classList.add('crumb-link');
          seg.title='打开目录 '+part;
          seg.onclick=function(){
            var dir=t.path.split('/').slice(0,t.path.split('/').length-(parts.length-1-i)).join('/');
            ROOT=dir; refreshTree();
            var filesTab=document.getElementById('btn-sidebar'); // 手机端展开侧栏
            if(innerWidth<=720){ var ex=document.getElementById('explorer'); if(ex) ex.classList.add('open'); }
          };
        }
        crumb.appendChild(seg);
      });
    })();
    var lang=langOf(t.name);
    // langOf 返回显示名，转成 Monaco language id
    var mid=({js:'javascript',ts:'typescript',py:'python',md:'markdown',json:'json',html:'html',css:'css',shell:'shell'})[lang]||'plaintext';
    monacoEditor=window.__monaco.create(document.getElementById('monaco-host'),t.content,mid);
    monacoEditor.onDidChangeModelContent(function(){ t.content=monacoEditor.getValue(); markDirty(t,true); });
    $('sb-lang').textContent=lang;
    $('ex-hint').textContent='第 1 行，第 1 列';
    $('sb-lncol').textContent='第 1 行，第 1 列';
    monacoEditor.onDidChangeCursorPosition(function(e){
      var s='第 '+e.position.lineNumber+' 行，第 '+e.position.column+' 列';
      $('sb-lncol').textContent=s; $('ex-hint').textContent=s;
    });
    var saveFn=function(){
      fsWrite(t.path,monacoEditor.getValue()).then(function(j){
        if(!j.ok) alert('保存失败：'+(j.error||''));
        else markDirty(t,false);
      });
    };
    $('ed-save').onclick=saveFn;
    // Ctrl+S：全局 keydown 兜底（Monaco addCommand 的 KeyMod 在此构建未生效）
    var host=document.getElementById('monaco-host');
    if(host && !host._ctrlSBound){
      host._ctrlSBound=true;
      host.addEventListener('keydown',function(ev){
        if((ev.ctrlKey||ev.metaKey) && (ev.key==='s'||ev.key==='S')){
          ev.preventDefault();
          var btn=document.getElementById('ed-save'); if(btn && btn.onclick) btn.onclick();
        }
      },true);
    }
    $('ed-md').onclick=function(){ t.mode=/\.html?$/i.test(t.name)?'preview':'md'; renderEditor(); };
    $('ed-download').onclick=function(){ t.content=monacoEditor.getValue(); download(t); };
    return;
  }
  var html='<div class="editor-view">'+
    '<div class="breadcrumb"><span>workspace</span><span class="sep">›</span><span>'+esc(t.path.replace(ROOT,'').replace(/^\//,''))+'</span>'+
      '<span class="ed-actions">'+
        '<button class="ed-act" id="ed-edit" title="编辑文件"><span class="codicon codicon-edit"></span></button>'+
        '<button class="ed-act" id="ed-md" title="预览（Markdown / HTML）"><span class="codicon codicon-eye"></span></button>'+
        '<button class="ed-act" id="ed-download" title="下载文件"><span class="codicon codicon-cloud-download"></span></button>'+
      '</span></div>'+
    '<div class="code-wrap"><div class="code" id="code">';
  t.content.split('\n').forEach(function(line,i){
    html+='<div class="code-line"><span class="code-ln">'+(i+1)+'</span><span class="code-txt">'+highlight(line,langOf(t.name))+'</span></div>';
  });
  html+='</div><canvas class="minimap" id="minimap" width="80"></canvas></div></div>';
  body.innerHTML=html;
  // 真实 Web UI minimap：canvas 把每行代码按颜色画成小色块（80px 宽）
  drawMinimap($('minimap'),t.content);
  $('sb-lang').textContent=langOf(t.name);
  $('ex-hint').textContent='第 1 行，第 1 列';
  $('sb-lncol').textContent='第 1 行，第 1 列';
  $('code').onclick=function(e){
    var line=e.target.closest('.code-line'); if(!line) return;
    var ln=line.querySelector('.code-ln').textContent;
    $('sb-lncol').textContent='第 '+ln+' 行，第 1 列'; $('ex-hint').textContent='第 '+ln+' 行，第 1 列';
  };
  $('ed-edit').onclick=function(){ editFile(t,body); };
  $('ed-md').onclick=function(){ t.mode='md'; renderEditor(); };
  $('ed-download').onclick=function(){ download(t); };
}
// 编辑态：textarea 可修改文本，保存后回高亮视图
function editFile(t,body){
  body.innerHTML='<div class="editor-view">'+
    '<div class="breadcrumb"><span>workspace</span><span class="sep">›</span><span>'+esc(t.name)+' (编辑)</span>'+
      '<span class="ed-actions">'+
        '<button class="ed-act" id="ed-save" title="保存 (Ctrl+S)"><span class="codicon codicon-save"></span></button>'+
        '<button class="ed-act" id="ed-cancel" title="取消"><span class="codicon codicon-close"></span></button>'+
      '</span></div>'+
    '<textarea id="ed-textarea" class="ed-textarea" spellcheck="false"></textarea></div>';
  var ta=$('ed-textarea');
  ta.value=t.content;
  ta.focus();
  ta.addEventListener('input',function(){ markDirty(t,true); });
  function save(){
    var v=ta.value;
    fsWrite(t.path,v).then(function(j){
      if(j.ok){ t.content=v; markDirty(t,false); drawMinimap($('minimap'),v); renderEditor(); }
      else alert('保存失败：'+(j.error||''));
    });
  }
  $('ed-save').onclick=save;
  $('ed-cancel').onclick=function(){ renderEditor(); };
  ta.addEventListener('keydown',function(e){
    if((e.ctrlKey||e.metaKey)&&e.key==='s'){ e.preventDefault(); save(); }
  });
}
function renderMarkdown(body,t){
  // HTML 预览：iframe srcdoc 渲染（对齐真实 Web UI，支持 HTML 文件）
  if(/\.html?$/i.test(t.name)){
    body.innerHTML='<div class="editor-view"><div class="breadcrumb"><span>workspace</span><span class="sep">›</span><span>'+esc(t.name)+'</span>'+
      '<span class="ed-actions"><button class="ed-act" id="ed-codebtn" title="查看源码"><span class="codicon codicon-code"></span></button>'+
      '<button class="ed-act" id="ed-download2" title="下载 HTML"><span class="codicon codicon-cloud-download"></span></button></span></div>'+
      '<iframe class="html-preview" sandbox="allow-scripts allow-same-origin" srcdoc="'+esc(t.content).replace(/"/g,'&quot;')+'"></iframe></div>';
    $('sb-lang').textContent='html';
    $('ed-codebtn').onclick=function(){ t.mode='code'; renderEditor(); };
    $('ed-download2').onclick=function(){ download(t); };
    return;
  }
  // 极简 Markdown 渲染（标题/粗体/代码/列表/段落），不引入外部库
  var lines=t.content.split('\n'), out=[];
  lines.forEach(function(l){
    if(/^#\s/.test(l)) out.push('<h1>'+esc(l.replace(/^#\s/,''))+'</h1>');
    else if(/^##\s/.test(l)) out.push('<h2>'+esc(l.replace(/^##\s/,''))+'</h2>');
    else if(/^###\s/.test(l)) out.push('<h3>'+esc(l.replace(/^###\s/,''))+'</h3>');
    else if(/^[-*]\s/.test(l)) out.push('<li>'+esc(l.replace(/^[-*]\s/,''))+'</li>');
    else if(/^```/.test(l)) out.push('<pre><code>'+esc(l.replace(/^```/,''))+'</code></pre>');
    else if(!l.trim()) out.push('<br>');
    else out.push('<p>'+esc(l).replace(/\*\*(.+?)\*\*/g,'<strong>$1</strong>')+'</p>');
  });
  body.innerHTML='<div class="editor-view"><div class="breadcrumb"><span>workspace</span><span class="sep">›</span><span>'+esc(t.name)+'</span>'+
    '<span class="ed-actions"><button class="ed-act" id="ed-codebtn" title="查看源码"><span class="codicon codicon-code"></span></button>'+
    '<button class="ed-act" id="ed-download2" title="下载 MD"><span class="codicon codicon-cloud-download"></span></button></span></div>'+
    '<div class="md-preview" style="flex:1;overflow:auto;padding:20px 32px;max-width:800px">'+out.join('')+'</div></div>';
  $('sb-lang').textContent='md';
  $('ed-codebtn').onclick=function(){ t.mode='code'; renderEditor(); };
  $('ed-download2').onclick=function(){ download(t); };
}
function download(t){
  var blob=new Blob([t.content],{type:'text/plain;charset=utf-8'});
  var url=URL.createObjectURL(blob), a=document.createElement('a');
  a.href=url; a.download=t.name+(/(\.md|\.txt|\.json)$/.test(t.name)?'':'.md');  // 非 md 文件以 MD 模式下载
  document.body.appendChild(a); a.click(); a.remove(); URL.revokeObjectURL(url);
}

// ===== 新建文件/文件夹弹层 =====
var pendingCreate=null;
function showModal(title,cb){
  $('modal-title').textContent=title; $('modal-input').value=''; $('new-modal').hidden=false;
  pendingCreate=cb; $('modal-input').focus();
}
$('modal-cancel').onclick=function(){ $('new-modal').hidden=true; pendingCreate=null; };
$('modal-ok').onclick=function(){
  var v=$('modal-input').value.trim(); if(!v||!pendingCreate) return;
  pendingCreate(v); $('new-modal').hidden=true; pendingCreate=null;
};
$('modal-input').addEventListener('keydown',function(e){ if(e.key==='Enter') $('modal-ok').click(); });
$('act-newfile').onclick=function(){ showModal('新建文件',function(n){ fsWrite(ROOT+'/'+n,'').then(function(j){ if(j.ok){ refreshTree(); openFile(ROOT+'/'+n,n); } else alert('失败：'+(j.error||'')); }); }); };
$('act-newfolder').onclick=function(){ showModal('新建文件夹',function(n){ fsMkdir(ROOT+'/'+n).then(function(j){ if(j.ok) refreshTree(); else alert('失败：'+(j.error||'')); }); }); };
$('act-refresh').onclick=refreshTree;
$('act-collapse').onclick=refreshTree;
// 点 WORKSPACE 标题返回根目录（面包屑进子目录后的返回路径）
var secToggle=document.querySelector('.ex-sec-toggle');
if(secToggle) secToggle.onclick=function(){ ROOT='/workspace'; refreshTree(); };
$('act-hidden').onclick=function(){ showHidden=!showHidden; this.style.opacity=showHidden?'1':''; refreshTree(); };
$('act-opendir').onclick=function(){ var p=prompt('打开目录路径', ROOT); if(p) { ROOT=p.replace(/\/$/,''); refreshTree(); } };
$('act-adddir').onclick=function(){ showModal('添加目录（绝对路径）',function(n){ fsMkdir(n).then(function(j){ if(j.ok) refreshTree(); else alert('失败：'+(j.error||'')); }); }); };

// ===== 导航 / 开关 =====
// 在 iframe 内时，点"智能体/回到对话"通知父页切回对话视图；独立打开时直接跳转
function backToChat(){
  if(window.parent!==window){ try{ window.parent.postMessage('cb:back-to-chat','*'); }catch(e){} }
  else location.href='/chat';
}
// 打开文件后标签栏左侧返回箭头：回到文件列表（对齐真实内核）
var btnBackFiles=$('btn-back-files');
if(btnBackFiles) btnBackFiles.addEventListener('click',function(){
  var ea=document.getElementById('editor-area'), ex=document.getElementById('explorer');
  if(ea) ea.classList.remove('file-open');
  if(ex){ ex.classList.remove('collapsed'); ex.classList.add('open'); }
  try{ window.parent.postMessage({type:'cb:panel',fromIframe:true,panel:'files'},'*'); }catch(e){}
});
$('btn-sidebar').onclick=function(){
  if(innerWidth<=720){
    // 手机：toggle——列表展开时点它关闭（露出文件区）；列表收起时点它重新打开
    var ea=document.getElementById('editor-area'), ex=document.getElementById('explorer');
    if(ex && ex.classList.contains('open')){
      ex.classList.remove('open');
      if(ea) ea.classList.add('file-open');
      try{ window.parent.postMessage('cb:file-opened','*'); }catch(e){}
    }else{
      if(ea) ea.classList.remove('file-open');
      if(ex){ ex.classList.remove('collapsed'); ex.classList.add('open'); }
      try{ window.parent.postMessage({type:'cb:panel',fromIframe:true},'*'); }catch(e){}
    }
    return;
  }
  $('explorer').classList.toggle('collapsed'); $('explorer').classList.toggle('open');
};
$('btn-chat').onclick=backToChat;
$('btn-home').onclick=backToChat;
// 终端面板：接真实 shell（id=4）的 history/stream/input，用 xterm-headless 渲染
var tpTermId=4, tpScreen=null, tpInited=false, tpEs=null;
function tpRender(){
  if(!tpScreen) return;
  var box=$('tp-term');
  if(!box) return;
  var atBottom=(box.scrollHeight-box.scrollTop-box.clientHeight)<40;
  var lines=tpScreen.render();
  box.innerHTML='';
  lines.forEach(function(segs){
    var d=document.createElement('div'); d.className='term-line';
    segs.forEach(function(s){
      if(s.__cursor){ var c=document.createElement('span'); c.className='tp-cursor'; d.appendChild(c); return; }
      var sp=document.createElement('span');
      if(s.fg) sp.style.color=s.fg;
      if(s.bg) sp.style.background=s.bg;
      if(s.bold) sp.style.fontWeight='700';
      sp.textContent=s.text; d.appendChild(sp);
    });
    box.appendChild(d);
  });
  if(atBottom) box.scrollTop=box.scrollHeight;
}
function tpInit(){
  if(tpInited) return;
  tpInited=true;
  if(typeof XtermScreen==='undefined'){ $('tp-term').textContent='终端渲染层未加载'; return; }
  tpScreen=new XtermScreen(120,24);
  fetch(API+'/cb/api/history?id='+tpTermId,{cache:'no-store'}).then(function(r){return r.json();}).then(function(j){
    if(!tpScreen) return;
    tpScreen.write(j.data||'',function(){ tpRender(); });
  });
  // SSE 实时流
  try{
    tpEs=new EventSource(API+'/cb/api/stream?id='+tpTermId);
    tpEs.onmessage=function(ev){
      if(!tpScreen) return;
      try{ var o=JSON.parse(ev.data); if(o.data) tpScreen.write(o.data,function(){ tpRender(); }); }catch(e){}
    };
  }catch(e){}
}
// ===== 多分组编辑器：拆分当前视图（VS Code 核心能力）=====
var groupEditors=[];   // 第二组起的 Monaco 实例
function splitEditor(){
  var groups=document.getElementById('groups'); if(!groups) return;
  var n=groups.querySelectorAll('.editor-group').length;
  if(n>=4) return;   // 最多 4 组（对齐 VS Code）
  // sash
  var sash=document.createElement('div'); sash.className='group-sash';
  // 新组
  var g=document.createElement('div'); g.className='editor-group'; g.dataset.g=n;
  var bar=document.createElement('div'); bar.className='tabs-bar';
  var tabsEl=document.createElement('div'); tabsEl.className='tabs';
  var tab=document.createElement('div'); tab.className='tab active';
  tab.innerHTML='<span class="tico codicon codicon-file-code"></span><span class="tname"></span>';
  var name=activeTab?(activeTab.name||'未命名'):'未命名';
  tab.querySelector('.tname').textContent=name;
  tab.title='点击切换到下一个已打开的文件';
  tabsEl.appendChild(tab); bar.appendChild(tabsEl);
  // 每组独立保存按钮（对齐 VS Code 每组完整能力）
  var saveBtn=document.createElement('button'); saveBtn.className='split-btn'; saveBtn.title='保存此组';
  saveBtn.innerHTML='<span class="codicon codicon-save"></span>';
  var closeBtn=document.createElement('button'); closeBtn.className='split-btn'; closeBtn.title='关闭此组';
  closeBtn.innerHTML='<span class="codicon codicon-close"></span>';
  bar.appendChild(saveBtn); bar.appendChild(closeBtn); g.appendChild(bar);
  var body=document.createElement('div'); body.className='editor-body'; g.appendChild(body);
  groups.appendChild(sash); groups.appendChild(g);
  // 独立 Monaco 实例（显示当前文件）
  var content=activeTab?activeTab.content:'';
  var lang=langOf(activeTab?activeTab.name:'');
  var mid=({js:'javascript',ts:'typescript',py:'python',md:'markdown',json:'json',html:'html',css:'css',shell:'shell'})[lang]||'plaintext';
  var ed=null;
  var groupDirty=false;
  if(window.__monacoReady && window.__monaco){
    ed=window.__monaco.create(body,content,mid);
    groupEditors.push(ed);
  }else{
    body.innerHTML='<div style="padding:14px;color:var(--fg-muted)">'+esc(content.slice(0,500))+'</div>';
  }
  // 组内独立文件状态：组有自己的当前文件，切换不影响其它组（对齐 VS Code editor group）
  var curPath=activeTab?activeTab.path:null;
  var curName=activeTab?activeTab.name:null;
  function updateTab(){
    var tn=tab.querySelector('.tname'); if(tn) tn.textContent=curName||'未命名';
    var old=tab.querySelector('.tdirty'); if(old) old.remove();
    if(groupDirty){ var d=document.createElement('span'); d.className='tdirty codicon codicon-circle-filled'; d.title='未保存'; tab.insertBefore(d,tab.querySelector('.tclose')); }
  }
  // 点 tab：在全局已打开的文件间循环切换（让新组能显示不同文件，而非只读副本）
  var switching=false;   // 程序 setValue 时的 content change 不算用户编辑
  tab.addEventListener('click',function(){
    if(!tabs.length || !ed) return;
    var idx=tabs.findIndex(function(t){return t.path===curPath;});
    var next=tabs[(idx+1)%tabs.length];
    if(!next) return;
    curPath=next.path; curName=next.name; groupDirty=false;
    switching=true;
    var m=({js:'javascript',ts:'typescript',py:'python',md:'markdown',json:'json',html:'html',css:'css'})[langOf(next.name)]||'plaintext';
    try{ ed.setValue(next.content||''); }catch(e){}
    try{ var mo=ed.getModel(); if(mo && window.__monaco.editor.setModelLanguage) window.__monaco.editor.setModelLanguage(mo,m); }catch(e){}
    switching=false;
    updateTab();
  });
  if(ed) ed.onDidChangeModelContent(function(){ if(!switching){ groupDirty=true; updateTab(); } });
  saveBtn.onclick=function(){
    if(!curPath||!ed) return;
    fsWrite(curPath,ed.getValue()).then(function(j){ if(!j.ok) alert('保存失败：'+(j.error||'')); else { groupDirty=false; updateTab(); } });
  };
  // 关闭此组：销毁 Monaco + 移除组与相邻 sash
  closeBtn.onclick=function(){
    if(ed){ try{ ed.dispose(); }catch(e){} var ei=groupEditors.indexOf(ed); if(ei>=0) groupEditors.splice(ei,1); }
    if(sash.parentNode) sash.parentNode.removeChild(sash);
    if(g.parentNode) g.parentNode.removeChild(g);
  };
  // sash 拖动调宽度
  (function(sa,grp){
    var drag=false, sx=0, sw=0;
    sa.addEventListener('pointerdown',function(e){ drag=true; sx=e.clientX; sw=grp.getBoundingClientRect().width; sa.classList.add('dragging'); sa.setPointerCapture(e.pointerId); e.preventDefault(); });
    window.addEventListener('pointermove',function(e){ if(!drag)return; var w=Math.max(120,Math.min(innerWidth-200, sw+(sx-e.clientX))); grp.style.flex='0 0 '+w+'px'; });
    window.addEventListener('pointerup',function(){ if(!drag)return; drag=false; sa.classList.remove('dragging'); });
  })(sash,g);
}
var btnSplit=document.getElementById('btn-split');
if(btnSplit) btnSplit.onclick=splitEditor;
$('btn-terminal-toggle').onclick=function(){
  var p=$('terminal-panel'); p.hidden=!p.hidden;
  if(!p.hidden){ tpInit(); var inp=$('tp-input'); if(inp) inp.focus(); }
};
$('tp-close').onclick=function(){ $('terminal-panel').hidden=true; };
var tpInput=$('tp-input');
if(tpInput) tpInput.addEventListener('keydown',function(e){
  if(e.key==='Enter'){
    var v=this.value; this.value='';
    if(v){ fetch(API+'/cb/api/input?id='+tpTermId,{method:'POST',body:v+'\r'}).catch(function(){}); }
  }
});
document.querySelectorAll('.rail-btn').forEach(function(b){
  b.addEventListener('click',function(){
    var v=b.dataset.view;
    if(v==='editor') return;
    if(v==='agents'||v==='dashboard'){ backToChat(); return; }
    // 其它视图暂未实现
  });
});

// 真实 git status 填 SCM 面板（替代假数据）
function loadScm(){
  fetch(API+'/cb/api/git/status',{cache:'no-store'}).then(function(r){return r.json();}).then(function(j){
    var list=$('ex-scm-list'); if(!list) return;
    list.innerHTML='';
    var sections=$('explorer').querySelectorAll('.ex-scm .ex-section');
    if(sections[0]) sections[0].textContent='更改 ('+(j.count||0)+')';
    var badge=document.querySelector('.side-tab[data-panel="scm"] .side-badge');
    if(badge) badge.textContent=j.count||0;
    (j.changes||[]).forEach(function(c){
      var d=document.createElement('div'); d.className='ex-scm-item';
      d.innerHTML='<span class="codicon codicon-'+ (c.status==='M'?'diff-modified':(c.status==='?'?'file':'file-add')) +'"></span> ';
      d.appendChild(document.createTextNode(c.path));
      d.title=c.status+' '+c.path;
      d.addEventListener('click',function(){ openFile('/workspace/'+c.path,c.path.split('/').pop()); });
      list.appendChild(d);
    });
  }).catch(function(){});
}
loadScm();

// 全局快速打开 Ctrl+P（对齐真实 Web UI）
var qrBox=null, qrSel=0, qrItems=[];
function showQuickResults(){
  if(!qrBox){ qrBox=document.createElement('div'); qrBox.className='quick-results'; qrBox.hidden=true; document.body.appendChild(qrBox); }
  var inp=document.getElementById('top-search'), q=inp?inp.value.trim():'';
  if(!q){ qrBox.hidden=true; return; }
  fsApi('search?query='+encodeURIComponent(q)+'&limit=30').then(function(j){
    qrItems=(j.results||[]).filter(function(r){return r.type==='file';});
    qrSel=0; qrBox.innerHTML='';
    qrItems.forEach(function(r,i){
      var d=document.createElement('div'); d.className='qr-item'+(i===0?' sel':'');
      d.innerHTML='<span class="codicon codicon-file-code"></span><span class="qr-name"></span><span class="qr-path"></span>';
      d.querySelector('.qr-name').textContent=r.name||r.path.split('/').pop();
      d.querySelector('.qr-path').textContent=(r.path||'').replace(ROOT,'');
      d.addEventListener('click',function(){ openFile(r.path,r.name||r.path.split('/').pop()); qrBox.hidden=true; });
      qrBox.appendChild(d);
    });
    if(!qrItems.length) qrBox.innerHTML='<div class="qr-item" style="color:var(--fg-muted)">无匹配文件</div>';
    qrBox.hidden=false;
  });
}
var topSearch=document.getElementById('top-search');
if(topSearch){
  topSearch.addEventListener('input',showQuickResults);
  topSearch.addEventListener('keydown',function(e){
    if(e.key==='Escape'){ this.value=''; if(qrBox) qrBox.hidden=true; this.blur(); }
    else if(e.key==='Enter' && qrItems[qrSel]){ qrItems[qrSel] && openFile(qrItems[qrSel].path,qrItems[qrSel].name); if(qrBox) qrBox.hidden=true; }
    else if(e.key==='ArrowDown'){ e.preventDefault(); qrSel=Math.min(qrItems.length-1,qrSel+1); updateQrSel(); }
    else if(e.key==='ArrowUp'){ e.preventDefault(); qrSel=Math.max(0,qrSel-1); updateQrSel(); }
  });
}
function updateQrSel(){ if(qrBox) [...qrBox.querySelectorAll('.qr-item')].forEach(function(d,i){ d.classList.toggle('sel',i===qrSel); }); }
document.addEventListener('keydown',function(e){
  if((e.ctrlKey||e.metaKey)&&e.key==='p'){ e.preventDefault(); var t=document.getElementById('top-search'); if(t){t.focus();t.select();} }
});

// 接收父页面 rail 的面板切换指令
window.addEventListener('message',function(e){
  if(e.data && e.data.type==='cb:open-explorer'){
    var ex=document.getElementById('explorer');
    if(ex){ ex.dataset.panel='files'; if(innerWidth<=720) ex.classList.add('open'); }
    return;
  }
  if(e.data && e.data.type==='cb:panel'){
    var p=e.data.panel, ex=document.getElementById('explorer');
    if(ex){ ex.dataset.panel=p; if(innerWidth<=720){ ex.classList.add('open'); var eaP=document.getElementById('editor-area'); if(eaP) eaP.classList.remove('file-open'); } }
    // 面板互斥：切到 terminal 打开终端，其它面板关闭终端（每个按钮都生效）
    var tp=document.getElementById('terminal-panel');
    if(p==='terminal'){ if(tp&&tp.hidden){tp.hidden=false;tpInit();} }
    else if(tp){ tp.hidden=true; if(typeof tpEs!=='undefined'&&tpEs){ try{tpEs.close();}catch(e){} tpEs=null; } }
    // 对齐真实 Web UI：切到搜索面板自动聚焦输入框（用户点了搜索 tab 就能直接打字）
    if(p==='search'){ var inp=document.getElementById('ex-search-input'); if(inp) inp.focus(); }
  }
  // 再次点同一个入口 → 收起侧栏列表，露出当前文件（对齐 VS Code：点活动项收起面板）
  if(e.data && e.data.type==='cb:panel-toggle'){
    var ex2=document.getElementById('explorer'), ea2=document.getElementById('editor-area');
    if(ex2) ex2.classList.remove('open');
    // 打开过文件 → 收起列表后露出文件区（file-open）；否则保持列表态
    if(ea2 && window.__fileOpenedOnce) ea2.classList.add('file-open');
  }
});
// 侧栏 tab 切换（资源管理器/搜索/SCM/终端）
document.querySelectorAll('.side-tab').forEach(function(b){
  b.addEventListener('click',function(){
    var panel=b.dataset.panel;
    document.querySelectorAll('.side-tab').forEach(function(x){x.classList.remove('active');});
    b.classList.add('active');
    var ex=document.getElementById('explorer'); ex.dataset.panel=panel;
    // 面板互斥：terminal 打开终端，其它面板关闭终端
    var tp=document.getElementById('terminal-panel');
    if(panel==='terminal'){ if(tp && tp.hidden){ tp.hidden=false; tpInit(); } }
    else if(tp){ tp.hidden=true; if(typeof tpEs!=='undefined'&&tpEs){ try{tpEs.close();}catch(e){} tpEs=null; } }
    document.getElementById('ex-title-files')?.remove();
    // 手机端切换面板时展开侧栏
    if(innerWidth<=720) ex.classList.add('open');
    if(panel==='search'){
      var inp=document.getElementById('ex-search-input'); if(inp) inp.focus();
    }
  });
});
// 搜索面板：对齐真实 VS Code —— 默认"在文件中搜索"（全文内容搜索），文件名搜索作为补充
var exSearch=$('ex-search-input');
var exSearchSeq=0;   // 请求序号：防止旧请求覆盖新结果（快速输入时）
function doExSearch(q){
  var box=$('ex-search-results');
  if(!q){ box.innerHTML=''; return; }
  var seq=++exSearchSeq;
  box.innerHTML='<div class="ft-loading">搜索中…</div>';
  // 用桥的异步 grep API：grep -rn 全文搜索，已排除 node_modules/.git 等大目录，6s 超时
  var url=API+'/cb/api/fs/grep?query='+encodeURIComponent(q);
  fetch(url,{cache:'no-store'}).then(function(r){return r.json();}).then(function(j){
    if(seq!==exSearchSeq) return;   // 已被更新的输入取代，丢弃旧结果
    box.innerHTML='';
    var results=j.results||[];
    if(!results.length){ box.innerHTML='<div class="ft-loading">无结果</div>'; return; }
    // 按文件分组统计（对齐 VS Code "N results in M files"）
    var files={}; results.forEach(function(r){ files[r.file]=1; });
    var hdr=document.createElement('div'); hdr.className='sr-summary';
    hdr.textContent=results.length+' 个结果，'+Object.keys(files).length+' 个文件';
    box.appendChild(hdr);
    results.forEach(function(r){
      var d=document.createElement('div'); d.className='sr sr-content';
      var f=document.createElement('span'); f.className='sr-file'; f.textContent=(r.file||'').replace(ROOT+'/',''); f.title=r.file;
      var ln=document.createElement('span'); ln.className='sr-line'; ln.textContent=r.line||'';
      var tx=document.createElement('span'); tx.className='sr-text'; tx.textContent=r.text||'';
      d.appendChild(f); d.appendChild(ln); d.appendChild(tx);
      d.title=r.file+':' +r.line;
      d.addEventListener('click',function(){
        // 打开文件并定位到命中行：openFile 后滚到对应行
        openFile(r.file,r.file.split('/').pop(),null,function(){
          var host=$('monaco-host'), editorBody=$('editor-body');
          // Monaco 模式：用 revealLineInCenter；降级高亮模式：滚到对应 .ed-line
          if(window.__monacoReady && monacoEditor && monacoEditor.revealLineInCenter){
            monacoEditor.revealLineInCenter(r.line); monacoEditor.setPosition({lineNumber:r.line,column:1});
          }else if(editorBody){
            var lines=editorBody.querySelectorAll('.ed-line');
            if(lines[r.line-1]) lines[r.line-1].scrollIntoView({block:'center'});
          }
        });
      });
      box.appendChild(d);
    });
  }).catch(function(){
    if(seq!==exSearchSeq) return;
    box.innerHTML='<div class="ft-loading">搜索失败</div>';
  });
}
// 搜索输入防抖：避免每敲一个字就 grep 一次
var exSearchTimer=null;
if(exSearch) exSearch.addEventListener('input',function(){
  var v=this.value.trim();
  clearTimeout(exSearchTimer);
  exSearchTimer=setTimeout(function(){ doExSearch(v); },200);
});

refreshTree();
})();

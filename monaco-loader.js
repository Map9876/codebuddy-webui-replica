/* Monaco ESM loader —— 加载内核 + 手动注册语言 tokenizer，挂到 window.__monaco */
import * as M from './monaco/editor.api2-CdxXemhu.js';

var editor=M.p, languages=M.h, core=M.m;
var registered={};

// 语言 conf/language 定义（来自 CodeBuddy Web UI 的 Monarch chunk）
var defs={};
var langChunks={
  python:'python-EIL9M2bl',javascript:'javascript-B7xbQhF8',typescript:'typescript-DVVhSeLw',
  css:'css-DIMkf-bt',html:'html-C26_S8V7',markdown:'markdown-Cimd5fb3',shell:'shell-CC2rA5mh',
  yaml:'yaml-BJYL-SKO',sql:'sql-NEE52Syq',go:'go-C-y9NEjX',java:'java-BEtHBSE6',
  rust:'rust-DdL9SqIa',xml:'xml-B__rTQhy'
};
for(var lid in langChunks){
  try{ var d=await import('./monaco/'+langChunks[lid]+'.js'); defs[lid]=d; }catch(e){}
}
defs.js=defs.javascript; defs.ts=defs.typescript; defs.yml=defs.yaml; defs.sh=defs.shell;
// json 用内联 Monarch tokenizer（避免 jsonMode chunk 的 worker 依赖链）
defs.json={
  conf:{comments:{lineComment:'//'},brackets:[['{','}'],['[',']']],autoClosingPairs:[{open:'{',close:'}'},{open:'[',close:']'},{open:'"',close:'"'}]},
  language:{
    defaultToken:'',
    tokenizer:{root:[
      [/\s+/,'white'],
      [/"(?:[^"\\]|\\.)*"(?=\s*:)/,'type.identifier','@string'],   // key
      [/"(?:[^"\\]|\\.)*"/,'string'],                              // string value
      [/-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/,'number'],
      [/\b(?:true|false|null)\b/,'keyword'],
      [/[{}[\],:]/,'delimiter'],
      [/\/\/[^\n]*/,'comment']
    ]}
  }
};

function ensureLang(lang){
  if(registered[lang]) return;
  var d=defs[lang];
  if(!d || !d.language){ return; }
  try{
    try{ languages.register({id:lang}); }catch(e){}
    if(d.conf) languages.setLanguageConfiguration(lang,d.conf);
    languages.setMonarchTokensProvider(lang,d.language);
    registered[lang]=true;
  }catch(e){}
}

window.__monaco={
  editor:editor, languages:languages, core:core,
  ensureLang:ensureLang,
  // 创建/复用 editor 实例
  create:function(el,value,lang){
    ensureLang(lang);
    var e=editor.create(el,{
      value:value||'', language:lang||'plaintext', theme:'cb-light',
      fontSize:13, lineHeight:20, automaticLayout:true, minimap:{enabled:false},
      scrollBeyondLastLine:false, renderLineHighlight:'line', wordWrap:'off',
      padding:{top:6,bottom:6}, fontFamily:'SFMono-Regular,Consolas,monospace',
      folding:true, bracketPairColorization:{enabled:true}
    });
    return e;
  },
  // 主题：对齐真实 Web UI 浅色
  defineTheme:function(){
    try{
      // 配色提取自真实 CodeBuddy Web UI 的 Monaco 主题（mtk 类计算样式）
      editor.defineTheme('cb-light',{
        base:'vs',inherit:true,
        rules:[
          {token:'comment',foreground:'008000'},        // mtk8 rgb(0,128,0)
          {token:'string',foreground:'0000FF'},         // mtk6 rgb(0,0,255)
          {token:'keyword',foreground:'0000FF'},        // mtk6
          {token:'number',foreground:'0000CD'},
          {token:'tag',foreground:'800000'},            // mtk14 rgb(128,0,0)
          {token:'attribute.name',foreground:'FF0000'}, // mtk4 rgb(255,0,0)
          {token:'delimiter',foreground:'383838'},      // mtk10 rgb(56,56,56)
          {token:'type.identifier',foreground:'FF0000'},
          {token:'identifier',foreground:'000000'}
        ],
        colors:{'editor.background':'#ffffff','editorLineNumber.foreground':'#a0a6af',
          'editor.lineHighlightBackground':'#f7f8fa','editorCursor.foreground':'#000000'}
      });
    }catch(e){}
  }
};
window.__monaco.defineTheme();
window.__monacoReady=true;

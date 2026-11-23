/* ============================================================================
 * xterm-render.js —— 用 VS Code 同款 @xterm/headless 做终端协议层
 * 提供 XtermScreen 类：write(ansi) 写入字节流，render() 输出结构化行（含颜色）。
 * 用 headless 的原生 scrollback 维护历史（scrollback:5000），不再手动累积——
 * 手动累积会把 zsh 原地重绘的旧输入行当成"滚出的历史"push 进去，造成重复/错乱。
 * ==========================================================================*/
(function(global){
  'use strict';
  var T = (global.exports && global.exports.Terminal) || global.Terminal;
  if(!T){ console.error('[xterm-render] headless Terminal not loaded'); }

  function lineToSegs(line){
    if(!line) return [];
    var segs=[];
    var n=line.length;
    for(var x=0;x<n;x++){
      var cell=line.getCell(x);
      if(!cell) continue;
      var ch=cell.getChars();
      if(ch==='') continue;          // 宽字符第二格占位，跳过
      if(ch==null) ch=' ';
      var fg=cell.getFgColor(), bg=cell.getBgColor();
      var fgCss=colorToCss(fg, cell.isFgRGB()), bgCss=colorToCss(bg, cell.isBgRGB());
      var flags=[cell.isBold(),cell.isDim(),cell.isItalic(),cell.isUnderline(),cell.isBlink(),cell.isInverse(),cell.isStrikethrough()].join('|');
      var last=segs[segs.length-1];
      if(last && last._fg===fgCss && last._bg===bgCss && last._flags===flags){
        last.text+=ch;
      }else{
        segs.push({text:ch,fg:fgCss,bg:bgCss,bold:cell.isBold(),dim:cell.isDim(),italic:cell.isItalic(),underline:cell.isUnderline(),reverse:cell.isInverse(),strike:cell.isStrikethrough(),_fg:fgCss,_bg:bgCss,_flags:flags});
      }
    }
    return segs;
  }
  function colorToCss(color, isRGB){
    if(color==null) return null;
    if(isRGB){
      var r=(color>>16)&255, g=(color>>8)&255, b=color&255;
      return 'rgb('+r+','+g+','+b+')';
    }
    var palette=['#000000','#cd3131','#107C10','#949800','#0451a5','#bc05bc','#0598bc','#555555',
      '#666666','#cd3131','#14CE14','#b5ba00','#0451a5','#bc05bc','#0598bc','#a5a5a5'];
    if(color<16) return palette[color];
    if(color<232){ var c=color-16, v=x=>x?55+x*40:0; return 'rgb('+v(Math.floor(c/36))+','+v(Math.floor((c%36)/6))+','+v(c%6)+')'; }
    var v1=8+(color-232)*10; return 'rgb('+v1+','+v1+','+v1+')';
  }

  function XtermScreen(cols, rows, screenOnly){
    this.cols=cols||120; this.rows=rows||40; this.screenOnly=!!screenOnly;
    this.term=new T({cols:this.cols,rows:this.rows,allowProposedApi:true,scrollback:5000});
    this.lines=[];
  }
  XtermScreen.prototype.write=function(data,cb){
    if(!data){ if(cb)cb(); return; }
    var self=this;
    this.term.write(data, function(){ self._sync(); if(cb)cb(); });
  };
  XtermScreen.prototype._sync=function(){
    var buf=this.term.buffer.active;
    var total=buf.length;                 // 含 scrollback 的总行数
    var base=buf.viewportY;               // 视口在 buffer 中的起始行
    var lines=[];
    // TUI（codebuddy）只读当前屏幕：TUI 全屏重绘会把每帧存进 scrollback，
    // 读全部行会把同一界面显示多遍。普通 shell 读全部行（scrollback 有价值）。
    if(this.screenOnly){
      for(var y=base;y<Math.min(total,base+this.rows);y++) lines.push(lineToSegs(buf.getLine(y)));
    }else{
      for(var y=0;y<total;y++) lines.push(lineToSegs(buf.getLine(y)));
    }
    // 去尾部空行
    while(lines.length && !textOf(lines[lines.length-1]).trim()) lines.pop();
    // 光标：绝对行 = viewportY + cursorY，列 = cursorX
    var cx=buf.cursorX, cy=base+buf.cursorY;
    if(cy>=0 && cy<lines.length && lines[cy]){
      var line=lines[cy];
      // 避免已有光标块时重复插入：先清掉旧的
      for(var i=line.length-1;i>=0;i--) if(line[i]&&line[i].__cursor) line.splice(i,1);
      if(cx<=line.length) line.splice(cx,0,{text:'',fg:null,bg:'#202020',bold:false,dim:false,italic:false,underline:false,reverse:false,strike:false,__cursor:true});
    }
    this.lines=lines;
  };
  XtermScreen.prototype.render=function(){ return this.lines; };
  XtermScreen.prototype.cursor=function(){
    var b=this.term.buffer.active;
    return {x:b.cursorX, y:b.viewportY+b.cursorY};
  };
  function textOf(segs){ var t=''; for(var i=0;i<segs.length;i++) t+=segs[i].text; return t; }

  global.XtermScreen=XtermScreen;
  global.xtermLineToSegs=lineToSegs;
})(window);

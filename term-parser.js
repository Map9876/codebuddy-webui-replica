/* ============================================================================
 * term-parser.js —— 终端协议 → Web DOM 的"协议转换器"（pdf.js 模式）
 *
 * 不渲染成终端外观；而是解析终端字节流里的控制序列（ANSI/VT100），
 * 维护一个字符网格（每格带颜色/属性），输出结构化"行"给 app.js 渲染成
 * 朴素 chat 风格 DOM。类似 pdf.js 解析 PDF 指令再画网页。
 *
 * 支持的序列（覆盖 codebuddy / zsh / TUI 常见）：
 *   SGR 颜色: \x1b[30-37/90-97/40-47/100-107m, \x1b[38;5;Nm, \x1b[38;2;r;g;bm, 1/3/4/7/9/22/23/24/27/39/49/0
 *   光标:     \x1b[A/B/C/D/E/F/G/H/f, \x1b[s/u, \x1b[6n(忽略)
 *   擦除:     \x1b[J/K (0/1/2)
 *   模式:     \x1b[?25l/h, \x1b[?1049/47h/l (忽略, 仅切屏分辨率)
 *   OSC:      \x1b]...\x07 / \x1b]...\x1b\ (标题等, 忽略)
 *   控制:     \r \n \b \t \x0b \x0c
 * 全局导出 window.TermBuffer
 * ==========================================================================*/
(function(global){
  'use strict';

  // VS Code 2026-light ANSI 色（terminalColorRegistry.ts light defaults）
  const ANSI = {
    black:'#000000', red:'#cd3131', green:'#107C10', yellow:'#949800',
    blue:'#0451a5', magenta:'#bc05bc', cyan:'#0598bc', white:'#555555',
    brightBlack:'#666666', brightRed:'#cd3131', brightGreen:'#14CE14', brightYellow:'#b5ba00',
    brightBlue:'#0451a5', brightMagenta:'#bc05bc', brightCyan:'#0598bc', brightWhite:'#a5a5a5'
  };
  const ANSI_SEQ = ['black','red','green','yellow','blue','magenta','cyan','white',
                    'brightBlack','brightRed','brightGreen','brightYellow','brightBlue','brightMagenta','brightCyan','brightWhite'];
  const DEFAULT_FG = '#202020', DEFAULT_BG = '#fafafd';

  // 终端 cell 宽度：东亚全角/中文占2列（xterm wcwidth 语义）
  function charWidth(c){
    const code=c.codePointAt(0);
    if(code===0) return 0;
    if(code<32 || (code>=0x7f && code<0xa0)) return 0;
    // 组合字符/变音符占0列
    if((code>=0x300&&code<=0x36f)||(code>=0x1ab0&&code<=0x1aff)||(code>=0x1dc0&&code<=0x1dff)||(code>=0x20d0&&code<=0x20ff)||(code>=0xfe20&&code<=0xfe2f)) return 0;
    // 宽字符区间（CJK/全角/emoji）
    if((code>=0x1100&&code<=0x115f)||(code>=0x2e80&&code<=0xa4cf)||(code>=0xac00&&code<=0xd7a3)||
       (code>=0xf900&&code<=0xfaff)||(code>=0xfe10&&code<=0xfe19)||(code>=0xfe30&&code<=0xfe6f)||
       (code>=0xff00&&code<=0xff60)||(code>=0xffe0&&code<=0xffe6)||(code>=0x1f300&&code<=0x1faff)||
       (code>=0x20000&&code<=0x3fffd)) return 2;
    return 1;
  }
  function emptyCell(){ return { ch:' ', fg:null, bg:null, bold:false, dim:false, italic:false, underline:false, reverse:false, strike:false }; }

  class TermBuffer {
    constructor(cols, rows){
      this.cols = Math.max(4, cols||80);
      this.rows = Math.max(4, rows||24);
      this.reset();
    }
    reset(){
      this.lines = [];                 // 视口行（最多 rows 行）
      this.scrollback = [];            // 滚出视口的历史行（原版 xterm scrollback）
      this.maxScrollback = 5000;       // 可翻历史行数（原版默认1000，这里放大以覆盖长会话）
      this._newLine();
      this.cx = 0; this.cy = 0;
      this.attr = { fg:null, bg:null, bold:false, dim:false, italic:false, underline:false, reverse:false, strike:false };
      this.saved = null;
      this._state = 'ground';
      this._buf = '';
      this._csiPrivate = false;
    }
    _newLine(){ this.lines.push([]); }
    _cur(){ return this.lines[this.cy] || (this.lines[this.cy]=[]); }
    _ensureLine(y){ while(this.lines.length <= y) this.lines.push([]); }
    _setCell(x, y, cell){
      this._ensureLine(y);
      const line = this.lines[y];
      const a = Object.assign({}, this.attr);
      line[x] = Object.assign(cell, a);
    }
    _scrollUp(){
      // 视口溢出：最老的行移入 scrollback（xterm scrollback 机制）
      if(this.lines.length > this.rows){
        this.scrollback.push(this.lines.shift());
        if(this.scrollback.length > this.maxScrollback) this.scrollback.shift();
        this.cy = this.rows - 1;
      }
    }
    _wrap(){
      this.cx = 0; this.cy++;
      this._ensureLine(this.cy);
      this._scrollUp();
    }

    write(data){
      if(!data) return;
      const s = String(data);
      for(let i=0;i<s.length;i++){
        const c = s[i], code = s.charCodeAt(i);
        switch(this._state){
          case 'ground':
            if(c === '\x1b'){ this._state='esc'; this._buf=''; this._csiPrivate=false; }
            else if(code === 13) this.cx=0;                       // CR
            else if(code === 10){ this._wrap(); }                 // LF
            else if(code === 8) this.cx=Math.max(0,this.cx-1);    // BS（逐列，zsh 重绘会发多个）
            else if(code === 9){ this.cx = Math.floor(this.cx/8)*8+8; } // TAB
            else if(code === 11 || code === 12){ /* VT/FF 忽略 */ }
            else if(code >= 32){
              // 计算字符宽度：中文/全角占2列（终端 cell 语义），否则1列。
              // zsh syntax highlighting 重绘输入行时按列宽算光标，宽度错了会错位重复。
              var w=charWidth(c);
              if(this.cx + w > this.cols) this._wrap();
              this._setCell(this.cx, this.cy, {ch:c});
              // 宽字符：第一个 cell 放字，后续 cell 标记占位（__wide=1），避免被当独立字符
              for(var k=1;k<w;k++) this._setCell(this.cx+k, this.cy, {ch:'',__wide:1});
              this.cx += w;
            }
            break;
          case 'esc':
            if(c === '['){ this._state='csi'; this._buf=''; }
            else if(c === ']'){ this._state='osc'; this._buf=''; }
            else if(c === 'P'||c==='X'||c==='^'||c==='_'){ this._state='str'; this._buf=''; }
            else { this._state='ground'; } // ESC c / ESC 7 / ESC 8 等单字符忽略
            break;
          case 'csi':
            if(c === '?' || c === '>' || c === '<' || c === '!'){ this._csiPrivate=true; this._buf+=c; }
            else if((code>=0x40 && code<=0x7e)){ this._csi(c, this._buf); this._state='ground'; this._buf=''; }
            else this._buf += c;
            break;
          case 'osc':
            if(c === '\x07'){ this._state='ground'; }                    // BEL
            else if(c === '\x1b'){ this._oscEsc=true; }
            else if(this._oscEsc && c === '\\'){ this._oscEsc=false; this._state='ground'; } // ST
            break;
          case 'str':
            if(c === '\x07' || c === '\x1b'){ this._state='ground'; }
            break;
        }
      }
    }

    _csi(final, raw){
      if(this._csiPrivate){ this._csiPrivate=false; return; } // ?25l 等忽略
      const p = raw.split(';').map(x=>x===''?0:(parseInt(x,10)||0));
      const n = (i,d)=> (p[i]||d);
      switch(final){
        case 'm': this._sgr(p); break;
        case 'A': this.cy=Math.max(0,this.cy-n(0,1)); break;
        case 'B': this.cy+=n(0,1); this._ensureLine(this.cy); this._scrollUp(); break;
        case 'C': this.cx=Math.min(this.cols-1,this.cx+n(0,1)); break;
        case 'D': this.cx=Math.max(0,this.cx-n(0,1)); break;
        case 'E': this.cy+=n(0,1); this.cx=0; this._ensureLine(this.cy); this._scrollUp(); break;
        case 'F': this.cy=Math.max(0,this.cy-n(0,1)); this.cx=0; break;
        case 'G': case '`': this.cx=Math.max(0,n(0,1)-1); break;
        case 'H': case 'f': this.cy=Math.max(0,n(0,1)-1); this.cx=Math.max(0,n(1,1)-1); this._ensureLine(this.cy); this._scrollUp(); break;
        case 'J': this._eraseDisplay(n(0,0)); break;
        case 'K': this._eraseLine(n(0,0)); break;
        case 's': this.saved={cx:this.cx,cy:this.cy}; break;
        case 'u': if(this.saved){ this.cx=this.saved.cx; this.cy=this.saved.cy; } break;
        default: break;
      }
    }
    _sgr(p){
      if(!p.length) p.push(0);
      for(let i=0;i<p.length;i++){
        const v=p[i];
        if(v===0){ this.attr={fg:null,bg:null,bold:false,dim:false,italic:false,underline:false,reverse:false,strike:false}; }
        else if(v===1) this.attr.bold=true;
        else if(v===2) this.attr.dim=true;
        else if(v===3) this.attr.italic=true;
        else if(v===4) this.attr.underline=true;
        else if(v===7) this.attr.reverse=true;
        else if(v===9) this.attr.strike=true;
        else if(v===22){ this.attr.bold=false; this.attr.dim=false; }
        else if(v===23) this.attr.italic=false;
        else if(v===24) this.attr.underline=false;
        else if(v===27) this.attr.reverse=false;
        else if(v===39) this.attr.fg=null;
        else if(v===49) this.attr.bg=null;
        else if(v>=30&&v<=37) this.attr.fg=ANSI[ANSI_SEQ[v-30]];
        else if(v>=90&&v<=97) this.attr.fg=ANSI[ANSI_SEQ[v-90+8]];
        else if(v>=40&&v<=47) this.attr.bg=ANSI[ANSI_SEQ[v-40]];
        else if(v>=100&&v<=107) this.attr.bg=ANSI[ANSI_SEQ[v-100+8]];
        else if(v===38||v===48){
          const isFg=(v===38);
          const mode=p[i+1];
          if(mode===5 && p[i+2]!=null){ const c=this._xterm256(p[i+2]); if(isFg)this.attr.fg=c; else this.attr.bg=c; i+=2; }
          else if(mode===2 && p[i+4]!=null){ const c='rgb('+p[i+2]+','+p[i+3]+','+p[i+4]+')'; if(isFg)this.attr.fg=c; else this.attr.bg=c; i+=4; }
        }
      }
    }
    _xterm256(n){
      if(n<16) return ANSI[ANSI_SEQ[n]];
      if(n>=232){ const g=n-232, v=8+g*10; return 'rgb('+v+','+v+','+v+')'; }
      const c=n-16, r=Math.floor(c/36), g=Math.floor((c%36)/6), b=c%6;
      const cv=x=>x?55+x*40:0;
      return 'rgb('+cv(r)+','+cv(g)+','+cv(b)+')';
    }
    _eraseDisplay(mode){
      if(mode===2 || mode===3){ this.lines=[]; this.cx=0; this.cy=0; this._newLine(); return; }
      if(mode===0){
        const line=this._cur(); for(let x=this.cx;x<line.length;x++) line[x]=emptyCell();
        for(let y=this.cy+1;y<this.lines.length;y++) this.lines[y]=[];
      } else if(mode===1){
        const line=this._cur(); for(let x=0;x<=this.cx&&x<line.length;x++) line[x]=emptyCell();
        for(let y=0;y<this.cy;y++) this.lines[y]=[];
      }
    }
    _eraseLine(mode){
      const line=this._cur();
      if(mode===0) for(let x=this.cx;x<line.length;x++) line[x]=emptyCell();
      else if(mode===1) for(let x=0;x<=this.cx&&x<line.length;x++) line[x]=emptyCell();
      else if(mode===2) this.lines[this.cy]=[];
    }

    // 输出结构化行：每行是片段数组 [{text,fg,bg,bold,italic,underline,reverse,strike}]，空行保留
    render(){
      const out=[];
      for(const line of this.scrollback.concat(this.lines)){
        const segs=[]; let cur=null;
        const max=Math.max(line.length, 0);
        for(let x=0;x<max;x++){
          const cell=line[x]||emptyCell();
          if(cell.__wide) continue;   // 宽字符的占位 cell，不输出
          const key=[cell.fg,cell.bg,cell.bold,cell.dim,cell.italic,cell.underline,cell.reverse,cell.strike].join('|');
          if(!cur || cur._key!==key){
            cur={text:'',fg:cell.fg,bg:cell.bg,bold:cell.bold,dim:cell.dim,italic:cell.italic,underline:cell.underline,reverse:cell.reverse,strike:cell.strike,_key:key};
            segs.push(cur);
          }
          cur.text += cell.ch;
        }
        out.push(segs);
      }
      return out;
    }
    // 渲染成 HTML 字符串（转义安全）
    toHTML(){
      const esc=s=>s.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;');
      return this.render().map(segs=>{
        const inner=segs.map(s=>{
          let st='';
          let fg=s.fg, bg=s.bg;
          if(s.reverse){ const t=fg; fg=bg||DEFAULT_BG; bg=t||DEFAULT_FG; }
          if(fg) st+='color:'+fg+';';
          if(bg) st+='background:'+bg+';';
          if(s.bold) st+='font-weight:700;';
          if(s.dim) st+='opacity:.6;';
          if(s.italic) st+='font-style:italic;';
          if(s.underline) st+='text-decoration:underline;';
          if(s.strike) st+='text-decoration:line-through;';
          return '<span'+(st?' style="'+st+'"':'')+'>'+esc(s.text)+'</span>';
        }).join('');
        return '<div class="term-line">'+inner+'</div>';
      }).join('');
    }
  }

  global.TermBuffer = TermBuffer;
  global.TermAnsi = ANSI;
})(window);

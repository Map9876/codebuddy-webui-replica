/* 关键修复点综合断言（回归门禁）：把历史 bug 的固定结论一次性断言 */
const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch({ executablePath: '/root/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome', args: ['--no-sandbox'] });
  const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const p = await ctx.newPage();
  const errs = []; p.on('pageerror', e => errs.push(e.message));
  const A = {};

  // 拦截 input：TUI 输入测试不污染真实终端
  await ctx.addInitScript(() => {
    const orig = window.fetch;
    window.fetch = function (u, o) {
      if (typeof u === 'string' && u.indexOf('/cb/api/input') >= 0) return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true }) });
      return orig.apply(this, arguments);
    };
  });

  // 1. chat 首屏默认展开 + 会话数 + 全部按钮有注释
  await p.goto('http://127.0.0.1:7911/chat', { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(2800);
  A.chatSidebarOpen = await p.locator('#sidebar').evaluate(e => e.classList.contains('open'));
  A.sessions = await p.locator('#sessions-list .session').count();
  A.chatNoTitle = await p.evaluate(() => [...document.querySelectorAll('button')].filter(b => !b.title && !b.getAttribute('aria-label') && getComputedStyle(b).display !== 'none').length);

  // 2. 编辑器页：explorer 默认展开 + 内容搜索 + 按钮注释 + 字体错误
  const fontErrs = []; p.on('console', m => { if (/font|ttf|woff|OTS/i.test(m.text())) fontErrs.push(m.text()); });
  await p.evaluate(() => location.hash = '#/editor-page');
  await p.waitForTimeout(3000);
  const fr = p.frames().find(f => /\/editor(\?|$)/.test(f.url()) && !f.url().includes('/chat'));
  A.editorExplorerOpen = await fr.evaluate(() => document.getElementById('explorer').classList.contains('open'));
  A.editorNoTitle = await fr.evaluate(() => [...document.querySelectorAll('button')].filter(b => !b.title && !b.getAttribute('aria-label') && getComputedStyle(b).display !== 'none').length);
  A.fontErrors = fontErrs.length;

  // 3. 终端页：工具栏不溢出 + 全部按钮有注释
  await p.goto('http://127.0.0.1:7911/4', { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(1800);
  A.toolbarOverflow = await p.evaluate(() => { const bar = document.getElementById('terminal-toolbar'); return bar.scrollWidth - bar.clientWidth; });
  A.termNoTitle = await p.evaluate(() => [...document.querySelectorAll('button')].filter(b => !b.title && !b.getAttribute('aria-label') && getComputedStyle(b).display !== 'none').length);

  A.errors = errs;
  // 断言
  const fail = [];
  if (!A.chatSidebarOpen) fail.push('chat sidebar 未默认展开');
  if (A.sessions < 1) fail.push('会话列表为空');
  if (A.chatNoTitle > 0) fail.push('chat 有无注释按钮');
  if (!A.editorExplorerOpen) fail.push('editor explorer 未默认展开');
  if (A.editorNoTitle > 0) fail.push('editor 有无注释按钮');
  if (A.fontErrors > 0) fail.push('字体加载错误');
  if (A.toolbarOverflow > 0) fail.push('工具栏溢出 ' + A.toolbarOverflow + 'px');
  if (A.termNoTitle > 0) fail.push('终端有无注释按钮');
  if (A.errors.length) fail.push('JS 错误 ' + A.errors.length);
  console.log(JSON.stringify({ A, PASS: fail.length === 0, fail }, null, 2));
  await b.close();
  if (fail.length) process.exit(1);
})().catch(e => { console.error(String(e).slice(0, 400)); process.exit(1); });

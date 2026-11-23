const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch({ executablePath: '/root/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome', args: ['--no-sandbox'] });
  const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const p = await ctx.newPage();
  const errs = []; p.on('pageerror', e => errs.push(e.message));
  await p.goto('http://127.0.0.1:7911/chat#/editor-page', { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(2500);

  // 进 iframe
  const frames = p.frames();
  const fr = frames.find(f => /\/(editor)(\?|$)/.test(f.url()) && !f.url().includes('/chat'));
  // 点父页面 rail 的搜索侧栏图标（通过 postMessage 让 iframe 切到搜索面板）
  await p.locator('.rail-sidetab[data-panel="search"]').click();
  await p.waitForTimeout(500);
  // 输入搜索词
  await fr.locator('#ex-search-input').fill('splitState');
  await p.waitForTimeout(2500);

  const out = {
    summary: await fr.locator('.sr-summary').innerText().catch(() => null),
    resultCount: await fr.locator('.sr-content').count(),
    firstResult: await fr.locator('.sr-content').first().innerText().catch(() => null),
    errs
  };
  // 点第一个结果，验证打开文件
  if (out.resultCount > 0) {
    await fr.locator('.sr-content').first().click();
    await p.waitForTimeout(1800);
    out.openedTab = await fr.locator('.tab.active .tname').innerText().catch(() => null);
    out.monacoHost = await fr.locator('#monaco-host').count();
  }
  console.log(JSON.stringify(out, null, 2));
  await p.screenshot({ path: '/workspace/cb-chat/verify_editor_search.png' });
  await b.close();
})().catch(e => { console.error(String(e).slice(0, 400)); process.exit(1); });

/* 真实用户手机旅程：/chat → 会话列表 → 打开会话 → 编辑器 → 搜索 → 回对话 → 新对话 */
const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch({ executablePath: '/root/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome', args: ['--no-sandbox'] });
  const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const p = await ctx.newPage();
  const errs = []; p.on('pageerror', e => errs.push(e.stack || String(e)));
  const out = {};

  // 1. 打开 /chat
  await p.goto('http://127.0.0.1:7911/chat', { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(2800);
  out.step1_chat = { sessions: await p.locator('#sessions-list .session').count(), sidebarOpen: await p.locator('#sidebar').evaluate(e => e.classList.contains('open')) };

  // 2. 打开一个会话
  await p.locator('#sessions-list .session').nth(1).click();
  await p.waitForTimeout(1800);
  out.step2_session = { msgs: await p.locator('#main .msg').count() };

  // 3. 切到编辑器页
  await p.locator('.rail-btn[data-view="files"]').click();
  await p.waitForTimeout(2500);
  out.step3_editor = { hash: await p.evaluate(() => location.hash), backVisible: await p.locator('#btn-back-chat').evaluate(e => getComputedStyle(e).display !== 'none') };

  // 4. 编辑器搜索（iframe）
  const fr = p.frames().find(f => /\/editor(\?|$)/.test(f.url()) && !f.url().includes('/chat'));
  if (fr) {
    await p.locator('.rail-sidetab[data-panel="search"]').click();
    await p.waitForTimeout(400);
    await fr.locator('#ex-search-input').fill('splitState');
    // 等待搜索结果出现（大会话后 grep 可能较慢），最多 8s
    await fr.locator('.sr-content').first().waitFor({ timeout: 8000 }).catch(() => {});
    out.step4_search = { results: await fr.locator('.sr-content').count() };
  }

  // 5. 返回对话
  await p.locator('#btn-back-chat').click();
  await p.waitForTimeout(800);
  out.step5_back = { hash: await p.evaluate(() => location.hash), sessions: await p.locator('#sessions-list .session').count() };

  out.errors = errs;
  console.log(JSON.stringify(out, null, 2));
  await b.close();
})().catch(e => { console.error(String(e).slice(0, 500)); process.exit(1); });

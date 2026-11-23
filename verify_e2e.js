/* 全页面端到端回归：终端页 / 对话页 / 编辑页 */
const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch({
    executablePath: '/root/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome',
    args: ['--no-sandbox', '--disable-dev-shm-usage']
  });
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(e.stack || String(e)));

  const out = {};

  // 终端页
  await page.goto('http://127.0.0.1:7911/1', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(1600);
  out.terminal = {
    toolbarBtns: await page.locator('#terminal-toolbar button').count(),
    closeVisible: await page.locator('#btn-close').evaluate(el => el.getBoundingClientRect().right <= innerWidth),
    lines: await page.locator('.term-line').count()
  };

  // 对话页
  await page.goto('http://127.0.0.1:7911/chat', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(3000);
  out.chat = {
    sessions: await page.locator('#sessions-list .session').count(),
    navVisible: await page.locator('#rail-nav').evaluate(el => getComputedStyle(el).display !== 'none').catch(() => null)
  };

  // 编辑页（hash 视图）
  await page.evaluate(() => { location.hash = '#/editor-page'; });
  await page.waitForTimeout(2500);
  const frame = page.frameLocator('#editor-frame');
  out.editor = {
    iframePresent: await page.locator('#editor-frame').count(),
    backVisible: await page.locator('#btn-back-chat').evaluate(el => getComputedStyle(el).display !== 'none').catch(() => null),
    sideVisible: await page.locator('#rail-sidetabs').evaluate(el => getComputedStyle(el).display !== 'none').catch(() => null),
    files: await frame.locator('.ft-row').count().catch(() => 0),
    monaco: await frame.locator('#monaco-host .monaco-editor').count().catch(() => 0)
  };

  // 返回对话
  await page.locator('#btn-back-chat').click().catch(() => {});
  await page.waitForTimeout(600);
  out.afterBack = {
    hash: await page.evaluate(() => location.hash),
    navVisible: await page.locator('#rail-nav').evaluate(el => getComputedStyle(el).display !== 'none').catch(() => null)
  };

  out.errors = errors;
  console.log(JSON.stringify(out, null, 2));
  await browser.close();
})().catch(e => { console.error(e); process.exit(1); });

/* 验证 TUI 辅助键：Esc / Shift+Tab / Enter 的显示条件与按键序列 */
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

  await page.addInitScript(() => {
    window.__sent = [];
    const orig = window.fetch;
    window.fetch = function (url, opts) {
      if (typeof url === 'string' && url.indexOf('/cb/api/input') >= 0) {
        window.__sent.push(opts && opts.body);
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true }) });
      }
      return orig.apply(this, arguments);
    };
  });

  const out = {};

  // codebuddy 终端
  await page.goto('http://127.0.0.1:7911/1', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(1600);
  out.codebuddy = {
    keysVisible: await page.locator('#tui-keys').evaluate(el => !el.hidden),
    keyCount: await page.locator('.tkey').count(),
    titles: await page.locator('.tkey').evaluateAll(els => els.map(e => e.title)),
    inViewport: await page.locator('.tkey').evaluateAll(els => els.every(e => {
      const r = e.getBoundingClientRect(); return r.right <= innerWidth && r.bottom <= innerHeight;
    }))
  };
  await page.locator('.tkey[data-key="esc"]').click();
  await page.locator('.tkey[data-key="stab"]').click();
  await page.locator('.tkey[data-key="enter"]').click();
  await page.waitForTimeout(200);
  out.sent = await page.evaluate(() => window.__sent.map(s => JSON.stringify(s)));
  await page.screenshot({ path: '/workspace/cb-chat/verify_tui_keys.png' });

  // 普通 zsh 终端：辅助键应隐藏
  await page.goto('http://127.0.0.1:7911/4', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(1400);
  out.plainShell = {
    keysVisible: await page.locator('#tui-keys').evaluate(el => !el.hidden).catch(() => 'n/a'),
    upHidden: await page.locator('#btn-up').evaluate(el => el.hidden).catch(() => 'n/a')
  };

  out.errors = errors;
  console.log(JSON.stringify(out, null, 2));
  await browser.close();
})().catch(e => { console.error(e); process.exit(1); });

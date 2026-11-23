/* 验证：codebuddy TUI（信任对话框，无 ⏵⏵ 关键词）输入时不再走乐观行 */
const { chromium } = require('playwright');

(async () => {
  const browser = await chromium.launch({
    executablePath: '/root/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome',
    args: ['--no-sandbox', '--disable-dev-shm-usage']
  });
  const ctx = await browser.newContext({
    viewport: { width: 390, height: 844 }, deviceScaleFactor: 2,
    isMobile: true, hasTouch: true
  });
  const page = await ctx.newPage();
  const errors = [];
  page.on('pageerror', e => errors.push(String(e)));

  // 拦截所有 input 请求：no-op，避免向真实终端写入测试文字
  await page.addInitScript(() => {
    const orig = window.fetch;
    window.fetch = function (url, opts) {
      if (typeof url === 'string' && url.indexOf('/cb/api/input') >= 0) {
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true }) });
      }
      return orig.apply(this, arguments);
    };
  });

  async function probe(path, label) {
    await page.goto('http://127.0.0.1:7911' + path, { waitUntil: 'domcontentloaded', timeout: 30000 });
    await page.waitForTimeout(1800);
    const input = page.locator('#input');
    await input.fill('测试abc');
    await input.dispatchEvent('input');
    await page.waitForTimeout(300);
    const r = {
      label,
      typingInline: await page.locator('.typing-inline').count(),
      inputVal: await input.inputValue(),
      upHidden: await page.locator('#btn-up').evaluate(el => el.hidden).catch(() => 'n/a'),
      picker: await page.locator('#term-picker-name').getAttribute('data-name').catch(() => null)
    };
    await page.screenshot({ path: '/workspace/cb-chat/verify_' + label + '.png' });
    return r;
  }

  const results = [];
  results.push(await probe('/3', 'trust_dialog'));   // 信任对话框，无 ⏵⏵ 关键词
  results.push(await probe('/1', 'bypass_tui'));     // 有 ⏵⏵ 关键词的常规 TUI
  console.log(JSON.stringify({ results, errors }, null, 2));
  await browser.close();
})().catch(e => { console.error(e); process.exit(1); });

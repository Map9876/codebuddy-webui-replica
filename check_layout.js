/* 核查手机视口下终端工具栏按钮是否被挤出屏幕 */
const { chromium } = require('playwright');
(async () => {
  const browser = await chromium.launch({
    executablePath: '/root/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome',
    args: ['--no-sandbox', '--disable-dev-shm-usage']
  });
  const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  const page = await ctx.newPage();
  await page.goto('http://127.0.0.1:7911/1', { waitUntil: 'domcontentloaded', timeout: 30000 });
  await page.waitForTimeout(1500);
  const r = await page.evaluate(() => {
    const vw = window.innerWidth;
    const bar = document.getElementById('terminal-toolbar');
    const out = { vw, barScrollW: bar.scrollWidth, barClientW: bar.clientWidth, btns: [] };
    bar.querySelectorAll('button').forEach(b => {
      const r = b.getBoundingClientRect();
      out.btns.push({
        id: b.id, left: Math.round(r.left), right: Math.round(r.right),
        w: Math.round(r.width), hidden: b.hidden,
        over: r.right > vw + 0.5, squished: r.width < 20 && !b.hidden
      });
    });
    return out;
  });
  console.log(JSON.stringify(r, null, 2));
  await browser.close();
})().catch(e => { console.error(e); process.exit(1); });

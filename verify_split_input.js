const { chromium } = require('playwright');
(async () => {
  const b = await chromium.launch({ executablePath: '/root/.cache/ms-playwright/chromium-1228/chrome-linux64/chrome', args: ['--no-sandbox'] });
  const ctx = await b.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
  // 拦截所有 input 请求，记录写到哪个 id（子 iframe 也要拦截）
  await ctx.addInitScript(() => {
    window.__sent = [];
    const orig = window.fetch;
    window.fetch = function (u, o) {
      if (typeof u === 'string' && u.indexOf('/cb/api/input') >= 0) {
        window.__sent.push({ url: u, body: o && o.body });
        return Promise.resolve({ ok: true, json: () => Promise.resolve({ ok: true }) });
      }
      return orig.apply(this, arguments);
    };
  });
  const p = await ctx.newPage();
  const errs = []; p.on('pageerror', e => errs.push(e.message));
  await p.goto('http://127.0.0.1:7911/1', { waitUntil: 'domcontentloaded' });
  await p.waitForTimeout(1500);
  await p.locator('#btn-split').click();
  await p.waitForFunction(() => !document.getElementById('split-host').hidden, { timeout: 25000 }).catch(() => {});
  await p.waitForTimeout(3500);

  // 主终端输入
  await p.locator('#input').fill('MAIN');
  await p.locator('#input').dispatchEvent('input');
  await p.waitForTimeout(200);

  // 副终端输入：找到 iframe 里的 input
  const frames = p.frames();
  const fr = frames.find(f => f.url().includes('embed=1'));
  const subId = new URL(fr.url()).pathname.match(/\/(\d+)/)[1];
  await fr.locator('#input').fill('SUB');
  await fr.locator('#input').dispatchEvent('input');
  await p.waitForTimeout(200);

  // 读取主、子两个 window 的 __sent
  const mainSent = await p.evaluate(() => window.__sent.map(s => ({ url: s.url.split('id=')[1], body: s.body })));
  const subSent = await fr.evaluate(() => window.__sent.map(s => ({ url: s.url.split('id=')[1], body: s.body })));
  console.log(JSON.stringify({ subId, mainSent, subSent, errs }, null, 2));
  // 清理：点父页面分栏关闭按钮 → closeSplit() 会 kill 副终端 PTY，避免测试残留僵尸终端
  await p.evaluate(() => { var t = document.querySelector('.split-close'); if (t) t.click(); }).catch(() => {});
  await p.waitForTimeout(500);
  await b.close();
  // 可靠兜底：列出所有终端，kill 掉非保留 id（保留原始 1/2/3/4/7），避免任何测试残留
  await new Promise(resolve => {
    const http = require('node:http');
    const reqGet = http.get({ host: '127.0.0.1', port: 7911, path: '/cb/api/terminals' }, res => {
      let body = ''; res.on('data', c => body += c);
      res.on('end', () => {
        let ids = [];
        try { const d = JSON.parse(body); ids = (d.tabs || []).flatMap(t => t.terminals || []).map(t => t.id).filter(id => ![1, 2, 3, 4, 7].includes(id)); } catch (e) {}
        let done = 0;
        if (!ids.length) return resolve();
        ids.forEach(id => {
          const r = http.request({ host: '127.0.0.1', port: 7911, path: '/cb/api/kill?id=' + id, method: 'POST' }, rr => { rr.resume(); rr.on('end', () => { if (++done === ids.length) resolve(); }); });
          r.on('error', () => { if (++done === ids.length) resolve(); }); r.end();
        });
      });
    });
    reqGet.on('error', resolve);
  });
})().catch(e => { console.error(e); process.exit(1); });

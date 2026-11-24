// 아이콘·링크 미리보기 이미지 생성: public/favicon.svg 를 PNG 로 만들고, 카카오톡 등에 뜨는 대표 이미지(og-image.png)를 그린다.
//   npm run icons      (Playwright 필요)
const { createRequire } = require('node:module');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = createRequire(__filename)('playwright');

const PUB = path.join(__dirname, '..', 'public');
const svg = fs.readFileSync(path.join(PUB, 'favicon.svg'), 'utf8');
const proxy = process.env.HTTPS_PROXY ? { server: process.env.HTTPS_PROXY } : undefined;

(async () => {
  const browser = await chromium.launch({ proxy });
  const ctx = await browser.newContext({ ignoreHTTPSErrors: true });
  const page = await ctx.newPage();

  // 1) 아이콘 PNG (파비콘 32, 홈 화면 192/512, 아이폰 180)
  for (const [name, size] of [['favicon-32.png', 32], ['icon-192.png', 192], ['icon-512.png', 512], ['apple-touch-icon.png', 180]]) {
    await page.setViewportSize({ width: size, height: size });
    await page.setContent(`<style>html,body{margin:0;background:transparent}svg{display:block;width:${size}px;height:${size}px}</style>${svg}`);
    await page.screenshot({ path: path.join(PUB, name), omitBackground: true });
    console.log('saved', name);
  }

  // 2) 링크 미리보기 이미지 1200x630
  await page.setViewportSize({ width: 1200, height: 630 });
  await page.setContent(`<!doctype html><html><head><meta charset="utf-8">
    <link href="https://fonts.googleapis.com/css2?family=Gowun+Dodum&display=swap" rel="stylesheet">
    <style>
      html,body{margin:0;width:1200px;height:630px;background:#FFF7E6;color:#5B3A1E;font-family:'Gowun Dodum',sans-serif}
      .wrap{display:flex;align-items:center;gap:52px;height:100%;padding:0 76px;box-sizing:border-box;border:14px solid #5B3A1E}
      .ico svg{width:250px;height:250px;display:block;filter:drop-shadow(0 10px 0 rgba(91,58,30,.22))}
      h1{margin:0;font-size:132px;line-height:1.05;font-weight:400;white-space:nowrap}
      .sub{font-size:46px;margin-top:16px;white-space:nowrap}
      .tags{display:flex;gap:12px;margin-top:34px}
      .tags span{font-size:28px;padding:8px 22px;border-radius:999px;background:#FFD84D;white-space:nowrap}
    </style></head><body><div class="wrap">
      <div class="ico">${svg}</div>
      <div><h1>누구일까?</h1><div class="sub">서로 알아가는 진모임 퀴즈쇼</div>
      <div class="tags"><span>비공개로 답 쓰기</span><span>익명으로 맞히기</span><span>한마디 나눔</span></div></div>
    </div></body></html>`);
  await page.evaluate(() => document.fonts.ready);
  console.log('폰트 적용:', await page.evaluate(() => document.fonts.check('16px "Gowun Dodum"')));
  await page.screenshot({ path: path.join(PUB, 'og-image.png') });
  console.log('saved og-image.png');
  await browser.close();
})();

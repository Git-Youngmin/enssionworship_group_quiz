// 실제 화면 캡처 스크립트: 진행자 1 + 폰 4대로 한 판을 돌리며 docs/screenshots/ 에 저장한다.
//   터미널 1:  npm run dev
//   터미널 2:  npm run capture      (Playwright 가 설치되어 있어야 함)
const { createRequire } = require('node:module');
const path = require('node:path');
const { chromium } = createRequire(__filename)('playwright');

const BASE = process.env.BASE ?? 'http://localhost:8787';
const OUT = path.join(__dirname, '..', 'docs', 'screenshots');
const proxy = process.env.HTTPS_PROXY ? { server: process.env.HTTPS_PROXY, bypass: 'localhost,127.0.0.1' } : undefined;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const NAMES = ['민수', '지은', '하늘', '요셉'];
const ANSWERS = {
  app: ['유튜브', '카카오톡', '인스타그램', '당근마켓'],
  food: ['오이', '고수', '민트초코', '파인애플 피자'],
  laugh: ['조카가 처음으로 “이모”라고 불러 준 일', '친구랑 길에서 같은 옷을 입고 만난 일', '버스에서 졸다가 종점까지 간 일', '엄마가 이모티콘을 잘못 보낸 일'],
  grace: ['취업 준비 중에 좋은 공동체를 만난 것', '아픈 뒤에 건강을 되찾은 것', '이사 갈 집이 기적처럼 정해진 것', '새로운 부서에서 좋은 친구를 얻은 것'],
};

(async () => {
  const browser = await chromium.launch({ proxy });
  const mk = (viewport, dsf) => browser.newContext({ viewport, deviceScaleFactor: dsf, ignoreHTTPSErrors: true, locale: 'ko-KR', isMobile: viewport.width < 600, hasTouch: viewport.width < 600 });
  const hostCtx = await mk({ width: 1280, height: 1040 }, 1.25);
  const host = await hostCtx.newPage();
  const phones = [];
  for (let i = 0; i < 4; i++) phones.push(await (await mk({ width: 390, height: 780 }, 2)).newPage());

  const shot = async (page, name, extra = 0) => {
    await page.evaluate(() => document.fonts.ready);
    await page.evaluate(() => window.scrollTo(0, 0));
    await sleep(350 + extra); // 애니메이션 끝나길 잠깐 기다림
    await page.screenshot({ path: path.join(OUT, `${name}.png`) });
    console.log('  saved', name);
  };

  // 1) 진행자: 방 만들기
  await host.goto(`${BASE}/host.html`);
  await host.getByText('오늘의 질문').waitFor();
  console.log('폰트 적용:', await host.evaluate(() => document.fonts.check('16px "Gowun Dodum"')));
  await shot(host, '01-host-setup');
  await host.getByRole('button', { name: '방 만들기' }).click();
  await host.locator('.code').waitFor();
  const code = (await host.locator('.code').textContent()).trim();
  console.log('방 코드', code);

  // 2) 참가자 입장
  await phones[0].goto(`${BASE}/play.html?code=${code}`);
  await phones[0].getByPlaceholder('닉네임').waitFor();
  await shot(phones[0], '02-play-join');
  for (let i = 0; i < 4; i++) {
    if (i) await phones[i].goto(`${BASE}/play.html?code=${code}`);
    await phones[i].getByPlaceholder('닉네임').fill(NAMES[i]);
    await phones[i].getByRole('button', { name: '들어가기' }).click();
    await phones[i].getByText('어서 오세요').waitFor();
  }
  await host.getByText('입장한 사람 4명').waitFor();
  await shot(host, '03-host-lobby');
  await shot(phones[0], '04-play-lobby');

  // 큰 화면 없이 진행자가 폰 하나로 진행하는 경우의 화면
  const hpCtx = await mk({ width: 390, height: 780 }, 2);
  const hp = await hpCtx.newPage();
  await hp.goto(`${BASE}/host.html`);
  await hp.getByRole('button', { name: '방 만들기' }).click();
  await hp.locator('.code').waitFor();
  await shot(hp, '17-host-phone-lobby');
  await hpCtx.close();

  // 3) 시작 → 답 쓰기
  await host.getByRole('button', { name: '시작하기' }).click();
  for (const p of phones) await p.getByRole('button', { name: '제출하기' }).waitFor();
  const qids = ['app', 'food', 'laugh', 'grace'];
  const fill = async (i) => { for (let q = 0; q < 4; q++) await phones[i].locator('textarea').nth(q).fill(ANSWERS[qids[q]][i]); };
  await fill(0);
  await shot(phones[0], '05-play-writing');
  await phones[0].getByRole('button', { name: '제출하기' }).click();
  await phones[0].getByText('제출 완료').waitFor();
  await fill(1);
  await phones[1].getByRole('button', { name: '제출하기' }).click();
  await host.getByText('2/4명 제출').waitFor();
  await shot(host, '06-host-writing');
  await shot(phones[0], '07-play-submitted');
  for (const i of [2, 3]) { await fill(i); await phones[i].getByRole('button', { name: '제출하기' }).click(); }

  // 4) 라운드 4번
  for (let round = 0; round < 4; round++) {
    await host.getByText('이 답은 누가 썼을까요').waitFor();
    await sleep(500);
    const isAuthor = await Promise.all(phones.map((p) => p.getByText('이건 내 답이에요').count().then((n) => n > 0)));
    const voters = phones.map((p, i) => i).filter((i) => !isAuthor[i]);
    const authorIdx = isAuthor.indexOf(true);
    if (round === 0) {
      await shot(phones[voters[0]], '08-play-guessing');
      await shot(phones[authorIdx], '09-play-guessing-author');
    }
    // 일부러 한 명은 틀리게 투표
    const pick = async (i, wrong) => {
      const btns = phones[i].locator('.cand');
      const n = await btns.count();
      let target = -1;
      for (let k = 0; k < n; k++) {
        const nm = (await btns.nth(k).textContent()).replace('✔ ', '').trim();
        const isAuth = nm === NAMES[authorIdx];
        if (wrong ? !isAuth : isAuth) { target = k; break; }
      }
      await btns.nth(target).click();
    };
    await pick(voters[0], false);
    await pick(voters[1], round % 2 === 1 ? true : false);
    if (round === 0) { await host.getByText('2/3명 투표 완료').waitFor(); await shot(host, '10-host-guessing'); }
    await pick(voters[2], round === 0 ? true : false);
    await host.getByText('두구두구').waitFor({ timeout: 4000 }).catch(() => {});
    if (round === 0) await shot(host, '11-host-drumroll');
    await host.locator('.reveal-name').waitFor();
    if (round === 0) {
      await shot(host, '12-host-reveal');
      await shot(phones[voters[0]], '13-play-reveal');
      await shot(phones[authorIdx], '14-play-reveal-author');
    }
    const next = host.getByRole('button', { name: /다음 문제|결과 보기/ });
    await next.click();
  }

  // 5) 결과
  await host.getByText('오늘의 어워드').waitFor();
  await shot(host, '15-host-final', 6000);
  await phones[0].getByText('오늘의 어워드').waitFor();
  await shot(phones[0], '16-play-final', 6000);

  await browser.close();
  console.log('완료');
})().catch((e) => { console.error(e); process.exit(1); });

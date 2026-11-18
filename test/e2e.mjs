// 통합 테스트: 실행 중인 서버(wrangler dev 또는 배포 주소)에 WebSocket 으로 접속해 한 판을 돌린다.
//   터미널 1:  npm run dev
//   터미널 2:  npm run e2e            (기본 http://localhost:8787)
//              BASE=https://내주소.workers.dev npm run e2e
import assert from 'node:assert/strict';

const BASE = process.env.BASE ?? 'http://localhost:8787';
const WS = BASE.replace(/^http/, 'ws');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

class Client {
  constructor(code, label) {
    this.label = label;
    this.raw = []; // 서버가 보낸 원본 문자열 전부 (유출 검사용)
    this.view = null;
    this.errors = [];
    this.closed = null;
    this.ws = new WebSocket(`${WS}/ws/${code}`);
    this.ws.onmessage = (e) => {
      this.raw.push(e.data);
      const m = JSON.parse(e.data);
      if (m.t === 'state') this.view = m.view;
      else if (m.t === 'joined') {
        this.playerToken = m.playerToken;
        this.playerId = m.playerId;
      } else if (m.t === 'error') this.errors.push(m);
    };
    this.ws.onclose = (e) => (this.closed = e.code);
    this.opened = new Promise((res, rej) => {
      this.ws.onopen = res;
      this.ws.onerror = () => rej(new Error('연결 실패'));
    });
  }
  send(o) {
    this.ws.send(JSON.stringify(o));
  }
  async waitFor(fn, what, ms = 5000) {
    const t = Date.now();
    while (Date.now() - t < ms) {
      if (this.view && fn(this.view)) return this.view;
      await sleep(25);
    }
    throw new Error(`[${this.label}] 기다리다 시간 초과: ${what} (현재 phase=${this.view?.phase})`);
  }
}

async function connect(code, label, hello) {
  const c = new Client(code, label);
  await c.opened;
  c.send({ t: 'hello', ...hello });
  await c.waitFor(() => true, 'hello 응답');
  return c;
}

async function createRoom(body = {}) {
  const r = await fetch(`${BASE}/api/rooms`, { method: 'POST', body: JSON.stringify(body) });
  assert.equal(r.status, 201);
  return r.json();
}

let passed = 0;
const ok = (name) => console.log(`  ✓ ${name}`) || passed++;

// ───────────── 1. 방 만들기·확인 ─────────────
const { code, hostToken } = await createRoom();
assert.match(code, /^\d{4}$/);
assert.ok(hostToken.length >= 32);
ok(`방 만들기 (코드 ${code})`);

let r = await fetch(`${BASE}/api/rooms/${code}`);
assert.equal(r.status, 200);
assert.equal((await r.json()).phase, 'lobby');
r = await fetch(`${BASE}/api/rooms/0000x`);
assert.equal(r.status, 404);
ok('방 확인 API');

// ───────────── 2. 입장 ─────────────
const host = await connect(code, '진행자(큰화면)', { hostToken });
assert.equal(host.view.isHost, true);
assert.equal(host.view.questions.length, 4);

const names = ['민수', '지은', '하늘', '요셉'];
const players = [];
for (const n of names) {
  const c = await connect(code, n, {});
  c.send({ t: 'join', name: n });
  await c.waitFor((v) => v.me?.name === n, '입장');
  assert.ok(c.playerToken);
  players.push(c);
}
await host.waitFor((v) => v.players.length === 4, '입장 현황');
ok('4명 입장, 진행자 화면에 입장 현황 반영');

const dup = await connect(code, '중복', {});
dup.send({ t: 'join', name: ' 민수 ' });
await sleep(150);
assert.equal(dup.errors.at(-1)?.code, 'NAME_TAKEN');
dup.ws.close();
ok('닉네임 중복 거절');

// 참가자가 진행 조작을 시도하면 거절
players[0].send({ t: 'start' });
players[0].send({ t: 'updateSettings', guessSeconds: 10 });
await sleep(150);
assert.equal(players[0].errors.filter((e) => e.code === 'NOT_HOST').length, 2);
assert.equal(host.view.phase, 'lobby');
// hello 에 가짜 진행자 토큰
const fake = await connect(code, '가짜', { hostToken: 'x'.repeat(48) });
assert.equal(fake.view.isHost, false);
assert.ok(fake.errors.some((e) => e.code === 'BAD_HOST_TOKEN'));
fake.send({ t: 'start' });
await sleep(150);
assert.equal(host.view.phase, 'lobby');
fake.ws.close();
ok('참가자·가짜 토큰의 진행 조작 거절');

// ───────────── 3. 새로고침 후 복귀 ─────────────
const old = players[1];
const savedToken = old.playerToken;
old.ws.close();
await host.waitFor((v) => v.players.find((p) => p.name === '지은')?.connected === false, '끊김 표시');
const back = await connect(code, '지은(복귀)', { playerToken: savedToken });
assert.equal(back.view.me.name, '지은');
back.playerToken = savedToken;
back.playerId = old.playerId;
players[1] = back;
await host.waitFor((v) => v.players.find((p) => p.name === '지은')?.connected === true, '복귀 표시');
ok('끊겼다가 토큰으로 같은 사람으로 복귀');

// ───────────── 4. 한 판 진행 ─────────────
host.send({ t: 'start' });
await Promise.all(players.map((p) => p.waitFor((v) => v.phase === 'writing', 'writing')));
const secrets = [];
players.forEach((p, i) => {
  const answers = {};
  for (const q of p.view.questions) {
    const t = `비밀답${i}-${q.id}`;
    secrets.push(t);
    answers[q.id] = t;
  }
  p.send({ t: 'submitAnswers', answers });
});
await Promise.all(players.map((p) => p.waitFor((v) => v.phase === 'guessing', 'guessing')));
ok('모두 제출하면 자동으로 투표 단계');

const everyone = [host, ...players];
let leaks = 0;
for (let round = 0; round < 4; round++) {
  await Promise.all(everyone.map((c) => c.waitFor((v) => v.phase === 'guessing' && v.round.index === round, `round ${round}`)));
  const text = host.view.round.answerText;
  // 투표 단계 화면에는 작성자 관련 키가 전혀 없어야 한다
  for (const c of everyone) {
    const json = JSON.stringify(c.view);
    if (/author/i.test(json) || /token/i.test(json) || json.includes(hostToken)) leaks++;
    for (const s of secrets) if (s !== text && json.includes(s)) leaks++;
  }
  const mineIdx = players.findIndex((p) => p.view.round.isMine);
  assert.ok(mineIdx >= 0, '작성자 본인에게만 isMine=true');
  assert.equal(players.filter((p) => p.view.round.isMine).length, 1);
  // 나머지는 모두 작성자를 지목
  const target = players[mineIdx].playerId;
  players.forEach((p, i) => i !== mineIdx && p.send({ t: 'vote', roundIndex: round, targetId: target }));
  await host.waitFor((v) => v.phase === 'reveal', `reveal ${round}`);
  assert.equal(host.view.round.author.id, target);
  assert.equal(host.view.round.correctVoters.length, 3);
  host.send({ t: 'next' });
}
assert.equal(leaks, 0, '투표 단계 화면에 작성자 정보 유출');
await host.waitFor((v) => v.phase === 'final', 'final');
ok('4라운드 진행 → 최종 화면 (투표 단계 화면에서 작성자 정보 유출 0건)');

// 지금까지 서버가 보낸 원본 메시지 중 reveal/final 이전에 작성자가 새지 않았는지 전수 검사
// (reveal 메시지에는 author 가 있어야 하므로, guessing 상태의 state 메시지만 본다)
for (const c of everyone) {
  for (const raw of c.raw) {
    const m = JSON.parse(raw);
    if (m.t === 'state' && m.view.phase === 'guessing') {
      assert.ok(!/author/i.test(raw), `[${c.label}] guessing 메시지에 author`);
    }
  }
}
ok('서버가 보낸 guessing 단계 원본 메시지 전수 검사');

assert.ok(host.view.final.awards.length >= 1);
assert.ok(!('ranking' in host.view.final));
ok('재미 상 표시');

// ───────────── 5. 타이머(alarm) ─────────────
const room2 = await createRoom({
  questions: [{ id: 'a', text: '타이머 시험 질문' }],
  settings: { writeSecondsPerQuestion: 20, guessSeconds: 10 },
});
const h2 = await connect(room2.code, 'h2', { hostToken: room2.hostToken });
const a = await connect(room2.code, 'a', {});
const b = await connect(room2.code, 'b', {});
a.send({ t: 'join', name: 'A' });
b.send({ t: 'join', name: 'B' });
await h2.waitFor((v) => v.players.length === 2, '입장');
h2.send({ t: 'start' });
await a.waitFor((v) => v.phase === 'writing', 'writing');
a.send({ t: 'submitAnswers', answers: { a: '시간이 지나면 넘어감' } }); // B 는 제출 안 함
const t0 = Date.now();
await a.waitFor((v) => v.phase === 'guessing', 'alarm → guessing', 30000);
const sec = (Date.now() - t0) / 1000;
assert.ok(sec > 15 && sec < 25, `writing 20초 마감에 맞춰 넘어가야 함 (${sec.toFixed(1)}초)`);
ok(`alarm: 제한 시간(20초) 후 자동으로 투표 단계 (${sec.toFixed(1)}초)`);
await a.waitFor((v) => v.phase === 'reveal', 'alarm → reveal', 20000);
ok('alarm: 투표 제한 시간(10초) 후 자동으로 정답 공개');

// ───────────── 6. 방 삭제 ─────────────
h2.send({ t: 'closeRoom' });
await sleep(500);
assert.equal(a.closed, 4001);
r = await fetch(`${BASE}/api/rooms/${room2.code}`);
assert.equal(r.status, 404);
const ghost = new Client(room2.code, 'ghost');
await ghost.opened;
await sleep(300);
assert.equal(ghost.errors.at(-1)?.code, 'NO_ROOM');
ok('방 삭제: 연결 종료 안내, 방 조회 404, 재접속 불가');

// 삭제된 코드로 새 방을 다시 만들 수 있는지 (코드 재사용) 는 4자리 난수라 직접 확인하지 않음

console.log(`\n통합 테스트 ${passed}개 항목 통과`);
for (const c of [host, ...players, h2, a, b, ghost]) {
  try {
    c.ws.close();
  } catch {}
}
process.exit(0);

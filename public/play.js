// 참가자(폰) 화면: 닉네임 → 답 쓰기 → 투표 → 결과
import { h, mount, toast, store, connectRoom, statusBanner, syncClock, timerEl, playerChips, tallyView, awardsView, recapView, controlsBar, FATAL_TEXT } from './common.js';

const app = document.getElementById('app');
const params = new URLSearchParams(location.search);
const code = (params.get('code') ?? '').trim();

// 코드가 없거나 잘못되면 코드 입력 화면
if (!/^\d{4}$/.test(code)) {
  mount(
    app,
    h('h1', { class: 'center' }, '방 코드를 입력해 주세요'),
    h('form', { class: 'card', style: 'display:flex;flex-direction:column;gap:12px', onsubmit: (e) => {
      e.preventDefault();
      const v = e.target.code.value.trim();
      if (/^\d{4}$/.test(v)) location.href = `/play.html?code=${v}`;
      else toast('방 코드는 숫자 4자리예요.');
    } },
      h('input', { class: 'field', name: 'code', inputmode: 'numeric', maxlength: 4, placeholder: '예) 1234', autocomplete: 'off', style: 'text-align:center;font-size:1.6em' }),
      h('button', { class: 'btn block', type: 'submit' }, '입장하기')),
  );
  throw new Error('no code');
}

const PLAYER_KEY = `jinquiz.player.${code}`;
const HOST_KEY = 'jinquiz.host';
let playerToken = store.get(PLAYER_KEY);
const hostInfo = store.get(HOST_KEY);
const hostToken = hostInfo?.code === code ? hostInfo.hostToken : null; // 같은 기기에서 만든 방이면 조작 막대도 보여 줌

let view = null;
let drafts = {}; // 쓰는 중인 답 (다시 그려져도 입력이 사라지지 않게)
let renderKey = '';
let editing = false; // 제출 후 "답 고치기"를 누른 상태
let conn;

conn = connectRoom({
  code,
  hello: () => ({ playerToken, hostToken }),
  onStatus: statusBanner,
  onJoined: (m) => {
    playerToken = m.playerToken;
    store.set(PLAYER_KEY, playerToken);
  },
  onError: (m) => {
    if (m.code === 'BAD_TOKEN') { store.del(PLAYER_KEY); playerToken = null; return; }
    if (m.code === 'BAD_HOST_TOKEN') return;
    if (['NO_ROOM', 'EXPIRED', 'KICKED'].includes(m.code)) return;
    toast(m.message);
  },
  onFatal: (why) => {
    if (why !== 'KICKED') store.del(PLAYER_KEY);
    mount(app, h('div', { class: 'card center', style: 'margin-top:20vh' }, h('div', { style: 'font-size:2.5em' }, why === 'EXPIRED' ? '👋' : '🤔'), h('p', null, FATAL_TEXT[why]), h('a', { class: 'btn', href: '/', style: 'display:inline-block;margin-top:14px;text-decoration:none' }, '처음으로')));
    document.querySelector('.controls')?.remove();
  },
  onView: (v) => {
    view = v;
    syncClock(v);
    render();
  },
});

const send = (o) => conn.send(o);

function render() {
  const v = view;
  const key = `${v.phase}|${v.me ? 'in' : 'out'}|${v.round?.index ?? ''}|${v.writing ? v.writing.submitted && !editing : ''}`;
  // 같은 화면 안에서의 갱신(입장 현황, 제출 수 등)은 입력 중인 칸을 건드리지 않도록 일부만 고친다
  if (key === renderKey && v.phase === 'writing' && (!v.writing.submitted || editing)) {
    const s = document.getElementById('prog');
    if (s) s.textContent = `${v.writing.doneCount}/${v.writing.total}명 제출`;
    return;
  }
  renderKey = key;
  document.querySelector('.controls')?.remove();

  if (!v.me) return mount(app, joinScreen(v));
  const screens = { lobby: lobbyScreen, writing: writingScreen, guessing: guessingScreen, reveal: revealScreen, final: finalScreen };
  mount(app, screens[v.phase](v));
  if (v.isHost) document.body.append(controlsBar(v, send));
}

// ───────────── 화면들 ─────────────
function joinScreen(v) {
  if (v.phase === 'final') return h('div', { class: 'card center' }, h('p', null, '이미 끝난 게임이에요. 다음에 또 만나요! 👋'));
  const input = h('input', { class: 'field', maxlength: v.limits.nameMax, placeholder: '닉네임 (예: 민수)', autocomplete: 'off', style: 'font-size:1.3em;text-align:center' });
  const go = (e) => {
    e?.preventDefault();
    const name = input.value.trim();
    if (!name) return toast('닉네임을 입력해 주세요.');
    send({ t: 'join', name });
  };
  return [
    h('div', { class: 'center', style: 'margin-top:8vh' }, h('div', { style: 'font-size:3em' }, '🕵️'), h('h1', null, '누구일까?'), h('p', { class: 'muted' }, `방 ${v.code} · 지금 ${v.players.length}명`)),
    h('form', { class: 'card', style: 'display:flex;flex-direction:column;gap:12px', onsubmit: go }, h('label', null, '이름 대신 쓸 닉네임을 알려 주세요'), input, h('button', { class: 'btn block', type: 'submit' }, '들어가기')),
    h('p', { class: 'muted center' }, '로그인 없이 닉네임만 써요. 게임이 끝나면 모두 지워져요.'),
  ];
}

function lobbyScreen(v) {
  return [
    h('div', { class: 'center', style: 'margin-top:6vh' }, h('div', { style: 'font-size:3em' }, '⏳'), h('h1', null, `${v.me.name}님, 어서 오세요!`), h('p', { class: 'muted' }, '진행자가 시작하면 질문이 나와요')),
    h('div', { class: 'card' }, h('p', { class: 'center muted', style: 'margin-bottom:10px' }, `지금 ${v.players.length}명`), playerChips(v)),
  ];
}

function writingScreen(v) {
  if (v.writing.submitted && !editing) {
    return [
      h('div', { class: 'center', style: 'margin-top:8vh' }, h('div', { style: 'font-size:3em' }, '✅'), h('h1', null, '제출 완료!'), h('p', { class: 'muted' }, '다른 사람들을 기다리고 있어요')),
      timerEl(),
      h('div', { class: 'card' }, h('p', { class: 'center muted', style: 'margin-bottom:10px' }, `${v.writing.doneCount}/${v.writing.total}명 제출`), playerChips(v, { showDone: true })),
      h('button', { class: 'btn ghost block', onclick: () => { drafts = { ...v.writing.myAnswers }; editing = true; renderKey = ''; render(); } }, '답 고치기'),
    ];
  }
  if (Object.keys(drafts).length === 0 && v.writing.myAnswers) drafts = { ...v.writing.myAnswers };
  const fields = v.questions.map((q, i) => {
    const ta = h('textarea', { class: 'field', maxlength: v.limits.answerMax, placeholder: '여기에 답을 써 주세요 (비워도 돼요)', rows: 2, 'aria-label': q.text });
    ta.value = drafts[q.id] ?? '';
    const cnt = h('div', { class: 'counter' }, `${[...ta.value].length}/${v.limits.answerMax}`);
    ta.addEventListener('input', () => { drafts[q.id] = ta.value; cnt.textContent = `${[...ta.value].length}/${v.limits.answerMax}`; });
    return h('div', { class: 'card' }, h('div', { class: 'q' }, `${i + 1}. ${q.text}`), ta, cnt);
  });
  return [
    h('div', { style: 'display:flex;justify-content:space-between;align-items:center' }, h('span', { class: 'step' }, '답 쓰기'), h('span', { class: 'muted', id: 'prog' }, `${v.writing.doneCount}/${v.writing.total}명 제출`)),
    timerEl(),
    h('p', { class: 'muted center' }, '🤫 지금 쓴 답은 아무도 못 봐요. 나중에 익명으로만 나와요.'),
    fields,
    h('button', { class: 'btn block', onclick: () => { editing = false; send({ t: 'submitAnswers', answers: drafts }); } }, '제출하기'),
  ];
}

function guessingScreen(v) {
  const r = v.round;
  const head = h('div', { style: 'display:flex;justify-content:space-between;align-items:center' }, h('span', { class: 'step' }, `${r.index + 1} / ${r.total}번째`), h('span', { class: 'muted' }, `${r.votedCount}/${r.voterTotal}명 투표`));
  const body = h('div', { style: 'display:flex;flex-direction:column;gap:16px' }, h('div', { class: 'q center' }, r.questionText), h('div', { class: 'answer' }, `“${r.answerText}”`));
  if (r.isMine) {
    return [head, timerEl(), body, h('div', { class: 'say' }, '🤫 이건 내 답이에요! 표정 관리 부탁해요')];
  }
  return [
    head, timerEl(), body,
    h('p', { class: 'center' }, '이 답은 누가 썼을까요?'),
    h('div', { class: 'cands' }, r.candidates.map((c) => h('button', { class: `cand${r.myVote === c.id ? ' sel' : ''}`, onclick: () => send({ t: 'vote', roundIndex: r.index, targetId: c.id }) }, (r.myVote === c.id ? '✔ ' : '') + c.name))),
    r.myVote && h('p', { class: 'muted center' }, '투표 완료! 마음이 바뀌면 다시 눌러도 돼요.'),
  ];
}

function revealScreen(v) {
  const r = v.round;
  const mine = r.isMine;
  return [
    h('span', { class: 'step', style: 'align-self:flex-start' }, `${r.index + 1} / ${r.total}번째 정답`),
    h('div', { class: 'q center' }, r.questionText),
    h('div', { class: 'answer', style: 'font-size:1.3em;padding:18px' }, `“${r.answerText}”`),
    h('p', { class: 'center muted' }, '쓴 사람은…'),
    h('div', { class: 'reveal-name' }, r.author.name),
    !mine && h('p', { class: 'center' }, r.myCorrect ? '🎉 맞혔어요!' : '아쉬워요, 다음엔 맞힐 수 있어요!'),
    h('div', { class: 'card' }, tallyView(r)),
    r.correctVoters.length > 0 && h('p', { class: 'center muted' }, `맞힌 사람: ${r.correctVoters.join(', ')}`),
    h('div', { class: 'say' }, mine ? '🎤 한마디 해 주세요! 이 답에 얽힌 이야기가 있나요?' : `🎤 ${r.author.name}님의 한마디를 들어 볼까요?`),
    h('p', { class: 'muted center' }, '진행자가 다음으로 넘길 때까지 기다려 주세요'),
  ];
}

function finalScreen(v) {
  const f = v.final;
  return [
    h('div', { class: 'center', style: 'margin-top:3vh' }, h('div', { style: 'font-size:3em' }, '🎉'), h('h1', null, '오늘의 재미 상')),
    awardsView(f),
    f.mine && h('p', { class: 'center muted' }, `나는 ${f.mine.guesses}번 중 ${f.mine.correct}번 맞혔어요`),
    h('h2', { class: 'center', style: 'font-size:1.1em;margin-top:8px' }, '오늘 나온 이야기'),
    recapView(f),
    h('p', { class: 'muted center' }, '🧹 이 방의 답과 기록은 곧 모두 삭제돼요.'),
    h('a', { class: 'btn ghost', href: '/', style: 'display:block;text-align:center;text-decoration:none;line-height:28px' }, '처음으로'),
  ];
}

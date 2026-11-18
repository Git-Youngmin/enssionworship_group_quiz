// 진행자 화면: 방 만들기 → 큰 화면(QR·질문·익명 답·정답 공개) + 하단 조작 패널
import { h, mount, toast, store, qrSvg, connectRoom, statusBanner, syncClock, timerEl, playerChips, tallyView, awardsView, recapView, controlsBar, FATAL_TEXT } from './common.js';

const app = document.getElementById('app');
const HOST_KEY = 'jinquiz.host';

// 다른 기기(폰)에서 조작하려고 연 링크: #c=1234&k=토큰 → 저장 후 주소창에서 지움
{
  const p = new URLSearchParams(location.hash.slice(1));
  if (/^\d{4}$/.test(p.get('c') ?? '') && p.get('k')) {
    store.set(HOST_KEY, { code: p.get('c'), hostToken: p.get('k') });
    history.replaceState(null, '', location.pathname);
  }
}

let conn = null;
let view = null;
let renderKey = '';
let drumUntil = 0; // 정답 공개 전 "두구두구" 연출 종료 시각
let notice = '';

const saved = store.get(HOST_KEY);
saved ? enterRoom(saved) : setupScreen();

// ───────────── 방 만들기 ─────────────
async function setupScreen() {
  document.querySelector('.controls')?.remove();
  mount(app, h('p', { class: 'center muted', style: 'margin-top:20vh' }, '질문 목록을 불러오는 중…'));
  let presets;
  try {
    presets = await (await fetch('/questions.json')).json();
  } catch {
    return mount(app, h('div', { class: 'card center' }, '질문 목록을 불러오지 못했어요. 새로고침해 주세요.'));
  }
  const MAX = 5;
  const picked = new Set(presets.defaultSet);
  const customs = []; // 직접 추가한 질문
  let write = 60, guess = 30;
  const list = h('div', { class: 'qlist' });
  const count = h('span', { class: 'muted' });
  const total = () => picked.size + customs.length;

  const redraw = () => {
    list.replaceChildren(
      ...Object.entries(presets.levels).flatMap(([lv, label]) =>
        presets.questions.filter((q) => q.level === lv).map((q) =>
          h('label', { class: 'qitem' },
            h('input', { type: 'checkbox', checked: picked.has(q.id) || null, onchange: (e) => {
              if (e.target.checked) { if (total() >= MAX) { e.target.checked = false; return toast(`질문은 최대 ${MAX}개예요.`); } picked.add(q.id); } else picked.delete(q.id);
              redraw();
            } }),
            h('span', { class: 'lv' }, label), h('span', null, q.text)))),
      ...customs.map((c, i) => h('label', { class: 'qitem' }, h('input', { type: 'checkbox', checked: true, onchange: () => { customs.splice(i, 1); redraw(); } }), h('span', { class: 'lv' }, '직접'), h('span', null, c.text))),
    );
    count.textContent = `${total()}/${MAX}개 선택 (3~5개 추천)`;
    createBtn.disabled = total() < 1;
  };

  const customInput = h('input', { class: 'field', maxlength: 60, placeholder: '직접 질문 추가 (예: 가장 좋아하는 간식은?)' });
  const addCustom = () => {
    const text = customInput.value.trim();
    if (!text) return;
    if (total() >= MAX) return toast(`질문은 최대 ${MAX}개예요.`);
    customs.push({ text });
    customInput.value = '';
    redraw();
  };
  const sel = (opts, cur, on) => h('select', { class: 'field', onchange: (e) => on(+e.target.value) }, opts.map((o) => h('option', { value: o, selected: o === cur || null }, `${o}초`)));

  const createBtn = h('button', { class: 'btn block', onclick: async () => {
    createBtn.disabled = true;
    const questions = [...presets.questions.filter((q) => picked.has(q.id)), ...customs];
    try {
      const r = await fetch('/api/rooms', { method: 'POST', body: JSON.stringify({ questions, settings: { writeSecondsPerQuestion: write, guessSeconds: guess } }) });
      const data = await r.json();
      if (!r.ok) throw new Error(data.message);
      const info = { code: data.code, hostToken: data.hostToken };
      store.set(HOST_KEY, info);
      enterRoom(info);
    } catch (e) {
      toast(e.message || '방을 만들지 못했어요. 잠시 후 다시 시도해 주세요.');
      createBtn.disabled = false;
    }
  } }, '방 만들기');

  mount(app,
    h('div', { class: 'center' }, h('div', { style: 'font-size:2.6em' }, '🎙️'), h('h1', null, '진행자: 방 만들기'), notice && h('p', { class: 'muted' }, notice)),
    h('div', { class: 'card', style: 'display:flex;flex-direction:column;gap:10px' }, h('b', null, '오늘의 질문'), count, list,
      h('div', { class: 'row' }, customInput, h('button', { class: 'btn ghost', onclick: addCustom, style: 'flex:none' }, '추가'))),
    h('div', { class: 'card', style: 'display:grid;grid-template-columns:1fr 1fr;gap:10px' },
      h('label', null, h('div', { class: 'muted' }, '답 쓰기 (문항당)'), sel([40, 60, 90, 120], 60, (v) => (write = v))),
      h('label', null, h('div', { class: 'muted' }, '투표 (문제당)'), sel([20, 30, 45, 60], 30, (v) => (guess = v)))),
    createBtn);
  redraw();
}

// ───────────── 방 연결 ─────────────
function enterRoom({ code, hostToken }) {
  notice = '';
  conn = connectRoom({
    code,
    hello: () => ({ hostToken }),
    onStatus: statusBanner,
    onError: (m) => {
      if (m.code === 'BAD_HOST_TOKEN') { store.del(HOST_KEY); conn.stop(); notice = '진행자 정보가 맞지 않아 새 방을 만들어야 해요.'; setupScreen(); }
    },
    onFatal: (why) => {
      store.del(HOST_KEY);
      notice = FATAL_TEXT[why];
      setupScreen();
    },
    onView: (v) => {
      if (view && v.phase === 'reveal' && view.phase !== 'reveal') drumUntil = Date.now() + 1400; // 공개 연출
      view = v;
      syncClock(v);
      render();
      if (v.phase === 'reveal' && drumUntil > Date.now()) setTimeout(render, drumUntil - Date.now() + 20);
    },
  });
}

const send = (o) => conn?.send(o);
const joinUrl = (code) => `${location.origin}/play.html?code=${code}`;

function render() {
  const v = view;
  const key = `${v.phase}|${v.round?.index ?? ''}|${drumUntil > Date.now()}`;
  // 같은 단계 안의 갱신은 화면 전체를 다시 그리되, 조작 막대는 단계가 바뀔 때만 새로 만든다
  const bar = document.querySelector('.controls');
  if (!bar || key !== renderKey || v.phase === 'lobby') {
    bar?.remove();
    document.body.append(controlsBar(v, send, { onCloseRoom: () => { store.del(HOST_KEY); notice = '방을 닫았어요.'; setupScreen(); } }));
  }
  renderKey = key;
  const screens = { lobby: lobbyScreen, writing: writingScreen, guessing: guessingScreen, reveal: revealScreen, final: finalScreen };
  mount(app, screens[v.phase](v));
}

function phoneControlLink() {
  const info = store.get(HOST_KEY);
  const url = `${location.origin}/host.html#c=${info.code}&k=${info.hostToken}`;
  return h('details', { class: 'card' },
    h('summary', { style: 'cursor:pointer;min-height:44px;display:flex;align-items:center' }, '📱 다른 기기(폰)에서 조작하기'),
    h('p', { class: 'muted', style: 'margin:8px 0' }, '⚠️ 이 QR로 들어가면 진행자 권한을 가져요. 참가자에게 보여 주지 마세요.'),
    h('div', { class: 'center' }, qrSvg(url)));
}

// ───────────── 화면들 ─────────────
function lobbyScreen(v) {
  return [
    h('div', { class: 'lobby-grid' },
      h('div', { class: 'center' }, qrSvg(joinUrl(v.code)), h('p', { class: 'muted', style: 'margin-top:8px' }, 'QR을 찍거나 아래 코드를 입력하세요')),
      h('div', { style: 'display:flex;flex-direction:column;gap:12px' },
        h('p', { class: 'center muted' }, `${location.host} 에서 방 코드 입력`),
        h('div', { class: 'code' }, v.code),
        h('div', { class: 'card' }, h('p', { class: 'center muted', style: 'margin-bottom:10px' }, v.players.length ? `입장한 사람 ${v.players.length}명` : '아직 아무도 없어요. 기다리는 중…'), playerChips(v)))),
    h('div', { class: 'card soft' }, h('b', null, '오늘의 질문 '), v.questions.map((q, i) => h('div', null, `${i + 1}. ${q.text}`))),
    h('a', { class: 'btn ghost', href: `/play.html?code=${v.code}`, target: '_blank', rel: 'noopener', style: 'text-align:center;text-decoration:none;line-height:28px' }, '나도 참가하기 (새 탭)'),
    phoneControlLink(),
  ];
}

function writingScreen(v) {
  return [
    h('div', { class: 'center' }, h('span', { class: 'step' }, '답 쓰기'), h('h1', { style: 'margin-top:8px' }, '폰으로 답을 써 주세요'), h('p', { class: 'muted' }, '🤫 다른 사람 답은 보이지 않아요')),
    timerEl(),
    h('div', { class: 'card soft' }, v.questions.map((q, i) => h('div', { class: 'big-q' }, `${i + 1}. ${q.text}`))),
    h('div', { class: 'card' }, h('p', { class: 'center muted', style: 'margin-bottom:10px' }, `${v.writing.doneCount}/${v.writing.total}명 제출`), playerChips(v, { showDone: true })),
  ];
}

function guessingScreen(v) {
  const r = v.round;
  return [
    h('div', { style: 'display:flex;justify-content:space-between;align-items:center' }, h('span', { class: 'step' }, `${r.index + 1} / ${r.total}번째`), h('span', { class: 'muted' }, `${r.votedCount}/${r.voterTotal}명 투표 완료`)),
    timerEl(),
    h('div', { class: 'q center big-q' }, r.questionText),
    h('div', { class: 'answer' }, `“${r.answerText}”`),
    h('h2', { class: 'center' }, '이 답은 누가 썼을까요? 🕵️'),
    h('p', { class: 'muted center' }, '폰에서 투표해 주세요 (내 답에는 투표할 수 없어요)'),
  ];
}

function revealScreen(v) {
  const r = v.round;
  const head = [
    h('span', { class: 'step', style: 'align-self:flex-start' }, `${r.index + 1} / ${r.total}번째 정답`),
    h('div', { class: 'q center big-q' }, r.questionText),
    h('div', { class: 'answer' }, `“${r.answerText}”`),
  ];
  if (drumUntil > Date.now()) return [...head, h('div', { class: 'drum' }, '🥁 두구두구두구…')];
  return [
    ...head,
    h('div', { class: 'reveal-name' }, `${r.author.name} 🎉`),
    h('div', { class: 'card' }, tallyView(r)),
    r.correctVoters.length > 0 ? h('p', { class: 'center' }, `👏 맞힌 사람: ${r.correctVoters.join(', ')}`) : h('p', { class: 'center' }, '아무도 못 맞혔어요! 😲'),
    h('div', { class: 'say', style: 'font-size:1.2em' }, `🎤 ${r.author.name}님, 이 답에 대해 한마디 부탁해요!`),
  ];
}

function finalScreen(v) {
  const f = v.final;
  return [
    h('div', { class: 'center' }, h('div', { style: 'font-size:3em' }, '🎉'), h('h1', null, '오늘의 재미 상')),
    awardsView(f),
    h('h2', { class: 'center', style: 'margin-top:8px' }, '오늘 나온 이야기'),
    recapView(f),
    h('p', { class: 'muted center' }, '🧹 이 방의 답과 기록은 곧 모두 삭제돼요.'),
  ];
}

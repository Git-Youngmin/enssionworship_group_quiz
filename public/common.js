// 호스트·참가자 화면 공통 도우미 (빌드 도구 없이 ES 모듈로 동작)
import qrcode from './vendor/qrcode.mjs';

// ───────────── DOM 도우미 ─────────────
// h('div', {class:'card', onclick: fn}, '글자', 자식요소...) — 글자는 항상 textContent 로 넣어 XSS 를 막는다
export function h(tag, props, ...kids) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(props ?? {})) {
    if (v == null || v === false) continue;
    if (k.startsWith('on')) el.addEventListener(k.slice(2), v);
    else if (k === 'class') el.className = v;
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, v);
  }
  const add = (c) => {
    if (c == null || c === false) return;
    if (Array.isArray(c)) return c.forEach(add);
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  };
  kids.forEach(add);
  return el;
}

export const $ = (sel, root = document) => root.querySelector(sel);

export function mount(root, ...kids) {
  root.replaceChildren(...kids.flat(Infinity).filter(Boolean));
}

export function toast(msg, ms = 2600) {
  document.querySelector('.toast')?.remove();
  const t = h('div', { class: 'toast', role: 'status' }, msg);
  document.body.append(t);
  setTimeout(() => t.remove(), ms);
}

// ───────────── 저장소 (막혀 있어도 화면이 동작하도록) ─────────────
export const store = {
  get(k) {
    try { return JSON.parse(localStorage.getItem(k)); } catch { return null; }
  },
  set(k, v) {
    try { localStorage.setItem(k, JSON.stringify(v)); } catch {}
  },
  del(k) {
    try { localStorage.removeItem(k); } catch {}
  },
};

// ───────────── QR ─────────────
export function qrSvg(text) {
  const q = qrcode(0, 'M');
  q.addData(text);
  q.make();
  const n = q.getModuleCount();
  const ns = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(ns, 'svg');
  svg.setAttribute('viewBox', `0 0 ${n} ${n}`);
  svg.setAttribute('shape-rendering', 'crispEdges');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', '입장 QR 코드');
  const path = [];
  for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (q.isDark(r, c)) path.push(`M${c} ${r}h1v1h-1z`);
  const p = document.createElementNS(ns, 'path');
  p.setAttribute('d', path.join(''));
  p.setAttribute('fill', '#3b2412');
  svg.append(p);
  return h('div', { class: 'qr' }, svg);
}

// ───────────── 연결 ─────────────
const FATAL = { 4004: 'NO_ROOM', 4001: 'EXPIRED', 4003: 'KICKED' };

/**
 * 방에 연결하고, 끊기면 자동으로 다시 연결한다. (새로고침·폰 화면 꺼짐 대비)
 * hello() 는 연결할 때마다 불러서 최신 토큰을 보낸다.
 */
export function connectRoom({ code, hello, onView, onJoined, onError, onStatus, onFatal }) {
  let ws = null;
  let retry = 0;
  let timer = null;
  let pingTimer = null;
  let stopped = false;
  let fatalCode = null;

  const wsUrl = `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws/${code}`;

  function open() {
    clearTimeout(timer);
    if (stopped || (ws && ws.readyState <= 1)) return;
    onStatus?.('connecting');
    ws = new WebSocket(wsUrl);
    ws.onopen = () => {
      retry = 0;
      ws.send(JSON.stringify({ t: 'hello', ...hello() }));
      clearInterval(pingTimer);
      pingTimer = setInterval(() => ws?.readyState === 1 && ws.send('ping'), 25000);
    };
    ws.onmessage = (e) => {
      if (e.data === 'pong') return;
      let m;
      try { m = JSON.parse(e.data); } catch { return; }
      if (m.t === 'state') {
        onStatus?.('online');
        onView(m.view);
      } else if (m.t === 'joined') onJoined?.(m);
      else if (m.t === 'error') {
        if (m.code in { NO_ROOM: 1, EXPIRED: 1, KICKED: 1 }) fatalCode = m.code;
        onError?.(m);
      }
    };
    ws.onclose = (e) => {
      clearInterval(pingTimer);
      const fatal = fatalCode ?? FATAL[e.code];
      if (fatal) { stopped = true; return onFatal?.(fatal); }
      if (stopped) return;
      onStatus?.('offline');
      timer = setTimeout(open, Math.min(1000 * 2 ** retry++, 5000));
    };
    ws.onerror = () => {};
  }

  // 폰 화면이 다시 켜지면 바로 재연결
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && !stopped && (!ws || ws.readyState > 1)) { retry = 0; open(); }
  });
  window.addEventListener('online', () => { retry = 0; open(); });

  open();
  return {
    send(obj) {
      if (ws?.readyState === 1) { ws.send(JSON.stringify(obj)); return true; }
      toast('연결이 끊겨 있어요. 잠시만 기다려 주세요.');
      return false;
    },
    stop() { stopped = true; ws?.close(); },
  };
}

export const FATAL_TEXT = {
  NO_ROOM: '없는 방이거나 이미 끝난 방이에요. 방 코드를 다시 확인해 주세요.',
  EXPIRED: '방이 닫혔어요. 게임 데이터는 모두 삭제되었어요.',
  KICKED: '진행자가 방에서 내보냈어요.',
};

export function statusBanner(status) {
  document.querySelector('.banner')?.remove();
  if (status === 'online') return;
  const text = status === 'connecting' ? '연결하는 중이에요…' : '연결이 끊겼어요. 다시 연결하는 중이에요…';
  document.body.append(h('div', { class: 'banner', role: 'status' }, text));
}

// ───────────── 타이머 ─────────────
const clock = { deadline: null, total: 1, offset: 0, key: '' };

/** 새 화면 데이터가 올 때마다 호출 */
export function syncClock(view) {
  clock.offset = view.serverNow - Date.now();
  clock.deadline = view.deadline;
  const key = `${view.phase}:${view.round?.index ?? ''}`;
  if (key !== clock.key) {
    clock.key = key;
    clock.total = 1;
    if (view.deadline) clock.total = Math.max(1, view.deadline - view.serverNow);
  } else if (view.deadline) {
    clock.total = Math.max(clock.total, view.deadline - view.serverNow); // 시간 추가 대응
  }
}

export function timerEl() {
  return h('div', { class: 'timer', dataset: { timer: '1' } }, h('span', { class: 'num' }, ''), h('div', { class: 'bar' }, h('i')));
}

function tickTimers() {
  const left = clock.deadline == null ? null : Math.max(0, clock.deadline - (Date.now() + clock.offset));
  document.querySelectorAll('[data-timer]').forEach((el) => {
    if (left == null) { el.classList.add('hidden'); return; }
    el.classList.remove('hidden');
    el.querySelector('.num').textContent = `${Math.ceil(left / 1000)}`;
    el.querySelector('.bar > i').style.width = `${Math.min(100, (left / clock.total) * 100)}%`;
    el.classList.toggle('urgent', left <= 5000);
  });
}
setInterval(tickTimers, 250);

// ───────────── 화면 조각 (호스트·참가자 공용) ─────────────
export function playerChips(view, { showDone = false } = {}) {
  return h(
    'div',
    { class: 'chips' },
    view.players.map((p) =>
      h('span', { class: `chip${showDone && p.done ? ' done' : ''}${p.connected ? '' : ' off'}${view.me?.id === p.id ? ' me' : ''}` }, (showDone && p.done ? '✓ ' : '') + p.name),
    ),
  );
}

export function tallyView(round) {
  const max = Math.max(1, ...round.tally.map((t) => t.count));
  return h(
    'div',
    { class: 'tally' },
    round.tally.map((t) =>
      h(
        'div',
        { class: `tally-row${t.id === round.author.id ? ' win' : ''}` },
        h('span', { class: 'nm' }, t.name),
        h('div', { class: 'tb' }, h('i', { style: `width:${(t.count / max) * 100}%` })),
        h('span', null, `${t.count}`),
      ),
    ),
  );
}

export function awardsView(final) {
  if (!final.awards.length) return h('div', { class: 'card center' }, '오늘은 모두가 수수께끼였어요! 🎉');
  return final.awards.map((a, i) =>
    h('div', { class: 'card award', style: `--i:${i}` },
      h('div', { class: 'emo' }, a.emoji),
      h('div', { class: 'body' },
        h('div', { class: 'en' }, a.en ?? ''),
        h('div', { class: 'ttl' }, a.title),
        h('div', { class: 'who' }, a.names.join(' · ')),
        h('div', { class: 'muted' }, a.desc))),
  );
}

/** 시상식 제목 + 꽃가루 (움직임 줄이기 설정이면 CSS 에서 자동으로 멈춤) */
export function finaleTitle() {
  const bits = ['🎉', '✨', '🎊', '⭐'];
  const confetti = h('div', { class: 'confetti', 'aria-hidden': 'true' },
    Array.from({ length: 18 }, (_, i) => h('span', { style: `left:${(i * 37) % 100}%;animation-delay:${(i % 6) * 0.35}s;animation-duration:${3.2 + (i % 5) * 0.5}s` }, bits[i % bits.length])));
  return h('div', { class: 'center finale-title' }, confetti,
    h('div', { class: 'trophy' }, '🏆'),
    h('h1', { class: 'awards-h' }, 'AWARDS'),
    h('p', { class: 'muted' }, '오늘의 어워드'));
}

export function recapView(final) {
  return h('div', { class: 'recap' }, final.recap.map((r) => h('div', null, h('div', { class: 'muted' }, r.questionText), h('div', null, `“${r.answerText}” — `, h('b', null, r.authorName)))));
}

/** 진행자 조작 막대. view.phase 에 따라 지금 필요한 버튼만 보여 준다. */
export function controlsBar(view, send, { onCloseRoom } = {}) {
  const b = (label, onclick, cls = '', disabled = false) => h('button', { class: `btn ${cls}`, onclick, disabled }, label);
  const r = view.round;
  const btns = [];
  let hint = '';
  switch (view.phase) {
    case 'lobby': {
      const enough = view.players.length >= 2;
      btns.push(b('시작하기 ▶', () => send({ t: 'start' }), '', !enough));
      if (!enough) hint = '2명 이상 들어오면 시작할 수 있어요';
      break;
    }
    case 'writing':
      btns.push(b('+30초', () => send({ t: 'addTime', seconds: 30 }), 'ghost'), b('지금 마감 ⏭', () => send({ t: 'skip' })));
      break;
    case 'guessing':
      btns.push(b('+10초', () => send({ t: 'addTime', seconds: 10 }), 'ghost'), b('바로 공개 ⏭', () => send({ t: 'skip' })));
      break;
    case 'reveal':
      btns.push(b(r.index + 1 >= r.total ? '결과 보기 🏆' : '다음 문제 ▶', () => send({ t: 'next' })));
      break;
    case 'final':
      btns.push(
        b('방 닫고 데이터 지우기', () => {
          if (!confirm('방과 모든 답 데이터를 지울까요?')) return;
          send({ t: 'closeRoom' });
          setTimeout(() => onCloseRoom?.(), 400);
        }, 'ghost'),
      );
      break;
  }
  if (view.phase !== 'final' && view.phase !== 'lobby') {
    btns.push(b('게임 끝내기', () => confirm('지금 게임을 끝내고 결과를 볼까요?') && send({ t: 'endGame' }), 'ghost'));
  }
  return h('div', { class: 'controls' }, btns, hint && h('div', { class: 'tag' }, hint));
}

// ───────────── 초대 링크 ─────────────
export const joinUrl = (code) => `${location.origin}/play.html?code=${code}`;

/** 클립보드 복사. 막힌 환경(일부 인앱 브라우저)에서는 구형 방식으로 한 번 더 시도한다 */
export async function copyText(text) {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {}
  try {
    const ta = h('textarea', { style: 'position:fixed;opacity:0;top:0' });
    ta.value = text;
    document.body.append(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    return ok;
  } catch {
    return false;
  }
}

/** 초대 버튼들: 링크 복사(카톡 단톡방에 붙여 넣기) + 공유하기(지원하는 폰에서만) */
export function inviteButtons(code) {
  const url = joinUrl(code);
  const text = `누구일까? 퀴즈쇼에 들어오세요! 방 코드 ${code}`;
  const copy = h('button', { class: 'btn ghost', style: 'flex:1 1 150px', onclick: async () => {
    const ok = await copyText(`${text}\n${url}`);
    if (ok) toast('초대 링크를 복사했어요. 단톡방에 붙여 넣어 주세요!');
    else toast(`복사가 안 돼요. 아래 링크를 길게 눌러 복사해 주세요.\n${url}`, 8000);
  } }, '📋 초대 링크 복사');
  const share = typeof navigator.share === 'function'
    ? h('button', { class: 'btn ghost', style: 'flex:1 1 150px', onclick: () => navigator.share({ title: '누구일까? 퀴즈쇼', text, url }).catch(() => {}) }, '📤 공유하기')
    : null;
  return [copy, share];
}

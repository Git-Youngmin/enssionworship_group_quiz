// 진모임 "누구일까?" 퀴즈쇼 — 순수 게임 규칙 모듈
//
// - Durable Object, 네트워크, 시간, 난수에 직접 의존하지 않는다.
//   (시간은 ctx.now, 난수는 ctx.rng 로 주입받는다 → 컴퓨터에서 단위 테스트 가능)
// - reduce(state, action, ctx) 는 입력 state 를 바꾸지 않고 새 state 를 돌려준다.
// - viewFor(state, viewer) 는 "그 사람에게 보내도 되는 정보"만 담은 객체를 만든다.
//   정답 작성자는 reveal 단계 전에는 어떤 viewer 에게도 들어가지 않는다.

export const LIMITS = Object.freeze({
  MAX_PLAYERS: 30,
  NAME_MAX: 12, // 닉네임 최대 글자 수
  ANSWER_MAX: 80, // 답 최대 글자 수
  QUESTION_MAX: 60, // 직접 추가하는 질문 최대 글자 수
  MIN_QUESTIONS: 1,
  MAX_QUESTIONS: 5,
  MIN_PLAYERS_TO_START: 2,
  MAX_ROUNDS: 12,
  WRITE_SECONDS: [20, 300], // 문항당 쓰기 시간 범위
  GUESS_SECONDS: [10, 120], // 투표 시간 범위
});

export const DEFAULTS = Object.freeze({
  writeSecondsPerQuestion: 60,
  guessSeconds: 30,
  roundCount: null, // null 이면 질문 수와 같게
});

export const TTL = Object.freeze({
  IDLE_MS: 3 * 60 * 60 * 1000, // 아무 활동 없으면 3시간 뒤 방 삭제
  FINAL_MS: 30 * 60 * 1000, // 게임 종료 화면은 30분만 유지 후 삭제
});

export const PHASE = Object.freeze({
  LOBBY: 'lobby',
  WRITING: 'writing',
  GUESSING: 'guessing',
  REVEAL: 'reveal',
  FINAL: 'final',
});

// 오류 코드 → 화면에 보여 줄 한국어 문구
export const ERRORS = Object.freeze({
  BAD_ACTION: '알 수 없는 요청이에요.',
  NOT_HOST: '진행자만 할 수 있어요.',
  WRONG_PHASE: '지금은 할 수 없는 동작이에요.',
  ROOM_FULL: `방이 가득 찼어요. (최대 ${LIMITS.MAX_PLAYERS}명)`,
  NAME_EMPTY: '닉네임을 입력해 주세요.',
  NAME_TOO_LONG: `닉네임은 ${LIMITS.NAME_MAX}자까지 쓸 수 있어요.`,
  NAME_TAKEN: '같은 닉네임으로 참가 중인 사람이 있어요. 본인이라면 잠시 뒤 다시 시도하거나, 다른 닉네임을 써 주세요.',
  BAD_TOKEN: '참가 정보가 만료되었어요. 닉네임을 다시 입력해 주세요.',
  GAME_OVER: '이미 끝난 게임이에요.',
  NOT_PLAYER: '먼저 방에 입장해 주세요.',
  ANSWER_TOO_LONG: `답은 ${LIMITS.ANSWER_MAX}자까지 쓸 수 있어요.`,
  STALE_ROUND: '이미 다음 문제로 넘어갔어요.',
  OWN_ANSWER: '내가 쓴 답에는 투표할 수 없어요.',
  BAD_TARGET: '그 사람에게는 투표할 수 없어요.',
  NOT_ENOUGH_PLAYERS: `최소 ${LIMITS.MIN_PLAYERS_TO_START}명이 있어야 시작할 수 있어요.`,
  BAD_QUESTIONS: `질문은 ${LIMITS.MIN_QUESTIONS}~${LIMITS.MAX_QUESTIONS}개, 각 ${LIMITS.QUESTION_MAX}자 이내로 골라 주세요.`,
  BAD_SETTINGS: '설정 값이 올바르지 않아요.',
  BAD_PLAYER: '없는 참가자예요.',
});

function fail(code) {
  return { ok: false, error: { code, message: ERRORS[code] ?? ERRORS.BAD_ACTION } };
}

// ───────────────────────── 문자열 정리 ─────────────────────────

// 제어문자 제거, 공백 하나로 합치기, 앞뒤 공백 제거
export function cleanText(s) {
  if (typeof s !== 'string') return '';
  return s
    .normalize('NFC')
    .replace(/[\u0000-\u001F\u007F\u200B-\u200F\u2028-\u202E\u2066-\u2069\uFEFF]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// 글자 수(코드 포인트 기준, 한글 1자 = 1)
export function charLength(s) {
  return [...s].length;
}

// 닉네임 중복 비교용 키 (대소문자·공백 무시)
export function nameKey(name) {
  return cleanText(name).toLowerCase().replace(/\s/g, '');
}

// ───────────────────────── 방 만들기 ─────────────────────────

/**
 * 새 방 상태를 만든다.
 * @param {{code:string, hostToken:string, questions:Array<{id?:string,text:string,level?:string}>, now:number, settings?:object}} p
 */
export function createRoom({ code, hostToken, questions, now, settings = {} }) {
  const qs = normalizeQuestions(questions);
  if (!qs) throw new Error('잘못된 기본 질문');
  return {
    code,
    hostToken,
    phase: PHASE.LOBBY,
    version: 0,
    seq: 0, // 참가자 id 발급용
    createdAt: now,
    lastActivity: now,
    expireAt: now + TTL.IDLE_MS,
    deadline: null,
    settings: { ...DEFAULTS, ...pickSettings(settings) },
    questions: qs,
    players: [], // {id, name, token, connected, joinedAt}
    answers: {}, // writing 단계에서만 사용: {playerId: {qid: text}}
    done: {}, // writing 단계 제출 완료: {playerId: true}
    answerers: [], // 답을 하나라도 낸 참가자 id (투표 후보)
    rounds: [], // {qid, questionText, text, authorId, authorName, votes:{voterId: targetId}, revealed}
    roundIndex: -1,
    finishedAt: null,
  };
}

function normalizeQuestions(list) {
  if (!Array.isArray(list)) return null;
  if (list.length < LIMITS.MIN_QUESTIONS || list.length > LIMITS.MAX_QUESTIONS) return null;
  const out = [];
  const used = new Set();
  for (let i = 0; i < list.length; i++) {
    const q = list[i] ?? {};
    const text = cleanText(q.text);
    if (!text || charLength(text) > LIMITS.QUESTION_MAX) return null;
    let id = typeof q.id === 'string' && /^[a-z0-9_-]{1,20}$/i.test(q.id) ? q.id : `q${i + 1}`;
    if (used.has(id)) id = `q${i + 1}_${out.length}`;
    used.add(id);
    const level = ['light', 'middle', 'deep'].includes(q.level) ? q.level : 'custom';
    out.push({ id, text, level });
  }
  return out;
}

function pickSettings(s) {
  const out = {};
  if (s == null || typeof s !== 'object') return out;
  if ('writeSecondsPerQuestion' in s) out.writeSecondsPerQuestion = s.writeSecondsPerQuestion;
  if ('guessSeconds' in s) out.guessSeconds = s.guessSeconds;
  if ('roundCount' in s) out.roundCount = s.roundCount;
  return out;
}

function inRange(n, [lo, hi]) {
  return Number.isInteger(n) && n >= lo && n <= hi;
}

// ───────────────────────── 조회 도우미 ─────────────────────────

const findPlayer = (state, id) => state.players.find((p) => p.id === id);
const currentRound = (state) => state.rounds[state.roundIndex] ?? null;
const isHost = (state, action) =>
  typeof action.hostToken === 'string' && action.hostToken.length > 0 && action.hostToken === state.hostToken;

/** 다음에 깨어나야 할 시각(타이머 마감 또는 방 삭제 시각) */
export function nextAlarm(state) {
  return state.deadline != null ? Math.min(state.deadline, state.expireAt) : state.expireAt;
}

/** 방 데이터를 지워야 하는가 */
export function isExpired(state, now) {
  return now >= state.expireAt;
}

/** 참가자 토큰으로 참가자 id 찾기 (DO 가 재접속 처리에 사용) */
export function playerIdByToken(state, token) {
  if (typeof token !== 'string' || !token) return null;
  return state.players.find((p) => p.token === token)?.id ?? null;
}

// ───────────────────────── 상태 전이 ─────────────────────────

const HOST_ACTIONS = new Set(['updateSettings', 'start', 'addTime', 'skip', 'next', 'kick', 'endGame']);

/**
 * 상태 전이 함수. 입력 state 는 바꾸지 않는다.
 * @returns {{ok:true, state:object, result?:object} | {ok:false, error:{code,message}}}
 */
export function reduce(state, action, ctx) {
  if (!action || typeof action.type !== 'string') return fail('BAD_ACTION');
  if (HOST_ACTIONS.has(action.type) && !isHost(state, action)) return fail('NOT_HOST');

  const s = structuredClone(state);
  const now = ctx.now;
  const rng = ctx.rng ?? Math.random;
  const handler = HANDLERS[action.type];
  if (!handler) return fail('BAD_ACTION');

  const r = handler(s, action, now, rng);
  if (r && r.ok === false) return r;

  // tick·연결 상태 변경은 "활동"으로 치지 않는다 (빈 방이 계속 살아 있지 않게)
  if (action.type !== 'tick' && action.type !== 'setConnected') {
    s.lastActivity = now;
    if (s.phase !== PHASE.FINAL) s.expireAt = now + TTL.IDLE_MS;
  }
  s.version += 1;
  return { ok: true, state: s, result: r?.result };
}

const HANDLERS = {
  // 참가자 입장. token 은 DO 가 암호학적 난수로 만들어 넘긴다.
  join(s, a, now) {
    if (s.phase === PHASE.FINAL) return fail('GAME_OVER');
    const name = cleanText(a.name);
    if (!name) return fail('NAME_EMPTY');
    if (charLength(name) > LIMITS.NAME_MAX) return fail('NAME_TOO_LONG');
    if (typeof a.token !== 'string' || a.token.length < 16) return fail('BAD_ACTION');
    if (s.players.some((p) => p.token === a.token)) return fail('BAD_ACTION');
    const key = nameKey(name);
    const same = s.players.find((p) => nameKey(p.name) === key);
    if (same) {
      // 지금 접속 중인 사람의 닉네임이면 거절.
      // 연결이 끊긴 사람의 닉네임이면 "그 사람이 저장 정보를 잃고 다시 온 것"으로 보고 자리를 이어 준다.
      // (카톡 인앱 브라우저 등에서 토큰이 사라져도 같은 닉네임으로 복귀할 수 있게)
      if (same.connected) return fail('NAME_TAKEN');
      same.token = a.token; // 이전 토큰은 이 순간부터 쓸 수 없다
      same.connected = true;
      return { result: { playerId: same.id, reclaimed: true } };
    }
    if (s.players.length >= LIMITS.MAX_PLAYERS) return fail('ROOM_FULL');
    s.seq += 1;
    const id = `p${s.seq}`;
    s.players.push({ id, name, token: a.token, connected: true, joinedAt: now });
    return { result: { playerId: id } };
  },

  // 새로고침·재접속: 같은 토큰이면 같은 사람으로 복귀
  resume(s, a) {
    const p = s.players.find((x) => typeof a.token === 'string' && x.token === a.token);
    if (!p) return fail('BAD_TOKEN');
    p.connected = true;
    return { result: { playerId: p.id } };
  },

  // DO 가 웹소켓 연결/끊김 시 호출 (표시용)
  setConnected(s, a) {
    const p = findPlayer(s, a.playerId);
    if (!p) return fail('BAD_PLAYER');
    p.connected = !!a.connected;
  },

  updateSettings(s, a) {
    if (s.phase !== PHASE.LOBBY) return fail('WRONG_PHASE');
    if (a.questions !== undefined) {
      const qs = normalizeQuestions(a.questions);
      if (!qs) return fail('BAD_QUESTIONS');
      s.questions = qs;
    }
    const st = pickSettings(a);
    if (st.writeSecondsPerQuestion !== undefined && !inRange(st.writeSecondsPerQuestion, LIMITS.WRITE_SECONDS))
      return fail('BAD_SETTINGS');
    if (st.guessSeconds !== undefined && !inRange(st.guessSeconds, LIMITS.GUESS_SECONDS)) return fail('BAD_SETTINGS');
    if (st.roundCount !== undefined && st.roundCount !== null && !inRange(st.roundCount, [1, LIMITS.MAX_ROUNDS]))
      return fail('BAD_SETTINGS');
    Object.assign(s.settings, st);
  },

  start(s, a, now) {
    if (s.phase !== PHASE.LOBBY) return fail('WRONG_PHASE');
    if (s.players.length < LIMITS.MIN_PLAYERS_TO_START) return fail('NOT_ENOUGH_PLAYERS');
    s.phase = PHASE.WRITING;
    s.answers = {};
    s.done = {};
    s.deadline = now + s.settings.writeSecondsPerQuestion * s.questions.length * 1000;
  },

  // 답 제출(여러 번 제출하면 마지막 것으로 덮어씀). 빈 칸은 "답 안 함".
  submitAnswers(s, a, now, rng) {
    if (s.phase !== PHASE.WRITING) return fail('WRONG_PHASE');
    const p = findPlayer(s, a.playerId);
    if (!p) return fail('NOT_PLAYER');
    const input = a.answers && typeof a.answers === 'object' ? a.answers : {};
    const mine = {};
    for (const q of s.questions) {
      const text = cleanText(input[q.id]);
      if (!text) continue;
      if (charLength(text) > LIMITS.ANSWER_MAX) return fail('ANSWER_TOO_LONG');
      mine[q.id] = text;
    }
    s.answers[p.id] = mine;
    s.done[p.id] = true;
    // 접속 중인 사람이 모두 제출하면 바로 다음 단계로
    const waiting = s.players.filter((x) => x.connected && !s.done[x.id]);
    if (waiting.length === 0) endWriting(s, now, rng);
  },

  vote(s, a, now) {
    if (s.phase !== PHASE.GUESSING) return fail('WRONG_PHASE');
    if (a.roundIndex !== s.roundIndex) return fail('STALE_ROUND');
    const p = findPlayer(s, a.playerId);
    if (!p) return fail('NOT_PLAYER');
    const round = currentRound(s);
    if (round.authorId === p.id) return fail('OWN_ANSWER');
    if (a.targetId === p.id || !s.answerers.includes(a.targetId)) return fail('BAD_TARGET');
    round.votes[p.id] = a.targetId; // 바꾸면 덮어씀
    // 작성자를 뺀 모든 참가자가 투표하면 바로 공개.
    // 접속이 끊긴 사람을 기다리지 않게 하면 편하지만, 그러면 "기다리는 사람 수"가 작성자에 따라 달라져
    // 투표 수와 접속 표시만으로 "작성자가 끊긴 사람 중에 있다"를 추리할 수 있게 된다.
    // 익명성이 우선이라 접속 여부는 조건에 넣지 않는다. 막히면 진행자가 "바로 공개"를 누른다.
    const voters = s.players.filter((x) => x.id !== round.authorId);
    if (voters.every((x) => round.votes[x.id] !== undefined)) endGuessing(s);
  },

  // 알람(타이머 마감) 처리. 마감 전이면 아무 일도 하지 않는다.
  tick(s, a, now, rng) {
    if (s.deadline == null || now < s.deadline) return;
    if (s.phase === PHASE.WRITING) endWriting(s, now, rng);
    else if (s.phase === PHASE.GUESSING) endGuessing(s);
  },

  addTime(s, a, now) {
    if (s.deadline == null) return fail('WRONG_PHASE');
    const sec = a.seconds;
    if (!Number.isInteger(sec) || Math.abs(sec) > 300 || sec === 0) return fail('BAD_SETTINGS');
    s.deadline = Math.max(now, s.deadline + sec * 1000);
  },

  // 현재 타이머 단계를 바로 끝냄 (writing → 라운드 시작, guessing → 공개)
  skip(s, a, now, rng) {
    if (s.phase === PHASE.WRITING) endWriting(s, now, rng);
    else if (s.phase === PHASE.GUESSING) endGuessing(s);
    else return fail('WRONG_PHASE');
  },

  next(s, a, now) {
    if (s.phase !== PHASE.REVEAL) return fail('WRONG_PHASE');
    if (s.roundIndex + 1 < s.rounds.length) startGuessing(s, s.roundIndex + 1, now);
    else toFinal(s, now);
  },

  kick(s, a) {
    if (s.phase !== PHASE.LOBBY && s.phase !== PHASE.WRITING) return fail('WRONG_PHASE');
    const idx = s.players.findIndex((p) => p.id === a.playerId);
    if (idx < 0) return fail('BAD_PLAYER');
    s.players.splice(idx, 1);
    delete s.answers[a.playerId];
    delete s.done[a.playerId];
    return { result: { kicked: a.playerId } };
  },

  endGame(s, a, now) {
    if (s.phase === PHASE.FINAL) return fail('GAME_OVER');
    toFinal(s, now);
  },
};

function endWriting(s, now, rng) {
  s.answerers = s.players.filter((p) => Object.keys(s.answers[p.id] ?? {}).length > 0).map((p) => p.id);
  s.rounds = buildRounds(s, rng);
  // 라운드에 쓰이지 않은 답은 즉시 버린다 (서버에도 남기지 않음)
  s.answers = {};
  s.done = {};
  if (s.rounds.length === 0) toFinal(s, now);
  else startGuessing(s, 0, now);
}

/**
 * 공개할 답 고르기.
 * - 라운드 i 는 질문 i % Q 를 우선 사용
 * - 아직 덜 뽑힌 작성자를 우선 (여러 사람이 골고루 주인공이 되게), 동점은 무작위
 */
export function buildRounds(s, rng) {
  const pool = []; // {qid, authorId, text}
  for (const p of s.players) {
    for (const q of s.questions) {
      const text = s.answers[p.id]?.[q.id];
      if (text) pool.push({ qid: q.id, authorId: p.id, text });
    }
  }
  const want = Math.min(s.settings.roundCount ?? s.questions.length, LIMITS.MAX_ROUNDS, pool.length);
  const featured = {};
  const rounds = [];
  for (let i = 0; i < want; i++) {
    const q = s.questions[i % s.questions.length];
    let cands = pool.filter((x) => x.qid === q.id);
    if (cands.length === 0) cands = pool;
    const minCount = Math.min(...cands.map((x) => featured[x.authorId] ?? 0));
    cands = cands.filter((x) => (featured[x.authorId] ?? 0) === minCount);
    const pick = cands[Math.floor(rng() * cands.length)];
    pool.splice(pool.indexOf(pick), 1);
    featured[pick.authorId] = minCount + 1;
    const qq = s.questions.find((x) => x.id === pick.qid);
    rounds.push({
      qid: pick.qid,
      questionText: qq.text,
      text: pick.text,
      authorId: pick.authorId,
      authorName: findPlayer(s, pick.authorId).name,
      votes: {},
      revealed: false,
    });
  }
  return rounds;
}

function startGuessing(s, i, now) {
  s.phase = PHASE.GUESSING;
  s.roundIndex = i;
  s.deadline = now + s.settings.guessSeconds * 1000;
}

function endGuessing(s) {
  s.phase = PHASE.REVEAL;
  s.deadline = null;
  currentRound(s).revealed = true;
}

function toFinal(s, now) {
  s.phase = PHASE.FINAL;
  s.deadline = null;
  s.answers = {};
  s.done = {};
  s.finishedAt = now;
  s.expireAt = now + TTL.FINAL_MS;
}

// ───────────────────────── 점수·어워드 ─────────────────────────

/** 공개된 라운드만으로 점수 계산 */
export function computeStats(state) {
  const per = {};
  const get = (id) =>
    (per[id] ??= { correct: 0, guesses: 0, featured: 0, votesOnMe: 0, caughtVotes: 0, wrongVotesOnMe: 0 });
  for (const p of state.players) get(p.id);
  for (const r of state.rounds) {
    if (!r.revealed) continue;
    const author = get(r.authorId);
    author.featured += 1;
    for (const [voterId, targetId] of Object.entries(r.votes)) {
      const v = get(voterId);
      v.guesses += 1;
      if (targetId === r.authorId) {
        v.correct += 1;
        author.caughtVotes += 1;
      } else {
        get(targetId).wrongVotesOnMe += 1;
      }
      author.votesOnMe += 1;
    }
  }
  return per;
}

/** 어워드 목록. 순위표 대신 "수상" 위주로 보여 준다. */
export function computeAwards(state) {
  const stats = computeStats(state);
  const nameOf = (id) => findPlayer(state, id)?.name ?? state.rounds.find((r) => r.authorId === id)?.authorName ?? '?';
  const ids = Object.keys(stats);
  const awards = [];
  const best = (list, score, pickMax) => {
    if (list.length === 0) return [];
    const vals = list.map(score);
    const target = pickMax ? Math.max(...vals) : Math.min(...vals);
    return list.filter((_, i) => vals[i] === target);
  };

  const detectives = best(ids.filter((id) => stats[id].correct > 0), (id) => stats[id].correct, true);
  if (detectives.length)
    awards.push({
      key: 'detective',
      title: '최고 탐정',
      en: 'Best Detective',
      names: detectives.map(nameOf),
      desc: `${stats[detectives[0]].correct}번이나 정확히 맞혔어요!`,
    });

  const authors = ids.filter((id) => stats[id].featured > 0 && stats[id].votesOnMe > 0);
  const ratio = (id) => stats[id].caughtVotes / stats[id].votesOnMe;
  const mystery = best(authors, ratio, false);
  const obvious = best(authors, ratio, true);
  if (authors.length >= 2 && ratio(mystery[0]) < ratio(obvious[0])) {
    awards.push({
      key: 'mystery',
      title: '가장 수수께끼 같은 사람',
      en: 'Most Mysterious',
      names: mystery.map(nameOf),
      desc: '아무도 예상 못 했어요. 알면 알수록 새로운 사람!',
    });
    awards.push({
      key: 'obvious',
      title: '가장 쉽게 들킨 사람',
      en: 'Open Book',
      names: obvious.map(nameOf),
      desc: '모두가 한눈에 알아봤어요. 그만큼 잘 알려진 사람!',
    });
  }

  const suspects = best(ids.filter((id) => stats[id].wrongVotesOnMe >= 2), (id) => stats[id].wrongVotesOnMe, true);
  if (suspects.length)
    awards.push({
      key: 'suspect',
      title: '다들 너인 줄 알았어',
      en: 'The Usual Suspect',
      names: suspects.map(nameOf),
      desc: '내 답이 아닌데도 가장 많이 지목받았어요.',
    });

  return awards;
}

// ───────────────────────── 클라이언트용 화면 데이터 ─────────────────────────

/**
 * viewer 에게 보낼 데이터만 골라 만든다.
 * - 토큰(참가자·진행자)은 절대 포함하지 않는다.
 * - 다른 사람의 답 원문은 공개 중인 라운드의 답 하나만 포함한다.
 * - 작성자 정보(authorId/authorName)는 그 라운드가 공개(revealed)된 뒤에만 포함한다.
 * @param {object} state
 * @param {{playerId?:string|null, isHost?:boolean}} viewer
 * @param {number} now
 */
export function viewFor(state, viewer = {}, now = Date.now()) {
  const me = viewer.playerId ? findPlayer(state, viewer.playerId) : null;
  const v = {
    code: state.code,
    phase: state.phase,
    version: state.version,
    serverNow: now,
    deadline: state.deadline,
    isHost: !!viewer.isHost,
    me: me ? { id: me.id, name: me.name } : null,
    settings: { ...state.settings },
    limits: { nameMax: LIMITS.NAME_MAX, answerMax: LIMITS.ANSWER_MAX, maxPlayers: LIMITS.MAX_PLAYERS },
    questions: state.questions.map((q) => ({ id: q.id, text: q.text, level: q.level })),
    players: state.players.map((p) => ({
      id: p.id,
      name: p.name,
      connected: p.connected,
      ...(state.phase === PHASE.WRITING ? { done: !!state.done[p.id] } : {}),
    })),
  };

  if (state.phase === PHASE.WRITING) {
    v.writing = {
      doneCount: state.players.filter((p) => state.done[p.id]).length,
      total: state.players.length,
      myAnswers: me ? { ...(state.answers[me.id] ?? {}) } : null,
      submitted: me ? !!state.done[me.id] : false,
    };
  }

  if (state.phase === PHASE.GUESSING || state.phase === PHASE.REVEAL) {
    const r = currentRound(state);
    const round = {
      index: state.roundIndex,
      total: state.rounds.length,
      questionText: r.questionText,
      answerText: r.text,
      // 후보: 답을 낸 사람 전체(나 제외). 작성자와 무관하게 모두에게 같은 목록.
      candidates: state.answerers.filter((id) => !me || id !== me.id).map((id) => ({ id, name: findPlayer(state, id)?.name ?? '?' })),
      votedCount: Object.keys(r.votes).length,
      // 분모는 "참가자 수 - 1"로 고정 (작성자가 누군지와 무관한 값)
      voterTotal: Math.max(0, state.players.length - 1),
      myVote: me ? (r.votes[me.id] ?? null) : null,
      // 본인에게만: "이건 내 답이에요" (다른 사람 화면에는 들어가지 않음)
      isMine: !!me && r.authorId === me.id,
    };
    if (r.revealed) {
      const tally = {};
      for (const t of Object.values(r.votes)) tally[t] = (tally[t] ?? 0) + 1;
      round.author = { id: r.authorId, name: r.authorName };
      round.tally = state.answerers
        .map((id) => ({ id, name: findPlayer(state, id)?.name ?? '?', count: tally[id] ?? 0 }))
        .filter((x) => x.count > 0 || x.id === r.authorId)
        .sort((x, y) => y.count - x.count);
      round.correctVoters = Object.entries(r.votes)
        .filter(([, t]) => t === r.authorId)
        .map(([vid]) => findPlayer(state, vid)?.name ?? '?');
      round.myCorrect = me ? r.votes[me.id] === r.authorId : null;
    }
    v.round = round;
  }

  if (state.phase === PHASE.FINAL) {
    const stats = computeStats(state);
    v.final = {
      awards: computeAwards(state),
      recap: state.rounds
        .filter((r) => r.revealed)
        .map((r) => ({ questionText: r.questionText, answerText: r.text, authorName: r.authorName })),
      mine: me ? { correct: stats[me.id]?.correct ?? 0, guesses: stats[me.id]?.guesses ?? 0 } : null,
      expireAt: state.expireAt,
    };
  }

  return v;
}

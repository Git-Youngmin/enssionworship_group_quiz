// 방 하나 = Durable Object 하나. 상태 기계(game.js)를 감싸서
// WebSocket 메시지 처리, 저장, 타이머(alarm), 자동 삭제를 맡는다.
//
// - Hibernation API: 아무도 말하지 않을 때는 메모리에서 내려가 비용이 들지 않는다.
// - 메시지 처리는 await 없이 동기적으로 끝나므로 Durable Object 안에서 항상 순서대로 처리된다.
// - 상태는 SQLite 기반 KV 에 JSON 한 덩어리('state')로 저장한다.
import { DurableObject } from 'cloudflare:workers';
import { createRoom, reduce, viewFor, nextAlarm, isExpired, playerIdByToken, PHASE } from './game.js';

const MAX_MESSAGE_BYTES = 4096;
const MAX_SOCKETS = 80; // 한 방에 동시에 붙을 수 있는 연결 수 (참가자 30명 + 여러 탭·화면 여유)
const RATE_WINDOW_MS = 10_000;
const RATE_MAX = 40; // 연결 하나가 10초에 보낼 수 있는 메시지 수 (평소엔 많아야 몇 개)
const RATE_HARD = 200; // 이만큼 넘으면 연결을 끊는다

// WebSocket 종료 코드 (화면에서 안내 문구를 고르는 데 사용)
export const CLOSE = Object.freeze({ NO_ROOM: 4004, EXPIRED: 4001, KICKED: 4003 });

const randomToken = () =>
  [...crypto.getRandomValues(new Uint8Array(16))].map((b) => b.toString(16).padStart(2, '0')).join('');

export class Room extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.state = undefined; // undefined = 아직 읽지 않음, null = 방 없음
    this.alarmAt = undefined;
    this.rate = new WeakMap(); // 연결별 메시지 속도 (메모리에만 둠)
    // 화면이 보내는 'ping' 에는 DO 를 깨우지 않고 'pong' 으로 자동 응답
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }

  // ───────────── 저장·불러오기 ─────────────

  load() {
    if (this.state === undefined) this.state = this.ctx.storage.kv.get('state') ?? null;
    return this.state;
  }

  save(state) {
    this.state = state;
    this.ctx.storage.kv.put('state', state);
    this.schedule(state);
  }

  // 알람은 값이 바뀔 때만 다시 건다 (쓰기 횟수 절약)
  schedule(state) {
    const at = nextAlarm(state);
    if (at === this.alarmAt) return;
    this.alarmAt = at;
    void this.ctx.storage.setAlarm(at);
  }

  // ───────────── Worker 에서 부르는 메서드 (RPC) ─────────────

  /** 방 만들기. 같은 코드의 방이 이미 있으면 거절한다. */
  init({ code, hostToken, questions, settings }) {
    if (this.load()) return { ok: false, reason: 'EXISTS' };
    let state;
    try {
      state = createRoom({ code, hostToken, questions, settings, now: Date.now() });
    } catch {
      return { ok: false, reason: 'BAD', message: '질문 구성이 올바르지 않아요. (1~5개, 각 60자 이내)' };
    }
    this.save(state);
    return { ok: true };
  }

  /** 입장 화면에서 쓰는 방 요약 (작성자·답 정보 없음) */
  info() {
    const s = this.load();
    if (!s) return null;
    return { code: s.code, phase: s.phase, playerCount: s.players.length, full: s.players.length >= 30 };
  }

  // ───────────── WebSocket ─────────────

  async fetch(request) {
    if (request.headers.get('Upgrade') !== 'websocket') return new Response('WebSocket 연결이 필요해요.', { status: 426 });
    const { 0: client, 1: server } = new WebSocketPair();
    this.ctx.acceptWebSocket(server);
    if (this.ctx.getWebSockets().length > MAX_SOCKETS) {
      this.sendTo(server, { t: 'error', code: 'ROOM_BUSY', message: '지금 이 방에 연결이 너무 많아요. 잠시 후 다시 시도해 주세요.' });
      server.close(1013, 'busy');
    } else if (!this.load()) {
      // 브라우저는 업그레이드 실패 사유를 읽을 수 없으므로, 일단 연결한 뒤 이유를 알려 주고 닫는다
      this.sendTo(server, { t: 'error', code: 'NO_ROOM', message: '없는 방이거나 이미 끝난 방이에요.' });
      server.close(CLOSE.NO_ROOM, 'no room');
    } else {
      server.serializeAttachment({ hello: false });
    }
    return new Response(null, { status: 101, webSocket: client });
  }

  webSocketMessage(ws, raw) {
    if (typeof raw !== 'string' || raw.length > MAX_MESSAGE_BYTES) {
      return this.sendError(ws, 'BAD_ACTION', '알 수 없는 요청이에요.');
    }
    if (!this.allow(ws)) return;
    let msg;
    try {
      msg = JSON.parse(raw);
    } catch {
      return this.sendError(ws, 'BAD_ACTION', '알 수 없는 요청이에요.');
    }
    if (!msg || typeof msg !== 'object') return this.sendError(ws, 'BAD_ACTION', '알 수 없는 요청이에요.');

    const state = this.load();
    if (!state) {
      this.sendTo(ws, { t: 'error', code: 'NO_ROOM', message: '없는 방이거나 이미 끝난 방이에요.' });
      return ws.close(CLOSE.NO_ROOM, 'no room');
    }
    const att = ws.deserializeAttachment() ?? { hello: false };

    if (msg.t === 'hello') return this.onHello(ws, att, msg, state);
    if (!att.hello) return this.sendError(ws, 'BAD_ACTION', '먼저 연결 확인이 필요해요.');
    if (msg.t === 'join') return this.onJoin(ws, att, msg, state);
    if (msg.t === 'closeRoom') {
      if (!att.isHost) return this.sendError(ws, 'NOT_HOST', '진행자만 할 수 있어요.');
      return this.destroy(); // 진행자가 직접 방을 지우는 경우 (비동기지만 이후 이 방은 처리할 일이 없음)
    }

    const action = this.buildAction(msg, att, state);
    if (!action) return this.sendError(ws, 'BAD_ACTION', '알 수 없는 요청이에요.');
    this.apply(ws, action);
  }

  /** 연결 하나가 너무 빠르게 메시지를 보내면 무시한다 (오작동하는 폰 하나가 방 전체를 느리게 만들지 않게) */
  allow(ws) {
    const now = Date.now();
    let r = this.rate.get(ws);
    if (!r || now - r.start > RATE_WINDOW_MS) {
      r = { start: now, n: 0, warned: false };
      this.rate.set(ws, r);
    }
    r.n += 1;
    if (r.n > RATE_HARD) {
      try { ws.close(1008, 'too many messages'); } catch {}
      return false;
    }
    if (r.n > RATE_MAX) {
      if (!r.warned) {
        r.warned = true;
        this.sendError(ws, 'RATE_LIMIT', '너무 빨리 누르고 있어요. 잠시 후 다시 해 주세요.');
      }
      return false;
    }
    return true;
  }

  webSocketClose(ws, code) {
    try {
      ws.close(code === 1005 || code === 1006 ? 1000 : code, 'bye');
    } catch {}
    this.onDisconnect(ws);
  }

  webSocketError(ws) {
    this.onDisconnect(ws);
  }

  // ───────────── 메시지별 처리 ─────────────

  onHello(ws, att, msg, state) {
    const isHost = typeof msg.hostToken === 'string' && msg.hostToken.length > 0 && msg.hostToken === state.hostToken;
    if (typeof msg.hostToken === 'string' && msg.hostToken && !isHost) {
      this.sendError(ws, 'BAD_HOST_TOKEN', '진행자 정보가 맞지 않아요. 방을 새로 만들어 주세요.');
    }
    let playerId = null;
    let current = state;
    if (typeof msg.playerToken === 'string' && msg.playerToken) {
      playerId = playerIdByToken(state, msg.playerToken);
      if (playerId) {
        const r = reduce(state, { type: 'resume', token: msg.playerToken }, { now: Date.now(), rng: Math.random });
        if (r.ok) {
          current = r.state;
          this.save(current);
        }
      } else {
        this.sendError(ws, 'BAD_TOKEN', '참가 정보가 만료되었어요. 닉네임을 다시 입력해 주세요.');
      }
    }
    ws.serializeAttachment({ hello: true, isHost, playerId });
    this.sendView(ws);
    if (current !== state) this.broadcastPresence();
  }

  onJoin(ws, att, msg, state) {
    if (att.playerId) return this.sendError(ws, 'BAD_ACTION', '이미 입장했어요.');
    const token = randomToken();
    const r = reduce(state, { type: 'join', name: msg.name, token }, { now: Date.now(), rng: Math.random });
    if (!r.ok) return this.sendError(ws, r.error.code, r.error.message);
    this.save(r.state);
    const playerId = r.result.playerId;
    ws.serializeAttachment({ ...att, playerId });
    this.sendTo(ws, { t: 'joined', playerToken: token, playerId, reclaimed: !!r.result.reclaimed });
    this.broadcast();
  }

  /**
   * 클라이언트 메시지 → game.js 액션.
   * 신원(playerId, hostToken)은 연결에 저장된 값만 쓰고, 클라이언트가 보낸 값은 쓰지 않는다.
   */
  buildAction(msg, att, state) {
    switch (msg.t) {
      case 'submitAnswers':
        return { type: 'submitAnswers', playerId: att.playerId, answers: msg.answers };
      case 'vote':
        return { type: 'vote', playerId: att.playerId, roundIndex: msg.roundIndex, targetId: msg.targetId };
      case 'start':
      case 'skip':
      case 'next':
      case 'endGame':
        return { type: msg.t, hostToken: att.isHost ? state.hostToken : null };
      case 'addTime':
        return { type: 'addTime', hostToken: att.isHost ? state.hostToken : null, seconds: msg.seconds };
      case 'kick':
        return { type: 'kick', hostToken: att.isHost ? state.hostToken : null, playerId: msg.playerId };
      case 'updateSettings': {
        const a = { type: 'updateSettings', hostToken: att.isHost ? state.hostToken : null };
        for (const k of ['questions', 'writeSecondsPerQuestion', 'guessSeconds', 'roundCount']) {
          if (k in msg) a[k] = msg[k];
        }
        return a;
      }
      default:
        return null;
    }
  }

  apply(ws, action) {
    const r = reduce(this.load(), action, { now: Date.now(), rng: Math.random });
    if (!r.ok) return this.sendError(ws, r.error.code, r.error.message);
    this.save(r.state);
    if (action.type === 'kick') this.closePlayerSockets(action.playerId);
    this.broadcast();
  }

  // ───────────── 연결 끊김 ─────────────

  onDisconnect(ws) {
    const att = ws.deserializeAttachment();
    const state = this.load();
    if (!state || !att?.playerId) return;
    // 같은 사람의 다른 연결(탭)이 남아 있으면 끊긴 것으로 치지 않는다
    const others = this.ctx.getWebSockets().filter((w) => w !== ws && w.deserializeAttachment()?.playerId === att.playerId);
    if (others.length > 0) return;
    const r = reduce(state, { type: 'setConnected', playerId: att.playerId, connected: false }, { now: Date.now() });
    if (!r.ok) return;
    this.save(r.state);
    this.broadcastPresence();
  }

  closePlayerSockets(playerId) {
    for (const w of this.ctx.getWebSockets()) {
      if (w.deserializeAttachment()?.playerId === playerId) {
        this.sendTo(w, { t: 'error', code: 'KICKED', message: '진행자가 방에서 내보냈어요.' });
        try {
          w.close(CLOSE.KICKED, 'kicked');
        } catch {}
      }
    }
  }

  // ───────────── 타이머·자동 삭제 ─────────────

  async alarm() {
    const state = this.load();
    if (!state) return;
    const now = Date.now();
    if (isExpired(state, now)) return this.destroy();
    this.alarmAt = undefined; // 방금 울렸으므로 기록 초기화
    const r = reduce(state, { type: 'tick' }, { now, rng: Math.random });
    if (r.ok && (r.state.phase !== state.phase || r.state.roundIndex !== state.roundIndex)) {
      this.save(r.state);
      this.broadcast();
    } else {
      this.schedule(state); // 아직 마감 전이면 알람만 다시 건다
    }
  }

  /** 방과 모든 데이터를 지운다 */
  async destroy() {
    for (const w of this.ctx.getWebSockets()) {
      this.sendTo(w, { t: 'error', code: 'EXPIRED', message: '방이 닫혔어요. 데이터는 모두 삭제되었어요.' });
      try {
        w.close(CLOSE.EXPIRED, 'room closed');
      } catch {}
    }
    this.state = null;
    this.alarmAt = undefined;
    await this.ctx.storage.deleteAlarm();
    await this.ctx.storage.deleteAll();
  }

  // ───────────── 보내기 ─────────────

  sendTo(ws, obj) {
    try {
      ws.send(JSON.stringify(obj));
    } catch {}
  }

  sendError(ws, code, message) {
    this.sendTo(ws, { t: 'error', code, message });
  }

  /** 연결마다 "그 사람에게 보여도 되는 데이터"만 골라 보낸다 */
  sendView(ws) {
    const att = ws.deserializeAttachment();
    if (!att?.hello) return;
    const view = viewFor(this.load(), { playerId: att.playerId, isHost: att.isHost }, Date.now());
    this.sendTo(ws, { t: 'state', view });
  }

  broadcast() {
    for (const w of this.ctx.getWebSockets()) this.sendView(w);
  }

  // 입장·끊김 표시는 대기실과 답 쓰기 단계에서만 전체에 알린다 (메시지 수 절약)
  broadcastPresence() {
    const phase = this.load()?.phase;
    if (phase === PHASE.LOBBY || phase === PHASE.WRITING) this.broadcast();
  }
}

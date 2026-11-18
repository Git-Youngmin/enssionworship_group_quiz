// 진입점: 방 만들기 API, 방 확인 API, WebSocket 업그레이드, 정적 화면
import presets from '../public/questions.json';
import { Room } from './room.js';

export { Room };

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' },
  });

const hex = (bytes) => [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');

// 4자리 방 코드 (0000~9999)
function randomCode() {
  const n = crypto.getRandomValues(new Uint32Array(1))[0] % 10000;
  return String(n).padStart(4, '0');
}

const roomStub = (env, code) => env.ROOM.get(env.ROOM.idFromName(code));

export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const path = url.pathname;

    // POST /api/rooms — 방 만들기 (진행자 토큰 발급)
    if (path === '/api/rooms') {
      if (request.method !== 'POST') return json({ message: '허용되지 않는 요청이에요.' }, 405);
      return createRoom(request, env, url);
    }

    // GET /api/rooms/1234 — 방이 있는지 확인 (입장 화면용)
    const info = path.match(/^\/api\/rooms\/(\d{4})$/);
    if (info) {
      const r = await roomStub(env, info[1]).info();
      if (!r) return json({ message: '없는 방이에요. 방 코드를 다시 확인해 주세요.' }, 404);
      return json(r);
    }

    // GET /ws/1234 — WebSocket 업그레이드 → 해당 방의 Durable Object 로 전달
    const ws = path.match(/^\/ws\/(\d{4})$/);
    if (ws) {
      if (request.headers.get('Upgrade') !== 'websocket') return json({ message: 'WebSocket 연결이 필요해요.' }, 426);
      return roomStub(env, ws[1]).fetch(request);
    }

    if (path.startsWith('/api/') || path.startsWith('/ws/')) return json({ message: '없는 주소예요.' }, 404);

    // 그 밖에는 정적 화면 (run_worker_first 설정상 보통 여기까지 오지 않음)
    return env.ASSETS.fetch(request);
  },
};

async function createRoom(request, env, url) {
  // 다른 사이트에서 몰래 방을 만들지 못하게 같은 출처만 허용
  const origin = request.headers.get('Origin');
  if (origin) {
    let host = '';
    try {
      host = new URL(origin).host;
    } catch {}
    if (host !== url.host) return json({ message: '허용되지 않은 요청이에요.' }, 403);
  }

  let body = {};
  try {
    const text = await request.text();
    if (text.length > 8192) return json({ message: '요청이 너무 커요.' }, 413);
    if (text) body = JSON.parse(text);
  } catch {
    return json({ message: '요청 형식이 올바르지 않아요.' }, 400);
  }

  // 질문을 안 보내면 questions.json 의 기본 구성(defaultSet)을 쓴다
  const questions = Array.isArray(body.questions)
    ? body.questions
    : presets.defaultSet.map((id) => presets.questions.find((q) => q.id === id)).filter(Boolean);

  const hostToken = hex(crypto.getRandomValues(new Uint8Array(24)));

  // 코드가 겹치면(이미 진행 중인 방) 다시 뽑는다
  for (let i = 0; i < 10; i++) {
    const code = randomCode();
    const r = await roomStub(env, code).init({ code, hostToken, questions, settings: body.settings ?? {} });
    if (r.ok) return json({ code, hostToken }, 201);
    if (r.reason !== 'EXISTS') return json({ message: r.message ?? '방을 만들지 못했어요.' }, 400);
  }
  return json({ message: '지금은 방을 만들 수 없어요. 잠시 후 다시 시도해 주세요.' }, 503);
}

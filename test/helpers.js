// 테스트 공용 도우미
import assert from 'node:assert/strict';
import { createRoom, reduce } from '../src/game.js';

export const HOST = 'host-token-0123456789abcdef';
export const tok = (n) => `player-token-${String(n).padStart(8, '0')}-xyz`;

// 시드 고정 난수 (mulberry32)
export function seeded(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export const QUESTIONS = [
  { id: 'app', level: 'light', text: '요즘 가장 많이 쓰는 앱은?' },
  { id: 'food', level: 'light', text: '절대 못 먹는 음식은?' },
  { id: 'laugh', level: 'middle', text: '요즘 나를 웃게 한 일은?' },
  { id: 'grace', level: 'deep', text: '올해 받은 은혜 한 가지는?' },
];

/** 상태를 들고 다니며 액션을 적용하는 작은 하네스 */
export class Game {
  constructor({ seed = 1, questions = QUESTIONS, settings = {}, now = 1_000_000 } = {}) {
    this.now = now;
    this.rng = seeded(seed);
    this.state = createRoom({ code: 'ABCD', hostToken: HOST, questions, now, settings });
  }
  try(action) {
    const r = reduce(this.state, action, { now: this.now, rng: this.rng });
    if (r.ok) this.state = r.state;
    return r;
  }
  do(action) {
    const r = this.try(action);
    assert.ok(r.ok, `액션 실패: ${JSON.stringify(action)} → ${JSON.stringify(r.error)}`);
    return r.result;
  }
  host(action) {
    return this.do({ ...action, hostToken: HOST });
  }
  join(name, n) {
    return this.do({ type: 'join', name, token: tok(n) }).playerId;
  }
  advance(ms) {
    this.now += ms;
  }
}

/** n명 입장 → 시작까지 */
export function lobbyWith(names, opts) {
  const g = new Game(opts);
  const ids = names.map((nm, i) => g.join(nm, i + 1));
  return { g, ids };
}

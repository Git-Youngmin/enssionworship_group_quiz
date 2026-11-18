import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
  reduce,
  viewFor,
  computeStats,
  computeAwards,
  nextAlarm,
  isExpired,
  playerIdByToken,
  createRoom,
  LIMITS,
  TTL,
  PHASE,
} from '../src/game.js';
import { Game, lobbyWith, HOST, tok, QUESTIONS, seeded } from './helpers.js';

const NAMES = ['민수', '지은', '하늘', '요셉'];

// 모두가 모든 질문에 답하는 writing 단계를 끝내고 guessing 으로 보낸다
function writeAll(g, ids, textFn = (id, q) => `${id}의 ${q.id} 답`) {
  for (const id of ids) {
    const answers = Object.fromEntries(g.state.questions.map((q) => [q.id, textFn(id, q)]));
    g.do({ type: 'submitAnswers', playerId: id, answers });
  }
}

// ───────────────────────── 상태 전이 ─────────────────────────
describe('상태 전이', () => {
  test('lobby → writing → (guessing → reveal) × N → final 한 판 전체', () => {
    const { g, ids } = lobbyWith(NAMES);
    assert.equal(g.state.phase, PHASE.LOBBY);
    g.host({ type: 'start' });
    assert.equal(g.state.phase, PHASE.WRITING);
    assert.equal(g.state.deadline, g.now + 60 * 4 * 1000, '문항당 60초 × 4문항');

    writeAll(g, ids);
    assert.equal(g.state.phase, PHASE.GUESSING, '모두 제출하면 자동으로 다음 단계');
    assert.equal(g.state.rounds.length, 4, '기본 라운드 수 = 질문 수');

    for (let i = 0; i < 4; i++) {
      assert.equal(g.state.phase, PHASE.GUESSING);
      assert.equal(g.state.roundIndex, i);
      const author = g.state.rounds[i].authorId;
      for (const id of ids) {
        if (id === author) continue;
        g.do({ type: 'vote', playerId: id, roundIndex: i, targetId: author });
      }
      assert.equal(g.state.phase, PHASE.REVEAL, '작성자 외 전원 투표 시 자동 공개');
      g.host({ type: 'next' });
    }
    assert.equal(g.state.phase, PHASE.FINAL);
    assert.equal(g.state.deadline, null);
  });

  test('라운드마다 서로 다른 사람이 주인공이 되도록 고른다', () => {
    const { g, ids } = lobbyWith(NAMES, { seed: 7 });
    g.host({ type: 'start' });
    writeAll(g, ids);
    const authors = g.state.rounds.map((r) => r.authorId);
    assert.equal(new Set(authors).size, 4);
    assert.deepEqual(
      g.state.rounds.map((r) => r.qid),
      QUESTIONS.map((q) => q.id),
      '라운드 i 는 질문 i 를 사용',
    );
  });

  test('타이머: 마감 전 tick 은 무시, 마감 후 tick 은 다음 단계', () => {
    const { g, ids } = lobbyWith(NAMES);
    g.host({ type: 'start' });
    g.do({ type: 'submitAnswers', playerId: ids[0], answers: { app: '유튜브' } });
    g.advance(60 * 4 * 1000 - 1);
    g.do({ type: 'tick' });
    assert.equal(g.state.phase, PHASE.WRITING);
    g.advance(1);
    g.do({ type: 'tick' });
    assert.equal(g.state.phase, PHASE.GUESSING);
    assert.equal(g.state.rounds.length, 1, '답이 1개뿐이면 라운드도 1개');

    g.advance(30 * 1000);
    g.do({ type: 'tick' });
    assert.equal(g.state.phase, PHASE.REVEAL);
    assert.equal(nextAlarm(g.state), g.state.expireAt, 'reveal 에는 타이머 없음 → 다음 알람은 삭제 시각');
  });

  test('아무도 답을 안 쓰면 바로 final', () => {
    const { g } = lobbyWith(NAMES);
    g.host({ type: 'start' });
    g.host({ type: 'skip' });
    assert.equal(g.state.phase, PHASE.FINAL);
  });

  test('진행자 조작: 시간 추가, 건너뛰기, 일찍 끝내기', () => {
    const { g, ids } = lobbyWith(NAMES);
    g.host({ type: 'start' });
    const d = g.state.deadline;
    g.host({ type: 'addTime', seconds: 30 });
    assert.equal(g.state.deadline, d + 30_000);
    writeAll(g, ids);
    const d2 = g.state.deadline;
    g.host({ type: 'addTime', seconds: -10 });
    assert.equal(g.state.deadline, d2 - 10_000);
    g.host({ type: 'skip' });
    assert.equal(g.state.phase, PHASE.REVEAL);
    g.host({ type: 'endGame' });
    assert.equal(g.state.phase, PHASE.FINAL);
  });

  test('설정 변경: 질문·시간·라운드 수 (lobby 에서만)', () => {
    const { g, ids } = lobbyWith(NAMES);
    g.host({
      type: 'updateSettings',
      questions: [{ text: '  직접 만든   질문  ' }, QUESTIONS[0]],
      writeSecondsPerQuestion: 30,
      guessSeconds: 20,
      roundCount: 3,
    });
    assert.equal(g.state.questions[0].text, '직접 만든 질문');
    assert.equal(g.state.questions[0].level, 'custom');
    assert.equal(g.try({ type: 'updateSettings', hostToken: HOST, questions: [] }).error.code, 'BAD_QUESTIONS');
    assert.equal(
      g.try({ type: 'updateSettings', hostToken: HOST, questions: Array(6).fill({ text: 'q' }) }).error.code,
      'BAD_QUESTIONS',
    );
    assert.equal(g.try({ type: 'updateSettings', hostToken: HOST, guessSeconds: 1 }).error.code, 'BAD_SETTINGS');
    g.host({ type: 'start' });
    assert.equal(g.state.deadline, g.now + 30 * 2 * 1000);
    writeAll(g, ids);
    assert.equal(g.state.rounds.length, 3, 'roundCount=3, 질문 2개 → 질문이 번갈아 쓰임');
    assert.equal(g.try({ type: 'updateSettings', hostToken: HOST, guessSeconds: 20 }).error.code, 'WRONG_PHASE');
  });

  test('최소 인원 미만이면 시작 불가', () => {
    const { g } = lobbyWith(['혼자']);
    assert.equal(g.try({ type: 'start', hostToken: HOST }).error.code, 'NOT_ENOUGH_PLAYERS');
  });
});

// ───────────────────────── 권한 ─────────────────────────
describe('진행자 권한', () => {
  test('토큰 없거나 틀리면 진행 조작 불가', () => {
    const { g } = lobbyWith(NAMES);
    for (const type of ['start', 'skip', 'next', 'addTime', 'kick', 'endGame', 'updateSettings']) {
      assert.equal(g.try({ type }).error.code, 'NOT_HOST', `${type} (토큰 없음)`);
      assert.equal(g.try({ type, hostToken: tok(1) }).error.code, 'NOT_HOST', `${type} (참가자 토큰)`);
      assert.equal(g.try({ type, hostToken: '' }).error.code, 'NOT_HOST', `${type} (빈 토큰)`);
    }
    assert.equal(g.state.phase, PHASE.LOBBY);
  });

  test('kick 은 lobby/writing 에서만, 추방된 사람의 답도 지운다', () => {
    const { g, ids } = lobbyWith(NAMES);
    g.host({ type: 'start' });
    g.do({ type: 'submitAnswers', playerId: ids[3], answers: { app: '비밀' } });
    g.host({ type: 'kick', playerId: ids[3] });
    assert.equal(g.state.players.length, 3);
    assert.equal(g.state.answers[ids[3]], undefined);
    assert.equal(playerIdByToken(g.state, tok(4)), null, '추방된 토큰으로는 복귀 불가');
  });
});

// ───────────────────────── 익명성 ─────────────────────────
describe('익명성: reveal 전에는 작성자 정보가 클라이언트로 가지 않는다', () => {
  function viewersOf(state) {
    return [
      { isHost: true },
      { isHost: false },
      ...state.players.map((p) => ({ playerId: p.id })),
      ...state.players.map((p) => ({ playerId: p.id, isHost: true })),
    ];
  }

  test('guessing 중 모든 viewer 의 데이터에 author·토큰·다른 답 원문이 없다', () => {
    const { g, ids } = lobbyWith(NAMES, { seed: 3 });
    g.host({ type: 'start' });
    // 원래 답 원문들 기록 (라운드에 안 뽑힌 답이 새지 않는지 확인용)
    const allTexts = [];
    writeAll(g, ids, (id, q) => {
      const t = `비밀답-${id}-${q.id}`;
      allTexts.push(t);
      return t;
    });
    for (let i = 0; i < g.state.rounds.length; i++) {
      const r = g.state.rounds[i];
      for (const viewer of viewersOf(g.state)) {
        const v = viewFor(g.state, viewer, g.now);
        const json = JSON.stringify(v);
        assert.equal(v.round.author, undefined);
        assert.equal(v.round.tally, undefined);
        assert.equal(v.round.correctVoters, undefined);
        assert.doesNotMatch(json, /author/i, '키 이름에도 author 가 없어야 함');
        assert.doesNotMatch(json, /token/i);
        assert.ok(!json.includes(HOST));
        for (let n = 1; n <= NAMES.length; n++) assert.ok(!json.includes(tok(n)));
        // 지금 라운드의 답 외에 다른 답 원문은 없음
        for (const t of allTexts) if (t !== r.text) assert.ok(!json.includes(t), `다른 답 유출: ${t}`);
        // isMine 은 작성자 본인 화면에서만 true
        assert.equal(v.round.isMine, viewer.playerId === r.authorId);
      }
      // 투표 진행 → 공개
      g.host({ type: 'skip' });
      const v = viewFor(g.state, { isHost: true }, g.now);
      assert.equal(v.round.author.id, r.authorId, 'reveal 에서는 공개');
      g.host({ type: 'next' });
    }
  });

  test('차등 검사: 작성자만 다른 두 게임에서 작성자 아닌 사람의 화면 데이터가 완전히 같다', () => {
    // 모두 같은 답을 쓰게 해서 "답 내용"으로는 구별이 불가능하게 만든 뒤,
    // 시드만 바꿔 1라운드 작성자가 다른 두 상태를 찾는다.
    const run = (seed) => {
      const { g, ids } = lobbyWith(NAMES, { seed });
      g.host({ type: 'start' });
      writeAll(g, ids, () => '똑같은 답');
      return { g, ids };
    };
    const a = run(1);
    let b = null;
    for (let seed = 2; seed < 200 && !b; seed++) {
      const c = run(seed);
      if (c.g.state.rounds[0].authorId !== a.g.state.rounds[0].authorId) b = c;
    }
    assert.ok(b, '작성자가 다른 시드를 찾아야 함');
    const authorA = a.g.state.rounds[0].authorId;
    const authorB = b.g.state.rounds[0].authorId;
    const bystanders = a.ids.filter((id) => id !== authorA && id !== authorB);
    assert.ok(bystanders.length >= 1);

    // 같은 사람이 같은 대상에게 투표하는 상황까지 맞춘다 (투표 진행 중 화면)
    const voter = bystanders[0];
    const target = a.ids.find((id) => id !== voter);
    for (const g of [a.g, b.g]) g.do({ type: 'vote', playerId: voter, roundIndex: 0, targetId: target });

    for (const viewer of [{ isHost: true }, ...bystanders.map((id) => ({ playerId: id }))]) {
      const va = viewFor(a.g.state, viewer, 0);
      const vb = viewFor(b.g.state, viewer, 0);
      assert.deepEqual(va, vb, `viewer ${JSON.stringify(viewer)} 화면이 작성자에 따라 달라지면 안 됨`);
    }
  });

  test('writing 중에는 내 답만 보이고 남의 답은 안 보인다', () => {
    const { g, ids } = lobbyWith(NAMES);
    g.host({ type: 'start' });
    g.do({ type: 'submitAnswers', playerId: ids[0], answers: { app: '민수의 비밀' } });
    g.do({ type: 'submitAnswers', playerId: ids[1], answers: { app: '지은의 비밀' } });
    const v0 = viewFor(g.state, { playerId: ids[0] });
    assert.deepEqual(v0.writing.myAnswers, { app: '민수의 비밀' });
    assert.ok(!JSON.stringify(v0).includes('지은의 비밀'));
    const vh = viewFor(g.state, { isHost: true });
    assert.ok(!JSON.stringify(vh).includes('비밀'));
    assert.equal(vh.writing.doneCount, 2);
  });

  test('라운드에 뽑히지 않은 답은 writing 종료 직후 서버 상태에서도 지워진다', () => {
    const { g, ids } = lobbyWith(NAMES);
    g.host({ type: 'start' });
    writeAll(g, ids, (id, q) => `원문-${id}-${q.id}`);
    const kept = new Set(g.state.rounds.map((r) => r.text));
    const json = JSON.stringify(g.state);
    for (const id of ids)
      for (const q of QUESTIONS) {
        const t = `원문-${id}-${q.id}`;
        assert.equal(json.includes(t), kept.has(t));
      }
    assert.deepEqual(g.state.answers, {});
  });
});

// ───────────────────────── 투표·점수 ─────────────────────────
describe('투표와 점수', () => {
  function toGuessing(seed = 5) {
    const { g, ids } = lobbyWith(NAMES, { seed });
    g.host({ type: 'start' });
    writeAll(g, ids);
    return { g, ids, author: g.state.rounds[0].authorId };
  }

  test('자기 답 투표 불가, 자기 자신 지목 불가, 후보 아닌 사람 불가', () => {
    const { g, ids, author } = toGuessing();
    const other = ids.find((id) => id !== author);
    assert.equal(g.try({ type: 'vote', playerId: author, roundIndex: 0, targetId: other }).error.code, 'OWN_ANSWER');
    assert.equal(g.try({ type: 'vote', playerId: other, roundIndex: 0, targetId: other }).error.code, 'BAD_TARGET');
    assert.equal(g.try({ type: 'vote', playerId: other, roundIndex: 0, targetId: 'p999' }).error.code, 'BAD_TARGET');
    assert.equal(g.try({ type: 'vote', playerId: 'p999', roundIndex: 0, targetId: author }).error.code, 'NOT_PLAYER');
  });

  test('이전 라운드 번호로 온 늦은 투표는 거절 (다음 문제에 잘못 들어가지 않게)', () => {
    const { g, ids } = toGuessing();
    g.host({ type: 'skip' });
    g.host({ type: 'next' });
    const r1 = g.state.rounds[1];
    const voter = ids.find((id) => id !== r1.authorId);
    assert.equal(
      g.try({ type: 'vote', playerId: voter, roundIndex: 0, targetId: r1.authorId }).error.code,
      'STALE_ROUND',
    );
    assert.deepEqual(r1.votes, {});
  });

  test('reveal 이후 투표 불가', () => {
    const { g, ids, author } = toGuessing();
    g.host({ type: 'skip' });
    const voter = ids.find((id) => id !== author);
    assert.equal(g.try({ type: 'vote', playerId: voter, roundIndex: 0, targetId: author }).error.code, 'WRONG_PHASE');
  });

  test('투표를 바꾸면 마지막 투표만 센다', () => {
    const { g, ids, author } = toGuessing();
    const [v1] = ids.filter((id) => id !== author);
    const wrong = ids.find((id) => id !== author && id !== v1);
    g.do({ type: 'vote', playerId: v1, roundIndex: 0, targetId: wrong });
    g.do({ type: 'vote', playerId: v1, roundIndex: 0, targetId: author });
    g.do({ type: 'vote', playerId: v1, roundIndex: 0, targetId: author });
    assert.equal(viewFor(g.state, { isHost: true }).round.votedCount, 1);
    g.host({ type: 'skip' });
    const st = computeStats(g.state);
    assert.equal(st[v1].correct, 1);
    assert.equal(st[v1].guesses, 1);
    const v = viewFor(g.state, { playerId: v1 });
    assert.equal(v.round.myCorrect, true);
    assert.deepEqual(v.round.correctVoters, [g.state.players.find((p) => p.id === v1).name]);
  });

  test('reveal 화면: 득표 분포·맞힌 사람', () => {
    const { g, ids, author } = toGuessing();
    const voters = ids.filter((id) => id !== author);
    g.do({ type: 'vote', playerId: voters[0], roundIndex: 0, targetId: author });
    g.do({ type: 'vote', playerId: voters[1], roundIndex: 0, targetId: author });
    g.do({ type: 'vote', playerId: voters[2], roundIndex: 0, targetId: voters[0] });
    const v = viewFor(g.state, { isHost: true });
    assert.equal(v.phase, PHASE.REVEAL);
    assert.deepEqual(
      v.round.tally.map((t) => [t.id, t.count]),
      [
        [author, 2],
        [voters[0], 1],
      ],
    );
    assert.equal(v.round.correctVoters.length, 2);
  });

  test('어워드 계산', () => {
    const { g, ids } = lobbyWith(NAMES, { seed: 11 });
    g.host({ type: 'start' });
    writeAll(g, ids);
    // 시나리오: ids[0] 은 늘 정답, 나머지는 늘 ids[0] 이 아닌 다른 사람을 지목
    for (let i = 0; i < 4; i++) {
      const author = g.state.rounds[i].authorId;
      for (const id of ids) {
        if (id === author) continue;
        let target;
        if (id === ids[0]) target = author;
        else if (i === 0) target = author; // 1라운드는 모두 맞힘 → 가장 쉽게 들킨 사람
        else target = ids.find((x) => x !== id && x !== author && x !== ids[0]) ?? author;
        g.do({ type: 'vote', playerId: id, roundIndex: i, targetId: target });
      }
      g.host({ type: 'next' });
    }
    assert.equal(g.state.phase, PHASE.FINAL);
    const awards = computeAwards(g.state);
    const byKey = Object.fromEntries(awards.map((a) => [a.key, a]));
    assert.deepEqual(byKey.detective.names, ['민수']);
    assert.ok(byKey.mystery && byKey.obvious, '수수께끼/쉽게 들킨 사람 상이 있어야 함');
    assert.deepEqual(byKey.obvious.names, [g.state.rounds[0].authorName]);
    const v = viewFor(g.state, { playerId: ids[0] });
    assert.equal(v.final.mine.correct, 3, '민수는 자기 라운드를 뺀 3개를 맞힘');
    assert.equal(v.final.recap.length, 4);
    assert.ok(!('ranking' in v.final), '순위표는 보내지 않음');
  });
});

// ───────────────────────── 입장·재접속 ─────────────────────────
describe('입장과 재접속', () => {
  test('닉네임 정리·길이 제한·중복 방지(대소문자·공백 무시)', () => {
    const g = new Game();
    g.join('  Grace  Kim ', 1);
    assert.equal(g.state.players[0].name, 'Grace Kim');
    assert.equal(g.try({ type: 'join', name: 'gracekim', token: tok(2) }).error.code, 'NAME_TAKEN');
    assert.equal(g.try({ type: 'join', name: '   ', token: tok(2) }).error.code, 'NAME_EMPTY');
    assert.equal(g.try({ type: 'join', name: '가'.repeat(13), token: tok(2) }).error.code, 'NAME_TOO_LONG');
    g.join('가'.repeat(12), 2);
    assert.equal(g.try({ type: 'join', name: '새사람', token: 'short' }).error.code, 'BAD_ACTION');
  });

  test(`최대 ${LIMITS.MAX_PLAYERS}명`, () => {
    const g = new Game();
    for (let i = 1; i <= LIMITS.MAX_PLAYERS; i++) g.join(`사람${i}`, i);
    assert.equal(g.try({ type: 'join', name: '한명더', token: tok(99) }).error.code, 'ROOM_FULL');
  });

  test('새로고침 후 같은 토큰으로 같은 사람 복귀 + 쓰던 답 복원', () => {
    const { g, ids } = lobbyWith(NAMES);
    g.host({ type: 'start' });
    g.do({ type: 'submitAnswers', playerId: ids[1], answers: { app: '카톡', food: '오이' } });
    g.do({ type: 'setConnected', playerId: ids[1], connected: false });
    assert.equal(g.state.players[1].connected, false);
    const r = g.do({ type: 'resume', token: tok(2) });
    assert.equal(r.playerId, ids[1]);
    assert.equal(g.state.players[1].connected, true);
    const v = viewFor(g.state, { playerId: r.playerId });
    assert.deepEqual(v.writing.myAnswers, { app: '카톡', food: '오이' });
    assert.equal(v.writing.submitted, true);
    assert.equal(g.try({ type: 'resume', token: 'unknown-token-123456' }).error.code, 'BAD_TOKEN');
    assert.equal(playerIdByToken(g.state, tok(2)), ids[1]);
  });

  test('guessing 중 재접속해도 내 투표가 유지된다', () => {
    const { g, ids } = lobbyWith(NAMES);
    g.host({ type: 'start' });
    writeAll(g, ids);
    const author = g.state.rounds[0].authorId;
    const voter = ids.find((id) => id !== author);
    g.do({ type: 'vote', playerId: voter, roundIndex: 0, targetId: author });
    g.do({ type: 'setConnected', playerId: voter, connected: false });
    const { playerId } = g.do({ type: 'resume', token: tok(ids.indexOf(voter) + 1) });
    assert.equal(viewFor(g.state, { playerId }).round.myVote, author);
  });

  test('접속이 끊긴 사람은 writing 자동 종료를 막지 않는다', () => {
    const { g, ids } = lobbyWith(NAMES);
    g.host({ type: 'start' });
    g.do({ type: 'setConnected', playerId: ids[3], connected: false });
    writeAll(g, ids.slice(0, 3));
    assert.equal(g.state.phase, PHASE.GUESSING);
  });

  test('늦게 들어온 사람도 writing 에 참여할 수 있다 / final 이후엔 입장 불가', () => {
    const { g, ids } = lobbyWith(NAMES);
    g.host({ type: 'start' });
    const late = g.join('늦은이', 9);
    writeAll(g, [...ids, late]);
    assert.ok(g.state.answerers.includes(late));
    g.host({ type: 'endGame' });
    assert.equal(g.try({ type: 'join', name: '더늦은이', token: tok(10) }).error.code, 'GAME_OVER');
  });

  test('글자 수 제한: 답 80자', () => {
    const { g, ids } = lobbyWith(NAMES);
    g.host({ type: 'start' });
    g.do({ type: 'submitAnswers', playerId: ids[0], answers: { app: '가'.repeat(80) } });
    const r = g.try({ type: 'submitAnswers', playerId: ids[0], answers: { app: '가'.repeat(81) } });
    assert.equal(r.error.code, 'ANSWER_TOO_LONG');
  });
});

// ───────────────────────── 동시 처리 ─────────────────────────
describe('동시 제출·투표 (DO 안에서 순서대로 처리된다고 가정)', () => {
  test('제출·투표 순서를 아무렇게나 섞어도 결과 점수는 같다', () => {
    const results = [];
    for (let seed = 1; seed <= 30; seed++) {
      const { g, ids } = lobbyWith(NAMES, { seed: 42 }); // 라운드 구성은 고정
      const shuffle = seeded(seed);
      const shuffled = (arr) => {
        const a = [...arr];
        for (let i = a.length - 1; i > 0; i--) {
          const j = Math.floor(shuffle() * (i + 1));
          [a[i], a[j]] = [a[j], a[i]];
        }
        return a;
      };
      g.host({ type: 'start' });
      // 같은 사람이 여러 번 제출하는 중복 요청도 섞는다
      const submits = shuffled([...ids, ...ids.slice(0, 2)]);
      for (const id of submits) {
        if (g.state.phase !== PHASE.WRITING) {
          // 이미 넘어간 뒤 도착한 중복 제출은 거절되어야 함
          assert.equal(g.try({ type: 'submitAnswers', playerId: id, answers: {} }).error.code, 'WRONG_PHASE');
          continue;
        }
        g.do({
          type: 'submitAnswers',
          playerId: id,
          answers: Object.fromEntries(QUESTIONS.map((q) => [q.id, `${id}-${q.id}`])),
        });
      }
      assert.equal(g.state.phase, PHASE.GUESSING);
      for (let i = 0; i < g.state.rounds.length; i++) {
        const author = g.state.rounds[i].authorId;
        // 규칙: 각 투표자는 (자기 번호 + 라운드)로 정해진 대상에 투표, 중복 요청 포함
        const reqs = [];
        for (const id of ids) {
          if (id === author) continue;
          const cands = ids.filter((x) => x !== id);
          const target = cands[(ids.indexOf(id) + i) % cands.length];
          reqs.push({ id, target }, { id, target });
        }
        for (const { id, target } of shuffled(reqs)) {
          const r = g.try({ type: 'vote', playerId: id, roundIndex: i, targetId: target });
          assert.ok(r.ok || r.error.code === 'WRONG_PHASE', JSON.stringify(r.error));
        }
        assert.equal(g.state.phase, PHASE.REVEAL);
        g.host({ type: 'next' });
      }
      results.push(JSON.stringify(computeStats(g.state)));
    }
    assert.equal(new Set(results).size, 1, '모든 순서에서 점수가 동일해야 함');
  });

  test('같은 닉네임 동시 입장: 한 명만 성공', () => {
    const g = new Game();
    const r1 = g.try({ type: 'join', name: '은혜', token: tok(1) });
    const r2 = g.try({ type: 'join', name: '은혜', token: tok(2) });
    assert.ok(r1.ok);
    assert.equal(r2.error.code, 'NAME_TAKEN');
    assert.equal(g.state.players.length, 1);
  });

  test('reduce 는 입력 상태를 바꾸지 않는다 (실패해도 상태 그대로)', () => {
    const g = new Game();
    g.join('민수', 1);
    const before = JSON.stringify(g.state);
    reduce(g.state, { type: 'join', name: '지은', token: tok(2) }, { now: 0, rng: Math.random });
    reduce(g.state, { type: 'start' }, { now: 0 });
    assert.equal(JSON.stringify(g.state), before);
  });
});

// ───────────────────────── 삭제 ─────────────────────────
describe('자동 삭제 시각', () => {
  test('final 이 되면 30분 뒤 삭제 예정, 답 원본도 비운다', () => {
    const { g, ids } = lobbyWith(NAMES);
    g.host({ type: 'start' });
    writeAll(g, ids);
    g.host({ type: 'endGame' });
    assert.equal(g.state.expireAt, g.now + TTL.FINAL_MS);
    assert.equal(nextAlarm(g.state), g.state.expireAt);
    assert.equal(isExpired(g.state, g.now + TTL.FINAL_MS - 1), false);
    assert.equal(isExpired(g.state, g.now + TTL.FINAL_MS), true);
    assert.deepEqual(g.state.answers, {});
  });

  test('방치된 방은 마지막 활동 후 3시간 뒤 삭제 (tick·연결은 활동으로 안 침)', () => {
    const g = new Game();
    const id = g.join('민수', 1);
    const exp = g.state.expireAt;
    assert.equal(exp, g.now + TTL.IDLE_MS);
    g.advance(1000);
    g.do({ type: 'tick' });
    g.do({ type: 'setConnected', playerId: id, connected: false });
    assert.equal(g.state.expireAt, exp);
    g.join('지은', 2);
    assert.equal(g.state.expireAt, g.now + TTL.IDLE_MS);
  });

  test('타이머 단계에서는 마감 시각에 알람', () => {
    const { g } = lobbyWith(NAMES);
    g.host({ type: 'start' });
    assert.equal(nextAlarm(g.state), g.state.deadline);
  });
});

// ───────────────────────── 질문 프리셋 파일 ─────────────────────────
describe('질문 프리셋 JSON', () => {
  const presets = JSON.parse(readFileSync(new URL('../public/questions.json', import.meta.url), 'utf8'));

  test('형식이 올바르고 기본 구성은 가벼움2+중간1+깊음1', () => {
    const ids = new Set(presets.questions.map((q) => q.id));
    assert.equal(ids.size, presets.questions.length, 'id 중복 없음');
    for (const q of presets.questions) {
      assert.ok(['light', 'middle', 'deep'].includes(q.level), q.id);
      assert.ok(q.text.length <= LIMITS.QUESTION_MAX, q.id);
    }
    const chosen = presets.defaultSet.map((id) => presets.questions.find((q) => q.id === id));
    assert.ok(chosen.every(Boolean), 'defaultSet 의 id 가 모두 존재');
    const count = (lv) => chosen.filter((q) => q.level === lv).length;
    assert.deepEqual([count('light'), count('middle'), count('deep')], [2, 1, 1]);
  });

  test('기본 구성으로 방을 만들 수 있다', () => {
    const qs = presets.defaultSet.map((id) => presets.questions.find((q) => q.id === id));
    const s = createRoom({ code: 'TEST', hostToken: HOST, questions: qs, now: 0 });
    assert.equal(s.questions.length, 4);
  });
});

// ───────────────────────── 닉네임 이어하기 ─────────────────────────
describe('닉네임 이어하기 (저장 정보를 잃고 같은 닉네임으로 돌아온 경우)', () => {
  test('접속 중인 사람의 닉네임은 거절, 끊긴 사람의 닉네임이면 같은 사람으로 이어진다', () => {
    const { g, ids } = lobbyWith(NAMES);
    assert.equal(g.try({ type: 'join', name: '민수', token: tok(50) }).error.code, 'NAME_TAKEN');
    g.do({ type: 'setConnected', playerId: ids[0], connected: false });
    const r = g.do({ type: 'join', name: ' 민수 ', token: tok(50) });
    assert.equal(r.playerId, ids[0], '새 사람이 아니라 같은 사람');
    assert.equal(r.reclaimed, true);
    assert.equal(g.state.players.length, 4, '인원이 늘지 않는다');
    assert.equal(g.state.players[0].connected, true);
  });

  test('이어받은 뒤에는 예전 토큰이 무효, 새 토큰으로만 복귀 가능', () => {
    const { g, ids } = lobbyWith(NAMES);
    g.do({ type: 'setConnected', playerId: ids[1], connected: false });
    g.do({ type: 'join', name: '지은', token: tok(51) });
    assert.equal(g.try({ type: 'resume', token: tok(2) }).error.code, 'BAD_TOKEN', '옛 토큰은 쓸 수 없음');
    assert.equal(g.do({ type: 'resume', token: tok(51) }).playerId, ids[1]);
    assert.equal(playerIdByToken(g.state, tok(2)), null);
  });

  test('이어받으면 쓰던 답과 투표가 그대로 남는다', () => {
    const { g, ids } = lobbyWith(NAMES, { seed: 5 });
    g.host({ type: 'start' });
    g.do({ type: 'submitAnswers', playerId: ids[2], answers: { app: '넷플릭스' } });
    g.do({ type: 'setConnected', playerId: ids[2], connected: false });
    g.do({ type: 'join', name: '하늘', token: tok(52) });
    const v = viewFor(g.state, { playerId: ids[2] });
    assert.deepEqual(v.writing.myAnswers, { app: '넷플릭스' });
    assert.equal(v.writing.submitted, true);
  });

  test('방이 가득 차도 이어받기는 가능, final 이후에는 불가', () => {
    const g = new Game();
    for (let i = 1; i <= LIMITS.MAX_PLAYERS; i++) g.join(`사람${i}`, i);
    g.do({ type: 'setConnected', playerId: 'p5', connected: false });
    assert.equal(g.do({ type: 'join', name: '사람5', token: tok(99) }).reclaimed, true);
    assert.equal(g.try({ type: 'join', name: '새사람', token: tok(98) }).error.code, 'ROOM_FULL');
    g.do({ type: 'setConnected', playerId: 'p6', connected: false });
    g.host({ type: 'endGame' });
    assert.equal(g.try({ type: 'join', name: '사람6', token: tok(97) }).error.code, 'GAME_OVER');
  });

  test('이어받기는 익명성에 영향을 주지 않는다 (화면 데이터에 토큰·작성자 없음)', () => {
    const { g, ids } = lobbyWith(NAMES, { seed: 3 });
    g.host({ type: 'start' });
    writeAll(g, ids);
    g.do({ type: 'setConnected', playerId: ids[0], connected: false });
    g.do({ type: 'join', name: '민수', token: tok(60) });
    const json = JSON.stringify(viewFor(g.state, { playerId: ids[0] }));
    assert.doesNotMatch(json, /author|token/i);
    assert.ok(!json.includes(tok(60)));
  });
});

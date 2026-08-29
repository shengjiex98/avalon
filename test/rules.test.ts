import test from 'node:test';
import assert from 'node:assert/strict';

import {
  HOUSE_RULES, HOUSE_RULE_KEYS, SETUPS, buildRoleList, defaultOptions, failsRequired,
  knowledgeFor, sideOf, teamSize,
} from '../src/games/avalon/rules.ts';
import * as avalon from '../src/games/avalon/game.ts';
import { houseRulesInForce, setHouseRules } from '../src/lobby.ts';
import { missingKeys, t, STRINGS } from '../public/i18n.js';
import type { AvalonRole } from '../src/contracts/types.ts';

const roleMap = (values: Record<string, AvalonRole>): Record<string, AvalonRole> => values;

test('every player count has five quests and a sane evil count', () => {
  for (const [count, setup] of Object.entries(SETUPS)) {
    const n = Number(count);
    assert.equal(setup.teamSizes.length, 5, `${n} players`);
    assert.ok(setup.evil * 3 <= n * 2, `${n} players: evil must stay a minority`);
    for (const size of setup.teamSizes) assert.ok(size >= 2 && size <= n);
  }
});

test('quest four needs two fails only at seven or more players', () => {
  assert.equal(failsRequired(5, 3), 1);
  assert.equal(failsRequired(6, 3), 1);
  assert.equal(failsRequired(7, 3), 2);
  assert.equal(failsRequired(10, 3), 2);
  assert.equal(failsRequired(10, 4), 1);
  assert.equal(teamSize(7, 0), 2);
});

test('role list fills every seat with the right side', () => {
  for (const count of Object.keys(SETUPS).map(Number)) {
    // Only ask for as many special evil roles as this count has evil seats.
    const evil = SETUPS[count]!.evil;
    const roles = buildRoleList(count, { percival: true, morgana: evil >= 3, mordred: evil >= 4 });
    assert.equal(roles.length, count);
    assert.equal(roles.filter((r) => sideOf(r) === 'evil').length, SETUPS[count]!.evil);
    assert.equal(roles.filter((r) => r === 'merlin').length, 1);
    assert.equal(roles.filter((r) => r === 'assassin').length, 1);
  }
});

test('optional roles that do not fit are rejected', () => {
  // 5 players: 2 evil, so assassin + morgana + mordred is one too many.
  assert.throws(() => buildRoleList(5, { morgana: true, mordred: true }), { key: 'tooManyEvilRoles' });
  assert.throws(() => buildRoleList(4, {}), { key: 'badPlayerCount' });
});

test('Merlin sees evil but not Mordred', () => {
  const roles = roleMap({ a: 'merlin', b: 'assassin', c: 'mordred', d: 'servant', e: 'oberon' });
  const seen = knowledgeFor('a', roles).map((k) => k.playerId);
  assert.deepEqual(seen, ['b', 'e']);
});

test('evil recognise each other except Oberon', () => {
  const roles = roleMap({ a: 'merlin', b: 'assassin', c: 'morgana', d: 'oberon', e: 'servant' });
  assert.deepEqual(knowledgeFor('b', roles).map((k) => k.playerId), ['c']);
  assert.deepEqual(knowledgeFor('d', roles), [], 'Oberon sees nobody');
  assert.ok(!knowledgeFor('c', roles).some((k) => k.playerId === 'd'), 'nobody sees Oberon');
});

test('Percival cannot tell Merlin from Morgana', () => {
  const roles = roleMap({ a: 'merlin', b: 'percival', c: 'morgana', d: 'assassin', e: 'servant' });
  const seen = knowledgeFor('b', roles);
  assert.deepEqual(seen.map((k) => k.playerId), ['a', 'c']);
  assert.ok(seen.every((k) => k.hint === 'merlinOrMorgana'));
});

test('good players with no special role learn nothing', () => {
  const roles = roleMap({ a: 'merlin', b: 'servant', c: 'assassin', d: 'minion', e: 'servant' });
  assert.deepEqual(knowledgeFor('b', roles), []);
});

test('both languages define the same keys', () => {
  assert.deepEqual(missingKeys(), []);
});

test('translations interpolate parameters in both languages', () => {
  for (const lang of Object.keys(STRINGS)) {
    const line = t(lang, 'log.voteApproved', { yes: 3, no: 2 });
    assert.match(line, /3/);
    assert.match(line, /2/);
    assert.ok(!line.includes('{'), `${lang} left a placeholder unfilled`);
  }
  assert.equal(t('zh', 'role.merlin'), '梅林');
  assert.equal(t('en', 'role.merlin'), 'Merlin');
});

test('every role and error key the server can emit has a translation', () => {
  const roleKeys = Object.keys(STRINGS.en).filter((k) => k.startsWith('role.'));
  for (const key of roleKeys) {
    assert.ok(key in STRINGS.zh, `missing zh for ${key}`);
    assert.ok(`roleDesc.${key.slice(5)}` in STRINGS.en, `missing description for ${key}`);
  }
});

test('the default deck for each table size is the standard setup', () => {
  // The table the lobby is expected to reproduce without anybody touching a
  // switch: Percival opposite Morgana throughout, Oberon and Mordred joining
  // as the evil side gains seats.
  const expected = {
    5:  { merlin: 1, percival: 1, servant: 1, morgana: 1, assassin: 1 },
    6:  { merlin: 1, percival: 1, servant: 2, morgana: 1, assassin: 1 },
    7:  { merlin: 1, percival: 1, servant: 2, morgana: 1, assassin: 1, oberon: 1 },
    8:  { merlin: 1, percival: 1, servant: 3, morgana: 1, assassin: 1, minion: 1 },
    9:  { merlin: 1, percival: 1, servant: 4, morgana: 1, assassin: 1, mordred: 1 },
    10: { merlin: 1, percival: 1, servant: 4, morgana: 1, assassin: 1, mordred: 1, oberon: 1 },
  };
  for (const [count, want] of Object.entries(expected)) {
    const roles = buildRoleList(Number(count), defaultOptions(Number(count)));
    const got: Partial<Record<AvalonRole, number>> = {};
    for (const role of roles) got[role] = (got[role] ?? 0) + 1;
    assert.deepEqual(got, want, `${count} players`);
  }
});

test('house rules all start off, and one a snapshot predates stays off', () => {
  assert.deepEqual(HOUSE_RULES, { randomLeader: false, hiddenVotes: false, resetRejects: false });
  const game = avalon.createGame('TEST');
  game.state.houseRules.hiddenVotes = true;
  Reflect.deleteProperty(game.state.houseRules, 'randomLeader');
  Reflect.deleteProperty(game.state.houseRules, 'resetRejects');
  assert.deepEqual(houseRulesInForce(game, HOUSE_RULE_KEYS), {
    randomLeader: false, hiddenVotes: true, resetRejects: false,
  });
});

test('setting house rules touches only the keys this game offers', () => {
  const game = avalon.createGame('TEST');
  game.state.houseRules.randomLeader = true;
  Reflect.deleteProperty(game.state.houseRules, 'hiddenVotes');
  Reflect.deleteProperty(game.state.houseRules, 'resetRejects');
  setHouseRules(game, { hiddenVotes: 1, decisiveVote: true, resetRejects: false }, HOUSE_RULE_KEYS);
  assert.deepEqual(game.state.houseRules, { randomLeader: true, hiddenVotes: true, resetRejects: false });
});

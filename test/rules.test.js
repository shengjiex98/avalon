import test from 'node:test';
import assert from 'node:assert/strict';

import { SETUPS, buildRoleList, failsRequired, knowledgeFor, sideOf, teamSize } from '../src/rules.js';
import { missingKeys, t, STRINGS } from '../public/i18n.js';

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
    const evil = SETUPS[count].evil;
    const roles = buildRoleList(count, { percival: true, morgana: evil >= 3, mordred: evil >= 4 });
    assert.equal(roles.length, count);
    assert.equal(roles.filter((r) => sideOf(r) === 'evil').length, SETUPS[count].evil);
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
  const roles = { a: 'merlin', b: 'assassin', c: 'mordred', d: 'servant', e: 'oberon' };
  const seen = knowledgeFor('a', roles).map((k) => k.playerId);
  assert.deepEqual(seen, ['b', 'e']);
});

test('evil recognise each other except Oberon', () => {
  const roles = { a: 'merlin', b: 'assassin', c: 'morgana', d: 'oberon', e: 'servant' };
  assert.deepEqual(knowledgeFor('b', roles).map((k) => k.playerId), ['c']);
  assert.deepEqual(knowledgeFor('d', roles), [], 'Oberon sees nobody');
  assert.ok(!knowledgeFor('c', roles).some((k) => k.playerId === 'd'), 'nobody sees Oberon');
});

test('Percival cannot tell Merlin from Morgana', () => {
  const roles = { a: 'merlin', b: 'percival', c: 'morgana', d: 'assassin', e: 'servant' };
  const seen = knowledgeFor('b', roles);
  assert.deepEqual(seen.map((k) => k.playerId), ['a', 'c']);
  assert.ok(seen.every((k) => k.hint === 'merlinOrMorgana'));
});

test('good players with no special role learn nothing', () => {
  const roles = { a: 'merlin', b: 'servant', c: 'assassin', d: 'minion', e: 'servant' };
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
    assert.ok(STRINGS.zh[key], `missing zh for ${key}`);
    assert.ok(STRINGS.en[`roleDesc.${key.slice(5)}`], `missing description for ${key}`);
  }
});

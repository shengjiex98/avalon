// A role wearing another role's face is a bug the browser cannot report: the
// Drunk spent a while in the Villager's flower basket because nothing checked
// that the two ended up on different tiles of the atlas.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, access } from 'node:fs/promises';

import { ROLES as AVALON_ROLES } from '../src/games/avalon/rules.js';
import { ROLES as ONUW_ROLES } from '../src/games/onuw/rules.js';

const ATLAS = new URL('../public/art/jrpg-role-atlas.webp', import.meta.url);
const roles = [...new Set([...Object.keys(AVALON_ROLES), ...Object.keys(ONUW_ROLES)])].sort();

async function stylesheet() {
  return readFile(new URL('../public/styles.css', import.meta.url), 'utf8');
}

/** The `--portrait-x/y` pair each `.portrait-<role>` rule sets, as numbers. */
function portraits(css) {
  const found = new Map();
  const rule = /\.portrait-(\w+)\s*\{\s*--portrait-x:\s*([\d.]+)%;\s*--portrait-y:\s*([\d.]+)%;\s*\}/g;
  for (const m of css.matchAll(rule)) found.set(m[1], [Number(m[2]), Number(m[3])]);
  return found;
}

/** Columns and rows, read off the one `background-size` the atlas is sliced by. */
function grid(css) {
  const m = css.match(/background-size:\s*(\d+)%\s+(\d+)%/);
  assert.ok(m, '.role-portrait must declare a background-size');
  return { cols: Number(m[1]) / 100, rows: Number(m[2]) / 100 };
}

/** Canvas size out of a WebP VP8X header — enough to check the atlas shape. */
async function atlasSize() {
  const buf = await readFile(ATLAS);
  assert.equal(buf.toString('latin1', 0, 4), 'RIFF');
  assert.equal(buf.toString('latin1', 8, 12), 'WEBP');
  assert.equal(buf.toString('latin1', 12, 16), 'VP8X', 'expected an extended-format atlas');
  return { width: buf.readUIntLE(24, 3) + 1, height: buf.readUIntLE(27, 3) + 1 };
}

test('every role in both games has a portrait rule', async () => {
  const found = portraits(await stylesheet());
  assert.ok(roles.length >= 18, `expected the roles of both games, found ${roles.length}`);
  for (const role of roles) assert.ok(found.has(role), `styles.css has no .portrait-${role}`);
  for (const role of found.keys()) {
    assert.ok(roles.includes(role), `styles.css positions .portrait-${role}, which no game deals`);
  }
});

test('no two roles share a tile', async () => {
  const found = portraits(await stylesheet());
  const taken = new Map();
  for (const [role, [x, y]] of found) {
    const key = `${x},${y}`;
    assert.ok(!taken.has(key), `${role} and ${taken.get(key)} share the tile at ${key}`);
    taken.set(key, role);
  }
});

test('every portrait lands on a tile the atlas actually has', async () => {
  const css = await stylesheet();
  const { cols, rows } = grid(css);
  const { width, height } = await atlasSize();
  assert.equal(width % cols, 0, `atlas is ${width}px wide, which is not ${cols} whole tiles`);
  assert.equal(height % rows, 0, `atlas is ${height}px tall, which is not ${rows} whole tiles`);
  assert.equal(width / cols, height / rows, 'atlas tiles must be square');

  // A background-position percentage places tile n of a strip at n/(count-1).
  for (const [role, [x, y]] of portraits(css)) {
    const col = (x * (cols - 1)) / 100;
    const row = (y * (rows - 1)) / 100;
    assert.ok(Math.abs(col - Math.round(col)) < 0.01, `${role} sits between columns (${x}%)`);
    assert.ok(Math.abs(row - Math.round(row)) < 0.01, `${role} sits between rows (${y}%)`);
  }
});

test('every role has a source tile to rebuild the atlas from', async () => {
  for (const role of roles) {
    const tile = new URL(`../public/art/tiles/${role}.webp`, import.meta.url);
    await assert.doesNotReject(access(tile), `public/art/tiles/${role}.webp is missing`);
  }
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const verifier = fileURLToPath(new URL('../deploy/verify-pointer.mjs', import.meta.url));
const commit = 'a'.repeat(40);
const sha256 = 'b'.repeat(64);

function run(body) {
  return mkdtemp(join(tmpdir(), 'avalon-pointer-')).then(async (dir) => {
    const pointer = join(dir, 'latest.json');
    await writeFile(pointer, typeof body === 'string' ? body : JSON.stringify(body));
    return await new Promise((resolve) => {
      const child = spawn(process.execPath, [verifier, pointer]);
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (chunk) => { stdout += chunk; });
      child.stderr.on('data', (chunk) => { stderr += chunk; });
      child.on('close', (code) => resolve({ code, stdout, stderr }));
    });
  });
}

test('the stable pointer emits only its validated commit and digest', async () => {
  const result = await run({ schema: 1, commit, sha256, ignored: 'safe to ignore' });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout, `${commit}\n${sha256}\n`);
});

test('malformed and non-object pointers are rejected', async () => {
  for (const body of ['not json', 'null', '[]']) {
    assert.equal((await run(body)).code, 65, body);
  }
});

test('only schema 1 is accepted without coercion', async () => {
  for (const schema of [undefined, 0, 2, '1', null]) {
    assert.equal((await run({ schema, commit, sha256 })).code, 65, String(schema));
  }
});

test('commit and digest must be lowercase hexadecimal strings of exact length', async () => {
  const invalid = [
    { schema: 1, sha256 },
    { schema: 1, commit: 7, sha256 },
    { schema: 1, commit: 'A'.repeat(40), sha256 },
    { schema: 1, commit: 'a'.repeat(39), sha256 },
    { schema: 1, commit, sha256: 7 },
    { schema: 1, commit, sha256: 'B'.repeat(64) },
    { schema: 1, commit, sha256: 'b'.repeat(63) },
  ];
  for (const pointer of invalid) assert.equal((await run(pointer)).code, 65, JSON.stringify(pointer));
});

test('the contract accepts no archive URL or filename as authority', async () => {
  const result = await run({
    schema: 1,
    commit,
    sha256,
    archive: '../../candidate.tar.gz',
    url: 'https://attacker.invalid/release.tar.gz',
  });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout, `${commit}\n${sha256}\n`);
});

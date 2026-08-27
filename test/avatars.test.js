import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { AVATAR_STYLE_PROMPT, Avatars } from '../src/avatars.js';

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);
const webp = Buffer.from('RIFF0000WEBPavatar-test');

test('an uploaded avatar is validated, content-addressed, and persisted', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'avalon-avatars-'));
  const avatars = new Avatars({ directory, apiKey: null });
  const url = await avatars.resolve({ name: 'Ann', upload: `data:image/png;base64,${png.toString('base64')}` });

  assert.match(url, /^\/api\/avatars\/u-[a-f0-9]{64}\.png$/);
  const file = url.split('/').pop();
  const restarted = new Avatars({ directory, apiKey: null });
  const stored = await restarted.read(file);
  assert.equal(stored.mime, 'image/png');
  assert.deepEqual(stored.bytes, png);
});

test('a name generates one cached low-cost portrait in the player style', async () => {
  const requests = [];
  const fetchImpl = async (url, options) => {
    requests.push({ url, options, body: JSON.parse(options.body) });
    return {
      ok: true,
      status: 200,
      headers: { get: () => 'req_avatar' },
      json: async () => ({ data: [{ b64_json: webp.toString('base64') }] }),
    };
  };
  const avatars = new Avatars({ apiKey: 'test-key', fetchImpl, minGenerationInterval: 0 });
  const first = await avatars.resolve({ name: '蓝莓骑士' });
  const second = await avatars.resolve({ name: '蓝莓骑士' });

  assert.equal(first, second, 'the normalized name reuses its generated portrait');
  assert.equal(requests.length, 1);
  assert.equal(requests[0].url, 'https://api.openai.com/v1/images/generations');
  assert.equal(requests[0].body.model, 'gpt-image-2');
  assert.equal(requests[0].body.quality, 'low');
  assert.equal(requests[0].body.size, '1024x1024');
  assert.equal(requests[0].body.output_format, 'webp');
  assert.match(requests[0].body.prompt, /蓝莓骑士/);
  assert.match(AVATAR_STYLE_PROMPT, /PLAYER identity badge/);
  assert.match(AVATAR_STYLE_PROMPT, /no circle, no gold frame/);
});

test('missing credentials and the hourly ceiling fall back without blocking a seat', async () => {
  const noKey = new Avatars({ apiKey: null });
  assert.equal(await noKey.resolve({ name: 'Ann' }), null);

  let calls = 0;
  const limited = new Avatars({
    apiKey: 'test-key',
    generationLimit: 1,
    minGenerationInterval: 0,
    fetchImpl: async () => {
      calls += 1;
      return {
        ok: true, status: 200, headers: { get: () => null },
        json: async () => ({ data: [{ b64_json: webp.toString('base64') }] }),
      };
    },
  });
  assert.ok(await limited.resolve({ name: 'Ann' }));
  assert.equal(await limited.resolve({ name: 'Bob' }), null);
  assert.equal(calls, 1);
});

test('test-mode seats explicitly skip generation', async () => {
  const avatars = new Avatars({
    apiKey: 'test-key',
    fetchImpl: async () => { throw new Error('must not be called'); },
  });
  assert.equal(await avatars.resolve({ name: 'Player 2', upload: false }), null);
});

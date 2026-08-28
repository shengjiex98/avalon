import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  AVATAR_SAFE_SUBJECT_PROMPT,
  AVATAR_STYLE_PROMPT,
  AVATAR_SUBJECT_PROMPT,
  Avatars,
} from '../src/avatars.js';

const png = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=',
  'base64',
);
const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]);

test('an uploaded avatar is validated, content-addressed, and persisted', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'avalon-avatars-'));
  const avatars = new Avatars({ directory, apiToken: null });
  const url = await avatars.resolve({ name: 'Ann', upload: `data:image/png;base64,${png.toString('base64')}` });

  assert.match(url, /^\/api\/avatars\/u-[a-f0-9]{64}\.png$/);
  const file = url.split('/').pop();
  const restarted = new Avatars({ directory, apiToken: null });
  const stored = await restarted.read(file);
  assert.equal(stored.mime, 'image/png');
  assert.deepEqual(stored.bytes, png);
});

test('a name generates one cached low-cost portrait in the player style', async () => {
  const requests = [];
  const fetchImpl = async (url, options) => {
    requests.push({ url, options, body: JSON.parse(options.body) });
    if (url.endsWith('/@cf/qwen/qwen3-30b-a3b-fp8')) {
      return {
        ok: true,
        status: 200,
        headers: { get: () => 'cf-ray-subject' },
        json: async () => ({
          success: true,
          result: { choices: [{ message: { content: null, reasoning: 'blueberry knight' } }] },
        }),
      };
    }
    return {
      ok: true,
      status: 200,
      headers: { get: () => 'cf-ray-avatar' },
      json: async () => ({ success: true, result: { image: jpeg.toString('base64') } }),
    };
  };
  const avatars = new Avatars({
    accountId: 'test-account',
    apiToken: 'test-token',
    fetchImpl,
    minGenerationInterval: 0,
  });
  const first = await avatars.resolve({ name: '蓝莓骑士' });
  const second = await avatars.resolve({ name: '蓝莓骑士' });

  assert.equal(first, second, 'the normalized name reuses its generated portrait');
  assert.match(first, /^\/api\/avatars\/g-[a-f0-9]{64}\.jpeg$/);
  assert.equal((await avatars.read(first.split('/').pop())).mime, 'image/jpeg');
  assert.equal(requests.length, 2);
  assert.equal(
    requests[0].url,
    'https://api.cloudflare.com/client/v4/accounts/test-account/ai/run/@cf/qwen/qwen3-30b-a3b-fp8',
  );
  assert.deepEqual(Object.keys(requests[0].body).sort(), [
    'chat_template_kwargs', 'max_tokens', 'messages', 'temperature',
  ]);
  assert.match(requests[0].body.messages[1].content, /蓝莓骑士/);
  assert.match(AVATAR_SUBJECT_PROMPT, /小白 means a small friendly white creature mascot/);
  assert.match(AVATAR_SUBJECT_PROMPT, /大白 means a large friendly white creature mascot/);
  assert.equal(
    requests[1].url,
    'https://api.cloudflare.com/client/v4/accounts/test-account/ai/run/@cf/black-forest-labs/flux-1-schnell',
  );
  assert.deepEqual(Object.keys(requests[1].body).sort(), ['prompt', 'steps']);
  assert.equal(requests[1].body.steps, 4);
  assert.equal(
    requests[1].body.prompt,
    'Create a square JRPG manga-style avatar. Make blueberry knight the obvious main subject. No text or letters.',
  );
  assert.ok(!('image' in requests[1].body), 'the image API receives no reference image');
  assert.ok(requests[1].body.prompt.length <= 2048, 'the full prompt fits the model limit');
  assert.equal(requests[1].body.prompt.match(/\./g).length, 3);
  assert.equal(AVATAR_STYLE_PROMPT, 'Create a square JRPG manga-style avatar.');
});

test('a provider-filtered subject is safely rewritten and retried', async () => {
  const requests = [];
  const fetchImpl = async (url, options) => {
    const body = JSON.parse(options.body);
    requests.push({ url, body });
    if (url.endsWith('/@cf/qwen/qwen3-30b-a3b-fp8')) {
      const retry = body.messages[0].content === AVATAR_SAFE_SUBJECT_PROMPT;
      return {
        ok: true, status: 200, headers: { get: () => null },
        json: async () => ({
          success: true,
          result: { choices: [{ message: {
            content: retry ? 'friendly silver-haired gentleman in a blue suit' : 'Joe Biden',
            reasoning: null,
          } }] },
        }),
      };
    }
    const rejected = requests.filter((request) => request.url.endsWith('/@cf/black-forest-labs/flux-1-schnell')).length === 1;
    if (rejected) {
      return {
        ok: false, status: 400, headers: { get: () => 'cf-ray-filtered' },
        json: async () => ({ errors: [{ code: 8007, message: 'filtered' }] }),
      };
    }
    return {
      ok: true, status: 200, headers: { get: () => null },
      json: async () => ({ success: true, result: { image: jpeg.toString('base64') } }),
    };
  };
  const avatars = new Avatars({
    accountId: 'test-account', apiToken: 'test-token', fetchImpl, minGenerationInterval: 0,
  });

  assert.ok(await avatars.resolve({ name: '拜登' }));
  assert.equal(requests.length, 4);
  assert.match(requests[1].body.prompt, /Joe Biden/);
  assert.equal(requests[2].body.messages[0].content, AVATAR_SAFE_SUBJECT_PROMPT);
  assert.match(requests[2].body.messages[1].content, /拜登/);
  assert.match(requests[2].body.messages[1].content, /Joe Biden/);
  assert.match(requests[3].body.prompt, /friendly silver-haired gentleman in a blue suit/);
  assert.deepEqual(Object.keys(requests[3].body).sort(), ['prompt', 'steps']);
});

test('missing credentials and generation ceilings fall back without blocking a seat', async () => {
  const noKey = new Avatars({ accountId: null, apiToken: null });
  assert.equal(await noKey.resolve({ name: 'Ann' }), null);
  assert.equal(new Avatars({ accountId: 'account', apiToken: null }).canGenerate, false);
  assert.equal(new Avatars({ accountId: null, apiToken: 'token' }).canGenerate, false);

  let calls = 0;
  const limited = new Avatars({
    accountId: 'test-account',
    apiToken: 'test-token',
    generationLimit: -1,
    dailyGenerationLimit: 1,
    minGenerationInterval: 0,
    fetchImpl: async (url) => {
      calls += 1;
      if (url.endsWith('/@cf/qwen/qwen3-30b-a3b-fp8')) {
        return {
          ok: true, status: 200, headers: { get: () => null },
          json: async () => ({
            success: true,
            result: { choices: [{ message: { content: 'person', reasoning: null } }] },
          }),
        };
      }
      return {
        ok: true, status: 200, headers: { get: () => null },
        json: async () => ({ success: true, result: { image: jpeg.toString('base64') } }),
      };
    },
  });
  assert.ok(await limited.resolve({ name: 'Ann' }));
  assert.equal(await limited.resolve({ name: 'Bob' }), null);
  assert.equal(calls, 2);
});

test('test-mode seats explicitly skip generation', async () => {
  const avatars = new Avatars({
    accountId: 'test-account',
    apiToken: 'test-token',
    fetchImpl: async () => { throw new Error('must not be called'); },
  });
  assert.equal(await avatars.resolve({ name: 'Player 2', upload: false }), null);
});

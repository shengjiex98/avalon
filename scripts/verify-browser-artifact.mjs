import { access, readFile, readdir } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { API_PROTOCOL } from '../src/contracts/api-protocol.ts';

const REQUIRED_COPY_ONLY = [
  'art/card-back.webp', 'art/jrpg-role-atlas.webp',
  'audio/onuw/unlock.wav', 'audio/onuw/en/wake-dawn.mp3', 'audio/onuw/zh/wake-dawn.mp3',
];

export async function verifyBrowserArtifact(directory, {
  target,
  commit,
  apiBase = '',
}) {
  if (target !== 'self-hosted' && target !== 'pages') throw new Error(`unknown browser target ${target}`);
  if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error('invalid browser artifact commit');
  apiBase = apiBase.trim().replace(/\/+$/, '');

  const root = resolve(directory);
  for (const name of ['index.html', 'config.js', 'version.json', '.vite/manifest.json', ...REQUIRED_COPY_ONLY]) {
    await required(root, name);
  }

  const files = await filesBelow(root);
  const forbidden = files.find((name) => name.endsWith('.ts') || name.endsWith('.map'));
  if (forbidden) throw new Error(`development file shipped in browser artifact: ${forbidden}`);

  const manifest = await readJson(root, '.vite/manifest.json', 'Vite manifest');
  const entry = manifest['index.html'];
  if (!entry || typeof entry !== 'object' || entry.isEntry !== true || typeof entry.file !== 'string') {
    throw new Error('Vite manifest does not select the index.html entry');
  }

  const outputs = new Set();
  collectOutputs(manifest, 'index.html', outputs, new Set());
  for (const name of outputs) await required(root, safeOutput(root, name));

  const html = await readFile(join(root, 'index.html'), 'utf8');
  const configPosition = html.indexOf('./config.js');
  const entryPosition = html.indexOf(`./${entry.file}`);
  if (configPosition < 0 || entryPosition < 0 || configPosition > entryPosition) {
    throw new Error('index.html does not load runtime configuration before its Vite entry');
  }
  for (const css of entry.css ?? []) {
    if (!html.includes(`./${css}`)) throw new Error(`index.html does not load manifest stylesheet ${css}`);
  }

  const config = await readFile(join(root, 'config.js'), 'utf8');
  const configured = /Object\.freeze\((\{.*\})\)/.exec(config)?.[1];
  let value;
  try {
    value = JSON.parse(configured ?? '');
  } catch {
    throw new Error(`${target} config.js does not contain a configuration object`);
  }
  if (value.apiBase !== apiBase) throw new Error(`${target} config.js does not contain the packaged API base`);
  if (value.apiProtocol !== API_PROTOCOL) {
    throw new Error(`${target} config.js does not contain API protocol ${API_PROTOCOL}`);
  }

  const javascript = [...outputs].filter((name) => name.endsWith('.js'));
  const sources = await Promise.all(javascript.map((name) => readFile(join(root, name), 'utf8')));
  if (!sources.some((source) => source.includes(commit))) {
    throw new Error('browser entry graph does not contain its release identity');
  }

  const version = await readJson(root, 'version.json', `${target} version`);
  if (version.version !== commit) throw new Error(`${target} version does not match its commit`);
  if (target === 'pages') await required(root, '.nojekyll');
  else if (files.includes('.nojekyll')) throw new Error('self-hosted browser artifact contains Pages metadata');
}

function collectOutputs(manifest, key, outputs, seen) {
  if (seen.has(key)) return;
  seen.add(key);
  const chunk = manifest[key];
  if (!chunk || typeof chunk !== 'object') throw new Error(`Vite manifest references missing chunk ${key}`);
  for (const name of [chunk.file, ...(chunk.css ?? []), ...(chunk.assets ?? [])]) {
    if (typeof name !== 'string') throw new Error(`Vite manifest has an invalid output for ${key}`);
    outputs.add(name);
  }
  for (const imported of [...(chunk.imports ?? []), ...(chunk.dynamicImports ?? [])]) {
    if (typeof imported !== 'string') throw new Error(`Vite manifest has an invalid import for ${key}`);
    collectOutputs(manifest, imported, outputs, seen);
  }
}

function safeOutput(root, name) {
  const output = resolve(root, name);
  if (relative(root, output).startsWith('..')) throw new Error(`Vite manifest output escapes the artifact: ${name}`);
  return relative(root, output);
}

async function readJson(root, name, description) {
  try {
    return JSON.parse(await readFile(join(root, name), 'utf8'));
  } catch (error) {
    throw new Error(`cannot read ${description}: ${error.message}`);
  }
}

async function required(root, name) {
  try {
    await access(join(root, name));
  } catch {
    throw new Error(`missing browser artifact file ${name}`);
  }
}

async function filesBelow(root) {
  return (await readdir(root, { recursive: true, withFileTypes: true }))
    .filter((entry) => entry.isFile())
    .map((entry) => relative(root, join(entry.parentPath, entry.name)));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [, , directory, target, commit, apiBase = ''] = process.argv;
  if (!directory || !target || !commit) {
    console.error('Usage: verify-browser-artifact.mjs <directory> <self-hosted|pages> <commit> [api-base]');
    process.exitCode = 64;
  } else {
    try {
      await verifyBrowserArtifact(directory, { target, commit, apiBase });
      process.stdout.write(`verified ${target} browser artifact\n`);
    } catch (error) {
      console.error(`invalid browser artifact: ${error.message}`);
      process.exitCode = 65;
    }
  }
}

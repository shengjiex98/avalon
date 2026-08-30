import { access, readFile, readdir } from 'node:fs/promises';
import { dirname, join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

import { API_PROTOCOL } from '../src/contracts/api-protocol.ts';

const REQUIRED = [
  'index.html', 'styles.css', 'bootstrap.js', 'app.js', 'config.js',
  'art/card-back.webp', 'art/jrpg-role-atlas.webp',
  'audio/onuw/unlock.wav', 'audio/onuw/en/wake-dawn.mp3', 'audio/onuw/zh/wake-dawn.mp3',
];
const IMPORT = /(\bfrom\s+|\bimport\s*(?:\(\s*)?)(['"])(\.\.?\/[^'"]+\.js(?:\?[^'"]*)?)\2/g;

export async function verifyBrowserArtifact(directory, {
  target,
  commit,
  apiBase = '',
}) {
  if (target !== 'self-hosted' && target !== 'pages') throw new Error(`unknown browser target ${target}`);
  if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error('invalid browser artifact commit');
  apiBase = apiBase.trim().replace(/\/+$/, '');

  const root = resolve(directory);
  for (const name of REQUIRED) await required(root, name);

  const files = await filesBelow(root);
  const forbidden = files.find((name) => name.endsWith('.ts') || name.endsWith('.map'));
  if (forbidden) throw new Error(`development file shipped in browser artifact: ${forbidden}`);

  for (const name of files.filter((file) => file.endsWith('.js'))) {
    const source = await readFile(join(root, name), 'utf8');
    for (const match of source.matchAll(IMPORT)) {
      const specifier = match[3];
      const [pathname, query = ''] = specifier.split('?', 2);
      const imported = resolve(dirname(join(root, name)), pathname);
      if (relative(root, imported).startsWith('..')) throw new Error(`${name} imports outside the artifact: ${specifier}`);
      await required(root, relative(root, imported));
      if (target === 'pages' && query !== `v=${encodeURIComponent(commit)}`) {
        throw new Error(`${name} has an unstamped import: ${specifier}`);
      }
      if (target === 'self-hosted' && query) throw new Error(`${name} has an unexpected stamped import: ${specifier}`);
    }
  }

  const config = await readFile(join(root, 'config.js'), 'utf8');
  const configured = /export const API_BASE = (['"])(.*?)\1;/.exec(config)?.[2];
  if (configured !== apiBase) {
    throw new Error(`${target} config.js does not contain the packaged API base`);
  }
  const protocol = Number(/export const API_PROTOCOL = (\d+);/.exec(config)?.[1]);
  if (protocol !== API_PROTOCOL) {
    throw new Error(`${target} config.js does not contain API protocol ${API_PROTOCOL}`);
  }

  if (target === 'pages') {
    const version = JSON.parse(await readFile(join(root, 'version.json'), 'utf8'));
    if (version.version !== commit) throw new Error('Pages version does not match its commit');
    await required(root, '.nojekyll');
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

import { cp, mkdir, rm, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { stampFrontend } from './stamp-frontend-version.mjs';

const [, , commit, outputDirectory, configuredBase = ''] = process.argv;
const COMMIT = /^[0-9a-f]{40}$/;

if (!COMMIT.test(commit ?? '') || !outputDirectory) {
  console.error('Usage: stage-browser-artifacts.mjs <40-character-commit> <output-directory> [pages-api-base]');
  process.exit(64);
}

const root = fileURLToPath(new URL('../', import.meta.url));
const canonical = join(root, 'build/public');
const output = resolve(outputDirectory);
const selfHosted = join(output, 'self-hosted-public');
const pages = join(output, 'pages');
const apiBase = configuredBase.trim().replace(/\/+$/, '');

await rm(selfHosted, { recursive: true, force: true });
await rm(pages, { recursive: true, force: true });
await mkdir(output, { recursive: true });
await cp(canonical, selfHosted, { recursive: true });
await cp(canonical, pages, { recursive: true });

await writeConfig(selfHosted, '', 'self-hosted');
await writeConfig(pages, apiBase, 'Pages');
await stampFrontend(pages, commit);
await writeFile(join(pages, '.nojekyll'), '');

async function writeConfig(directory, base, target) {
  await writeFile(
    join(directory, 'config.js'),
    `// Generated for the ${target} release.\nexport const API_BASE = ${JSON.stringify(base)};\n`,
  );
}

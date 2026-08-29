import { writeFile } from 'node:fs/promises';

import { API_PROTOCOL } from '../src/api-protocol.ts';
import { STATE_VERSION } from '../src/state-version.ts';

const [, , commit, output] = process.argv;

if (!/^[0-9a-f]{40}$/.test(commit ?? '') || !output) {
  console.error('Usage: write-release-manifest.mjs <40-character-commit> <output>');
  process.exit(64);
}

const manifest = {
  commit,
  stateVersion: STATE_VERSION,
  apiProtocol: API_PROTOCOL,
  nodeMajor: 24,
  deployerSchema: 1,
};

await writeFile(output, `${JSON.stringify(manifest, null, 2)}\n`);

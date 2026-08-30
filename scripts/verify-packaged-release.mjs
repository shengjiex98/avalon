import { readFile, readdir } from 'node:fs/promises';
import { join, relative } from 'node:path';

import { API_PROTOCOL } from '../src/contracts/api-protocol.ts';
import { STATE_VERSION } from '../src/contracts/state-version.ts';
import { verifyBrowserArtifact } from './verify-browser-artifact.mjs';

const [, , releaseDir, expectedCommit] = process.argv;
const COMMIT = /^[0-9a-f]{40}$/;

function reject(message) {
  throw new Error(message);
}

try {
  if (!releaseDir || !COMMIT.test(expectedCommit ?? '')) {
    console.error('Usage: verify-packaged-release.mjs <release-directory> <40-character-commit>');
    process.exitCode = 64;
  } else {
    let manifest;
    try {
      manifest = JSON.parse(await readFile(join(releaseDir, 'release.json'), 'utf8'));
    } catch (error) {
      reject(`cannot read release.json: ${error.message}`);
    }

    if (manifest.commit !== expectedCommit) reject('manifest commit does not match the workflow commit');
    if (manifest.stateVersion !== STATE_VERSION) reject(`unexpected stateVersion ${manifest.stateVersion}`);
    if (manifest.apiProtocol !== API_PROTOCOL) reject(`unexpected apiProtocol ${manifest.apiProtocol}`);
    if (manifest.nodeMajor !== 24) reject(`unsupported Node major ${manifest.nodeMajor}`);
    if (manifest.deployerSchema !== 3) reject(`unsupported deployer schema ${manifest.deployerSchema}`);
    if (Number(process.versions.node.split('.')[0]) !== manifest.nodeMajor) {
      reject(`release requires Node ${manifest.nodeMajor}, running ${process.versions.node}`);
    }

    const entries = await readdir(releaseDir, { recursive: true, withFileTypes: true });
    for (const entry of entries) {
      const name = relative(releaseDir, join(entry.parentPath, entry.name));
      if (!entry.isFile() && !entry.isDirectory()) reject(`unsupported release object ${name}`);
      if (entry.isFile() && name !== 'release.json' && name !== 'build/server/main.mjs'
          && !name.startsWith('build/public/')) reject(`unexpected release file ${name}`);
      if (entry.isDirectory() && name !== 'build' && name !== 'build/server'
          && name !== 'build/public' && !name.startsWith('build/public/')) {
        reject(`unexpected release directory ${name}`);
      }
    }

    const server = await readFile(join(releaseDir, 'build/server/main.mjs'), 'utf8');
    for (const match of server.matchAll(/\b(?:from|import)\s+['"]([^'"]+)['"]/g)) {
      if (!match[1].startsWith('node:')) reject(`server bundle has a runtime import: ${match[1]}`);
    }
    if (/sourceMappingURL=/.test(server)) reject('server bundle contains a source map reference');

    await verifyBrowserArtifact(join(releaseDir, 'build/public'), {
      target: 'self-hosted', commit: expectedCommit, apiBase: '',
    });

    process.stdout.write(`${JSON.stringify(manifest)}\n`);
  }
} catch (error) {
  console.error(`invalid packaged Avalon release: ${error.message}`);
  process.exitCode = 65;
}

import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';

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
    if (!Number.isInteger(manifest.stateVersion) || manifest.stateVersion < 1) reject('invalid stateVersion');
    if (!Number.isInteger(manifest.apiProtocol) || manifest.apiProtocol < 1) reject('invalid apiProtocol');
    if (manifest.nodeMajor !== 24) reject(`unsupported Node major ${manifest.nodeMajor}`);
    if (manifest.deployerSchema !== 1) reject(`unsupported deployer schema ${manifest.deployerSchema}`);
    if (Number(process.versions.node.split('.')[0]) !== manifest.nodeMajor) {
      reject(`release requires Node ${manifest.nodeMajor}, running ${process.versions.node}`);
    }

    for (const name of [
      'package.json', 'node_modules/zod/package.json', 'src/server.js', 'src/server.ts', 'public/index.html',
    ]) {
      try {
        await access(join(releaseDir, name));
      } catch {
        reject(`missing ${name}`);
      }
    }

    process.stdout.write(`${JSON.stringify(manifest)}\n`);
  }
} catch (error) {
  console.error(`invalid packaged Avalon release: ${error.message}`);
  process.exitCode = 65;
}

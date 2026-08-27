import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';

const [, , releaseDir, expectedCommit] = process.argv;
const sha = /^[0-9a-f]{40}$/;

function reject(message) {
  throw new Error(message);
}

try {
  if (!releaseDir || !sha.test(expectedCommit ?? '')) {
    reject('expected a release directory and 40-character commit');
  }

  let manifest;
  try {
    manifest = JSON.parse(await readFile(join(releaseDir, 'release.json'), 'utf8'));
  } catch (error) {
    reject(`cannot read release.json: ${error.message}`);
  }

  if (manifest.commit !== expectedCommit) reject('manifest commit does not match the requested commit');
  if (!Number.isInteger(manifest.stateVersion) || manifest.stateVersion < 1) reject('stateVersion is not a positive integer');
  if (!Number.isInteger(manifest.apiProtocol) || manifest.apiProtocol < 1) reject('apiProtocol is not a positive integer');
  if (manifest.nodeMajor !== 24) reject(`unsupported Node major ${manifest.nodeMajor}`);
  if (manifest.deployerSchema !== 1) reject(`unsupported deployer schema ${manifest.deployerSchema}`);

  const runtimeMajor = Number(process.versions.node.split('.')[0]);
  if (runtimeMajor !== manifest.nodeMajor) {
    reject(`release requires Node ${manifest.nodeMajor}, running ${runtimeMajor}`);
  }

  for (const path of ['package.json', 'src/server.js', 'public/index.html']) {
    try {
      await access(join(releaseDir, path));
    } catch {
      reject(`missing ${path}`);
    }
  }

  process.stdout.write(`${JSON.stringify(manifest)}\n`);
} catch (error) {
  console.error(`invalid Avalon release: ${error.message}`);
  process.exitCode = 65;
}

import { access, readFile } from 'node:fs/promises';
import { join } from 'node:path';

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
    if (!Number.isInteger(manifest.stateVersion) || manifest.stateVersion < 1) reject('invalid stateVersion');
    if (!Number.isInteger(manifest.apiProtocol) || manifest.apiProtocol < 1) reject('invalid apiProtocol');
    if (manifest.nodeMajor !== 24) reject(`unsupported Node major ${manifest.nodeMajor}`);
    if (manifest.deployerSchema !== 2) reject(`unsupported deployer schema ${manifest.deployerSchema}`);
    if (Number(process.versions.node.split('.')[0]) !== manifest.nodeMajor) {
      reject(`release requires Node ${manifest.nodeMajor}, running ${process.versions.node}`);
    }

    const packageJson = JSON.parse(await readFile(join(releaseDir, 'package.json'), 'utf8'));
    const packageLock = JSON.parse(await readFile(join(releaseDir, 'package-lock.json'), 'utf8'));
    const dependencies = Object.keys(packageJson.dependencies ?? {});
    if (!dependencies.length) reject('release manifest has no production dependencies');
    for (const dependency of dependencies) {
      if (!(dependency in (packageLock.packages?.['']?.dependencies ?? {}))) {
        reject(`${dependency} is not locked as a production dependency`);
      }
      try {
        await access(join(releaseDir, 'node_modules', dependency, 'package.json'));
      } catch {
        reject(`missing production package ${dependency}`);
      }
    }

    for (const dependency of Object.keys(packageJson.devDependencies ?? {})) {
      if (await exists(join(releaseDir, 'node_modules', dependency, 'package.json'))) {
        reject(`development package shipped in release: ${dependency}`);
      }
    }

    for (const name of [
      'package.json', 'package-lock.json', 'src/server/main.ts',
      'deploy/updater.sh', 'deploy/avalon.service',
      'scripts/verify-browser-artifact.mjs', 'scripts/verify-packaged-release.mjs',
    ]) {
      try {
        await access(join(releaseDir, name));
      } catch {
        reject(`missing ${name}`);
      }
    }

    for (const name of ['test', 'node_modules/typescript', 'node_modules/@types/node']) {
      if (await exists(join(releaseDir, name))) reject(`development-only path shipped in release: ${name}`);
    }

    await verifyBrowserArtifact(join(releaseDir, 'build/public'), {
      target: 'self-hosted', commit: expectedCommit, apiBase: '',
    });

    process.stdout.write(`${JSON.stringify(manifest)}\n`);
  }
} catch (error) {
  console.error(`invalid packaged Avalon release: ${error.message}`);
  process.exitCode = 65;
}

async function exists(path) {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

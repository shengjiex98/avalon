import { readFile } from 'node:fs/promises';

const [, , pointerPath] = process.argv;
const COMMIT = /^[0-9a-f]{40}$/;
const SHA256 = /^[0-9a-f]{64}$/;

function reject(message) {
  throw new Error(message);
}

try {
  if (!pointerPath) {
    console.error('Usage: verify-pointer.mjs <latest.json>');
    process.exitCode = 64;
  } else {
    let pointer;
    try {
      pointer = JSON.parse(await readFile(pointerPath, 'utf8'));
    } catch (error) {
      reject(`cannot read pointer: ${error.message}`);
    }

    if (!pointer || typeof pointer !== 'object' || Array.isArray(pointer)) {
      reject('pointer is not a JSON object');
    }
    if (pointer.schema !== 1) reject(`unsupported schema ${String(pointer.schema)}`);
    if (typeof pointer.commit !== 'string' || !COMMIT.test(pointer.commit)) {
      reject('commit is not a 40-character lowercase hexadecimal string');
    }
    if (typeof pointer.sha256 !== 'string' || !SHA256.test(pointer.sha256)) {
      reject('sha256 is not a 64-character lowercase hexadecimal string');
    }

    process.stdout.write(`${pointer.commit}\n${pointer.sha256}\n`);
  }
} catch (error) {
  console.error(`invalid Avalon release pointer: ${error.message}`);
  process.exitCode = 65;
}

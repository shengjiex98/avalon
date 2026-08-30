import { cp, mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';

import { browserConfig } from './browser-config.mjs';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const OUTPUT = join(ROOT, 'build/public');

function run(command, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { cwd: ROOT, stdio: 'inherit' });
    child.on('error', reject);
    child.on('close', (code) => code === 0
      ? resolve()
      : reject(new Error(`${command} exited with status ${code}`)));
  });
}

const temporary = await mkdtemp(join(tmpdir(), 'avalon-browser-'));
try {
  await rm(OUTPUT, { recursive: true, force: true });
  await run(process.execPath, [
    join(ROOT, 'node_modules/typescript/bin/tsc'),
    '-p', join(ROOT, 'tsconfig.browser.json'),
    '--outDir', temporary,
  ]);
  await mkdir(OUTPUT, { recursive: true });
  await cp(join(temporary, 'src/client'), OUTPUT, { recursive: true });
  await cp(join(ROOT, 'public'), OUTPUT, { recursive: true });
  await writeFile(join(OUTPUT, 'config.js'), browserConfig('', 'local build'));
} finally {
  await rm(temporary, { recursive: true, force: true });
}

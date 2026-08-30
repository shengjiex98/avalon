// Keep the immediately preceding release layout restartable during the one
// schema cutover. New releases always take the bundled entry first.
import { access } from 'node:fs/promises';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

const root = process.cwd();
const candidates = [
  join(root, 'build/server/main.mjs'),
  join(root, 'src/server/main.ts'),
];

let entry;
for (const candidate of candidates) {
  try {
    await access(candidate);
    entry = candidate;
    break;
  } catch { /* try the one legacy layout */ }
}
if (!entry) throw new Error('selected Avalon release has no supported server entry');

const application = await import(pathToFileURL(entry).href);
if (typeof application.start !== 'function') throw new Error('selected Avalon entry does not export start()');
application.start();

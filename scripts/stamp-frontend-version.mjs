import { readdir, readFile, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

/** Fingerprint the manifest and every relative JavaScript import in a Pages build. */
export async function stampFrontend(directory, version) {
  if (!/^[a-zA-Z0-9._-]{1,128}$/.test(version)) throw new Error('Invalid front-end version');
  const root = resolve(directory);
  await writeFile(join(root, 'version.json'), `${JSON.stringify({ version }, null, 2)}\n`);

  for (const file of await javascriptFiles(root)) {
    const source = await readFile(file, 'utf8');
    const stamped = source.replace(
      /(\bfrom\s+|\bimport\s*(?:\(\s*)?)(['"])(\.\.?\/[^'"]+\.js)\2/g,
      (_, lead, quote, specifier) => `${lead}${quote}${specifier}?v=${encodeURIComponent(version)}${quote}`,
    );
    if (stamped !== source) await writeFile(file, stamped);
  }
}

async function javascriptFiles(dir) {
  const files = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...await javascriptFiles(path));
    else if (entry.isFile() && entry.name.endsWith('.js')) files.push(path);
  }
  return files;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const [, , directory, version] = process.argv;
  if (!directory || !version) throw new Error('Usage: stamp-frontend-version.mjs <public-dir> <version>');
  await stampFrontend(directory, version);
}

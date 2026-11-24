// Rebuilds marketplace/index.json from marketplace/packages/*.json: each package's id, version,
// file and the SHA-256 of its exact bytes, which Hive checks before installing it.
// Usage: node scripts/marketplace-index.mjs
import { createHash } from 'node:crypto';
import { readdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'marketplace');
const folder = path.join(root, 'packages');
const files = (await readdir(folder)).filter((name) => name.endsWith('.json')).sort();
const packages = [];
for (const name of files) {
  const raw = await readFile(path.join(folder, name), 'utf8');
  const manifest = JSON.parse(raw);
  packages.push({
    id: manifest.id,
    version: manifest.version,
    path: `packages/${name}`,
    sha256: createHash('sha256').update(raw, 'utf8').digest('hex'),
  });
}
await writeFile(
  path.join(root, 'index.json'),
  `${JSON.stringify({ schemaVersion: 1, packages }, null, 2)}\n`,
);
console.log(`${packages.length} pacote(s) no índice.`);

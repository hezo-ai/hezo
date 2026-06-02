import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

// Emit a plain `{ filename: sql }` JSON map that `src/db/migrate.ts` imports
// statically, so `bun build --compile` embeds it into the binary's virtual FS.
// A runtime `readFile` of a sibling path is NOT embedded by the compiler (it
// resolves to `/$bunfs/root/...` and ENOENTs), so the SQL must travel through
// the module graph. The migrations are small (~50KB), so no compression.
const migrationsDir = join(import.meta.dir, '..', 'migrations');
const outputPath = join(import.meta.dir, '..', 'src', 'db', 'migrations-bundle.json');

const files = (await readdir(migrationsDir)).filter((f) => f.endsWith('.sql')).sort();
const bundle: Record<string, string> = {};
for (const file of files) {
	bundle[file] = await readFile(join(migrationsDir, file), 'utf-8');
}

await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, JSON.stringify(bundle));
console.log(`Bundled ${files.length} migration(s) → ${outputPath}`);

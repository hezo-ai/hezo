import { cp, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';

// PGlite loads its runtime assets (the Postgres WASM and the packed filesystem)
// via `new URL(..., import.meta.url)`, which `bun build --compile` does NOT embed.
// Copy them into the source tree so `db/pglite-assets.ts` can embed them with
// `import ... with { type: 'file' }` and feed them to PGlite from memory in the
// compiled binary.
const ASSETS = ['postgres.wasm', 'postgres.data'];

const pgliteEntry = Bun.resolveSync('@electric-sql/pglite', import.meta.dir);
const distDir = dirname(pgliteEntry);
const outDir = join(import.meta.dir, '..', 'src', 'generated', 'pglite');

await mkdir(outDir, { recursive: true });
for (const file of ASSETS) {
	await cp(join(distDir, file), join(outDir, file));
}
console.log(`Bundled ${ASSETS.length} PGlite runtime asset(s) → ${outDir}`);

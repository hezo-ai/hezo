import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { zip } from '@hiddentao/zip-json';

const migrationsDir = join(import.meta.dir, '..', 'migrations');
const outputPath = join(import.meta.dir, '..', 'src', 'db', 'migrations-bundle.json');

const archive = await zip(['*.sql'], {
	baseDir: migrationsDir,
});

await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, JSON.stringify(archive));
console.log(`Bundled migrations → ${outputPath}`);

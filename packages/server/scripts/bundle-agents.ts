import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { zip } from '@hiddentao/zip-json';

const agentsDir = join(import.meta.dir, '..', '..', '..', '.dev', 'agents');
const outputPath = join(import.meta.dir, '..', 'src', 'db', 'agents-bundle.json');

const archive = await zip(['*.md'], {
	baseDir: agentsDir,
});

await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, JSON.stringify(archive));
console.log(`Bundled agent roles → ${outputPath}`);

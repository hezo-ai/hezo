import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { loadFilesystemDocs } from '../src/services/docs-bundle';

// The repo's user-facing docs (docs/**/*.md) bundled into a JSON map so the
// compiled binary can inject the full documentation into the CEO chat context
// at runtime (a runtime filesystem read of docs/ would not be embedded). Mirrors
// scripts/bundle-agents.ts.
const docsDir = join(import.meta.dir, '..', '..', '..', 'docs');
const outputPath = join(import.meta.dir, '..', 'src', 'services', 'docs-bundle.json');

const docs = await loadFilesystemDocs(docsDir);

await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, JSON.stringify(docs));
console.log(`Bundled ${Object.keys(docs).length} docs → ${outputPath}`);

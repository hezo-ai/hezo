import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { loadFilesystemAgentRoles } from '../src/db/agent-roles';
import { resolvePartials } from '../src/db/resolve-partials';

const agentsDir = join(import.meta.dir, '..', '..', '..', '.dev', 'agents');
const outputPath = join(import.meta.dir, '..', 'src', 'db', 'agents-bundle.json');

const raw = await loadFilesystemAgentRoles(agentsDir);
const resolved = resolvePartials(raw);

await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, JSON.stringify(resolved));
console.log(`Bundled agent roles → ${outputPath}`);

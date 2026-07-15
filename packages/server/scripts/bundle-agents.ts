import { existsSync } from 'node:fs';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { loadFilesystemAgentRoles } from '../src/db/agent-roles';
import { resolvePartials } from '../src/db/resolve-partials';

const agentsDir = join(import.meta.dir, '..', '..', '..', 'agents');
const outputPath = join(import.meta.dir, '..', 'src', 'db', 'agents-bundle.json');

const raw = await loadFilesystemAgentRoles(agentsDir);
const resolved = resolvePartials(raw);

// Marketplace team dirs (those carrying a `team.json` manifest) ship via the
// marketplace (`marketplace/teams/*.json`), NOT the binary — their prompt bodies
// are built into the committed team JSONs and must not also be embedded here. Keep
// `_instance/*` (CEO/Coach) and `blank/captain.md` (the binary bootstrap roles).
const entries = await readdir(agentsDir, { withFileTypes: true });
const marketplaceDirs = entries
	.filter(
		(e) =>
			e.isDirectory() &&
			!e.name.startsWith('_') &&
			existsSync(join(agentsDir, e.name, 'team.json')),
	)
	.map((e) => e.name);

const filtered: Record<string, string> = {};
for (const [key, value] of Object.entries(resolved)) {
	if (marketplaceDirs.some((dir) => key.startsWith(`${dir}/`))) continue;
	filtered[key] = value;
}

await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, JSON.stringify(filtered));
console.log(
	`Bundled agent roles → ${outputPath} (excluded marketplace team dirs: ${marketplaceDirs.join(', ') || 'none'})`,
);

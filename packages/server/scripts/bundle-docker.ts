import { mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join, relative, sep } from 'node:path';

// Bundle the agent-base Docker build context (`docker/`) into a single JSON map
// that `src/services/docker-assets.ts` imports via a literal dynamic import, so
// `bun build --compile` embeds it into the binary's virtual FS. A compiled
// binary has no repo checkout on disk, so without this the agent-base image can
// neither be pulled (it is published to no registry) nor built (no Dockerfile on
// disk) — provisioning the first container would 404. At startup the binary
// extracts this bundle to the data dir and builds the image locally from it.
// Files are base64-encoded so the JSON carries exact bytes (the Dockerfile chmods
// its own scripts, so host-side exec bits don't need to survive).
const dockerDir = join(import.meta.dir, '..', '..', '..', 'docker');
const outputPath = join(import.meta.dir, '..', 'src', 'docker-bundle.json');

async function walk(dir: string): Promise<string[]> {
	const entries = await readdir(dir, { withFileTypes: true });
	const out: string[] = [];
	for (const entry of entries) {
		const full = join(dir, entry.name);
		if (entry.isDirectory()) out.push(...(await walk(full)));
		else if (entry.isFile()) out.push(full);
	}
	return out;
}

const files = (await walk(dockerDir)).sort();
const bundle: Record<string, string> = {};
for (const full of files) {
	// Key relative to the repo root (`docker/...`) so extraction reproduces the
	// same layout `resolveLocalImage` expects under its base dir.
	const key = `docker/${relative(dockerDir, full).split(sep).join('/')}`;
	bundle[key] = (await readFile(full)).toString('base64');
}

await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, JSON.stringify(bundle));
console.log(`Bundled ${files.length} docker context file(s) → ${outputPath}`);

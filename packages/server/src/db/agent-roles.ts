import { resolvePartials } from './resolve-partials';

export async function loadBundledAgentRoles(): Promise<Record<string, string>> {
	// Literal dynamic import so `bun build --compile` embeds the JSON into the
	// binary's virtual FS (a runtime `readFile` of a sibling path is not embedded
	// and ENOENTs at `/$bunfs/root/...`). In dev the file may be absent — the
	// import rejects and `loadAgentRoles` falls back to the filesystem walk.
	let mod: { default: Record<string, string> };
	try {
		mod = (await import('./agents-bundle.json')) as { default: Record<string, string> };
	} catch {
		throw new Error("Failed to load agent roles bundle. Run 'bun run build:agents' first.");
	}
	// An empty stub (written by `scripts/ensure-bundles.ts` so tsc/vite can
	// resolve the literal import) means the bundle was never generated — treat it
	// as absent so `loadAgentRoles` falls back to the filesystem walk.
	if (Object.keys(mod.default).length === 0) {
		throw new Error('Agent roles bundle is empty. Run "bun run build:agents" first.');
	}
	return mod.default;
}

export async function loadFilesystemAgentRoles(agentsDir: string): Promise<Record<string, string>> {
	const { readdir, readFile } = await import('node:fs/promises');
	const { join, relative, sep } = await import('node:path');

	async function walk(dir: string): Promise<string[]> {
		const entries = await readdir(dir, { withFileTypes: true });
		const results: string[] = [];
		for (const entry of entries) {
			const full = join(dir, entry.name);
			if (entry.isDirectory()) results.push(...(await walk(full)));
			else if (entry.isFile() && entry.name.endsWith('.md')) results.push(full);
		}
		return results;
	}

	const files = (await walk(agentsDir)).sort();
	const roles: Record<string, string> = {};
	await Promise.all(
		files.map(async (full) => {
			const key = relative(agentsDir, full).split(sep).join('/');
			roles[key] = await readFile(full, 'utf-8');
		}),
	);
	return roles;
}

export async function loadAgentRoles(): Promise<Record<string, string>> {
	// Test harnesses (vitest under vite) can set HEZO_AGENTS_DIR to bypass the
	// import.meta.url resolution that vite rewrites into a `/@fs/...` virtual
	// URL the filesystem can't read.
	if (process.env.HEZO_AGENTS_DIR) {
		const raw = await loadFilesystemAgentRoles(process.env.HEZO_AGENTS_DIR);
		return resolvePartials(raw);
	}
	try {
		return await loadBundledAgentRoles();
	} catch {
		const { join } = await import('node:path');
		const agentsDir = join(
			new URL('.', import.meta.url).pathname,
			'..',
			'..',
			'..',
			'..',
			'agents',
		);
		const raw = await loadFilesystemAgentRoles(agentsDir);
		return resolvePartials(raw);
	}
}

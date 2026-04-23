import { resolvePartials } from './resolve-partials';

export async function loadBundledAgentRoles(): Promise<Record<string, string>> {
	const { readFile } = await import('node:fs/promises');
	const { join } = await import('node:path');

	const currentDir = new URL('.', import.meta.url).pathname;
	const bundlePath = join(currentDir, 'agents-bundle.json');
	let raw: string;
	try {
		raw = await readFile(bundlePath, 'utf-8');
	} catch {
		throw new Error("Failed to load agent roles bundle. Run 'bun run build:agents' first.");
	}
	return JSON.parse(raw) as Record<string, string>;
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

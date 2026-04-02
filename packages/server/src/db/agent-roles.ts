export async function loadBundledAgentRoles(): Promise<Record<string, string>> {
	const { unzip, list } = await import('@hiddentao/zip-json');
	const { readFile, mkdir, rm } = await import('node:fs/promises');
	const { join } = await import('node:path');
	const { tmpdir } = await import('node:os');

	const currentDir = new URL('.', import.meta.url).pathname;
	const bundlePath = join(currentDir, 'agents-bundle.json');
	// biome-ignore lint/suspicious/noExplicitAny: JSON.parse returns unknown, zip-json expects its own type
	let archive: any;
	try {
		archive = JSON.parse(await readFile(bundlePath, 'utf-8'));
	} catch {
		throw new Error("Failed to load agent roles bundle. Run 'bun run build:agents' first.");
	}

	const files = list(archive);
	const tmpExtractDir = join(tmpdir(), `hezo-agents-${Date.now()}`);
	await mkdir(tmpExtractDir, { recursive: true });

	try {
		await unzip(archive, { outputDir: tmpExtractDir });
		const roles: Record<string, string> = {};
		await Promise.all(
			files.map(async (file: { path: string }) => {
				roles[file.path] = await readFile(join(tmpExtractDir, file.path), 'utf-8');
			}),
		);
		return roles;
	} finally {
		await rm(tmpExtractDir, { recursive: true, force: true });
	}
}

export async function loadFilesystemAgentRoles(agentsDir: string): Promise<Record<string, string>> {
	const { readdir, readFile } = await import('node:fs/promises');
	const { join } = await import('node:path');
	const files = (await readdir(agentsDir)).filter((f) => f.endsWith('.md')).sort();
	const roles: Record<string, string> = {};
	await Promise.all(
		files.map(async (file) => {
			roles[file] = await readFile(join(agentsDir, file), 'utf-8');
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
			'.dev',
			'agents',
		);
		return await loadFilesystemAgentRoles(agentsDir);
	}
}

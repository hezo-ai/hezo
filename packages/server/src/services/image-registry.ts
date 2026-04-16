import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

interface LocalImageSpec {
	dockerfile: string;
	context: string;
}

const LOCAL_IMAGES: Record<string, LocalImageSpec> = {
	'hezo/agent-base:latest': {
		dockerfile: 'docker/Dockerfile.agent-base',
		context: 'docker',
	},
};

export interface ResolvedLocalImage {
	image: string;
	dockerfile: string;
	context: string;
}

export function findRepoRoot(startDir?: string): string | null {
	let dir = startDir ?? dirname(fileURLToPath(import.meta.url));
	while (true) {
		const pkgPath = join(dir, 'package.json');
		if (existsSync(pkgPath)) {
			try {
				const pkg = JSON.parse(readFileSync(pkgPath, 'utf8')) as { workspaces?: unknown };
				if (pkg.workspaces) return dir;
			} catch {
				// Unreadable package.json — keep walking
			}
		}
		const parent = dirname(dir);
		if (parent === dir) return null;
		dir = parent;
	}
}

export function resolveLocalImage(image: string): ResolvedLocalImage | null {
	const spec = LOCAL_IMAGES[image];
	if (!spec) return null;

	const root = findRepoRoot();
	if (!root) return null;

	const dockerfile = isAbsolute(spec.dockerfile) ? spec.dockerfile : resolve(root, spec.dockerfile);
	const context = isAbsolute(spec.context) ? spec.context : resolve(root, spec.context);

	if (!existsSync(dockerfile) || !existsSync(context)) return null;

	return { image, dockerfile, context };
}

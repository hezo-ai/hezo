/**
 * Embedded agent-base Docker build context for the compiled binary.
 *
 * `scripts/bundle-docker.ts` generates `docker-bundle.json` (a `{ relPath: b64 }`
 * map of the repo's `docker/` dir). A *literal* dynamic import lets
 * `bun build --compile` embed it into the binary's virtual FS. A compiled binary
 * has no repo checkout, so the agent-base image can neither be pulled (it is
 * published to no registry) nor built straight from disk — at startup we extract
 * this bundle to the data dir and point the image resolver at it so the image
 * builds locally. In dev (`bun run`) the bundle is absent, the import rejects,
 * and callers fall back to building from the repo's `docker/` dir.
 */

import { mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { logger } from '../logger';

const log = logger.child('docker-assets');

/** Subdirectory under the data dir where the embedded context is extracted. */
export const AGENT_BASE_CONTEXT_DIR = 'agent-base-context';

let cache: Record<string, string> | null | undefined;

/**
 * The embedded Docker build context, or `null` in dev/tests (bundle not
 * generated). The map is keyed by repo-relative path (`docker/...`) with
 * base64-encoded file bytes.
 */
export async function loadDockerBundle(): Promise<Record<string, string> | null> {
	if (cache !== undefined) return cache;
	let mod: { default: Record<string, string> };
	try {
		mod = (await import('../docker-bundle.json')) as { default: Record<string, string> };
	} catch {
		cache = null;
		return null;
	}
	// An empty stub (written by `scripts/ensure-bundles.ts` so tsc/vite can
	// resolve the literal import) means the bundle was never generated — treat it
	// as absent so callers fall back to the repo's `docker/` dir.
	if (Object.keys(mod.default).length === 0) {
		cache = null;
		return null;
	}
	cache = mod.default;
	return cache;
}

/**
 * Write a docker-context bundle map under `<dataDir>/<AGENT_BASE_CONTEXT_DIR>`,
 * reproducing its `docker/...` layout, and return the base dir the keys are
 * relative to (so `resolveLocalImage` resolves `docker/Dockerfile.agent-base`
 * under it). Files are written verbatim; the agent-base Dockerfile chmods its
 * own scripts, so host-side exec bits don't matter.
 */
export async function extractDockerContext(
	dataDir: string,
	bundle: Record<string, string>,
): Promise<string> {
	const root = join(dataDir, AGENT_BASE_CONTEXT_DIR);
	for (const [relPath, b64] of Object.entries(bundle)) {
		const dest = join(root, relPath);
		await mkdir(dirname(dest), { recursive: true });
		await writeFile(dest, Buffer.from(b64, 'base64'));
	}
	return root;
}

/**
 * Extract the embedded agent-base build context to the data dir and return the
 * base dir to resolve it from, or `null` when no bundle is embedded (dev/source
 * — the caller then builds from the repo's `docker/` dir).
 */
export async function extractBundledDockerContext(dataDir: string): Promise<string | null> {
	const bundle = await loadDockerBundle();
	if (!bundle) return null;
	const root = await extractDockerContext(dataDir, bundle);
	log.info(`Extracted embedded agent-base build context to ${root}`);
	return root;
}

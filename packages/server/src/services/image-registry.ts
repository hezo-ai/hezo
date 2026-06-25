import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, statSync } from 'node:fs';
import { dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { logger } from '../logger';
import { IS_PACKAGED_BUILD } from '../version';
import type { DockerClient } from './docker';

const log = logger.child('image-registry');

interface LocalImageSpec {
	dockerfile: string;
	context: string;
}

/**
 * The DB sentinel / default `projects.docker_base_image`. At provision time
 * `resolveAgentBaseImage` maps it to either the published GHCR image (in a
 * release binary) or a local build of `AGENT_BASE_SPEC`.
 */
export const MANAGED_AGENT_BASE_IMAGE = 'hezo/agent-base:latest';

/**
 * Registry repo the agent-base image is published to by
 * `.github/workflows/release-publish.yml` (each release pushes both
 * `<repo>:<version>` and `<repo>:latest`). The server pulls `<repo>:latest`
 * anonymously, so the GHCR package must be public.
 */
export const AGENT_BASE_GHCR_REPO = 'ghcr.io/hezo-ai/agent-base';

/**
 * Build spec (Dockerfile + context, relative to the repo root or the extracted
 * bundle dir) for the agent-base image — used for the dev/local build and as the
 * fallback when pulling the published image fails.
 */
const AGENT_BASE_SPEC: LocalImageSpec = {
	dockerfile: 'docker/Dockerfile.agent-base',
	context: 'docker',
};

const LOCAL_IMAGES: Record<string, LocalImageSpec> = {
	[MANAGED_AGENT_BASE_IMAGE]: AGENT_BASE_SPEC,
};

/**
 * The published agent-base ref to fetch, or `null` when none should exist. Only a
 * compiled release binary (`IS_PACKAGED_BUILD`) uses the published image; dev
 * (`bun run`) and tests build from the working-tree Dockerfile so edits take
 * effect immediately. We fetch the floating `:latest` tag (not the binary's exact
 * version) so a host always runs the newest published agent-base — `startup.ts`
 * refreshes it each boot since Docker otherwise caches `:latest` by name. The
 * `packaged` param defaults to the module constant but is injectable so the logic
 * is unit-testable without env munging.
 */
export function publishedAgentBaseRef(packaged: boolean = IS_PACKAGED_BUILD): string | null {
	return packaged ? `${AGENT_BASE_GHCR_REPO}:latest` : null;
}

/**
 * Resolve a project's stored `docker_base_image` to the image to actually
 * pull/build and run a container from. For the managed default in a release
 * binary, prefer the published GHCR image (pull, with a local-build fallback);
 * custom per-project images are returned untouched and never pulled-as-managed.
 */
export function resolveAgentBaseImage(
	storedImage: string,
	publishedRef: string | null = publishedAgentBaseRef(),
): { image: string; preferPull: boolean } {
	if (storedImage === MANAGED_AGENT_BASE_IMAGE && publishedRef) {
		return { image: publishedRef, preferPull: true };
	}
	return { image: storedImage, preferPull: false };
}

/**
 * Pull the published agent-base image so a long-running install picks up a newer
 * release's `:latest` — Docker caches `:latest` by name, so an already-pulled tag
 * is never refreshed on its own. Called once at startup; best-effort, so a failure
 * is non-fatal (provisioning falls back to the cached image or a local build).
 * No-op returning `null` when there's no published ref (dev/tests). The `ref` param
 * is injectable for tests.
 */
export async function refreshPublishedAgentBaseImage(
	docker: DockerClient,
	ref: string | null = publishedAgentBaseRef(),
): Promise<string | null> {
	if (!ref) return null;
	await docker.pullImage(ref);
	return ref;
}

/**
 * Label key stamped onto every locally-built bundled image. The value is the
 * deterministic hash of the Dockerfile + every file under the build context.
 * `pruneStaleBundledImages` compares this label against the current on-disk
 * hash so a server restart picks up Dockerfile or script edits without
 * requiring users to manually `docker rmi`.
 */
export const BUNDLE_SHA_LABEL = 'hezo.bundle.sha';

export interface ResolvedLocalImage {
	image: string;
	dockerfile: string;
	context: string;
	bundleSourceHash: string;
}

/**
 * Base dir the `LOCAL_IMAGES` paths resolve against when set. The compiled
 * binary has no repo checkout, so `findRepoRoot` finds nothing and the
 * agent-base image could neither be pulled (published to no registry) nor built.
 * At startup the binary extracts the embedded `docker/` context to the data dir
 * and points us at it here, so `resolveLocalImage` finds the Dockerfile and the
 * image builds locally. Unset (`null`) in dev/source, where `findRepoRoot` walks
 * to the repo's `docker/` dir.
 */
let dockerBaseDirOverride: string | null = null;

/** Override (or, with `null`, clear) the base dir `resolveLocalImage` resolves
 *  the bundled Dockerfile/context against. Set once at startup in the compiled
 *  binary after the embedded context is extracted to the data dir. */
export function setDockerBaseDir(dir: string | null): void {
	dockerBaseDirOverride = dir;
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

export function resolveLocalImage(
	image: string,
	publishedRef: string | null = publishedAgentBaseRef(),
): ResolvedLocalImage | null {
	// The managed sentinel maps to the bundled spec directly; the published GHCR
	// ref for this build maps to the same spec so a failed pull can fall back to a
	// local build of the identical Dockerfile/context. The published ref is
	// deliberately not in LOCAL_IMAGES so `pruneStaleBundledImages` never removes a
	// pulled (label-less) image — version-in-tag handles staleness across upgrades.
	const spec = LOCAL_IMAGES[image] ?? (image === publishedRef ? AGENT_BASE_SPEC : undefined);
	if (!spec) return null;

	const root = dockerBaseDirOverride ?? findRepoRoot();
	if (!root) return null;

	const dockerfile = isAbsolute(spec.dockerfile) ? spec.dockerfile : resolve(root, spec.dockerfile);
	const context = isAbsolute(spec.context) ? spec.context : resolve(root, spec.context);

	if (!existsSync(dockerfile) || !existsSync(context)) return null;

	const bundleSourceHash = computeBundleSourceHash(dockerfile, context);

	return { image, dockerfile, context, bundleSourceHash };
}

/**
 * Stable SHA-256 over the Dockerfile contents and every file under the build
 * context, walked in lexicographic order. Each file contributes a block of
 * `<relative-path>\0<sha256-of-bytes>\0` to the outer digest so renames,
 * additions, and content edits all change the result.
 */
export function computeBundleSourceHash(dockerfilePath: string, contextPath: string): string {
	const outer = createHash('sha256');
	outer.update('dockerfile\0');
	outer.update(hashFile(dockerfilePath));
	outer.update('\0context\0');
	for (const entry of walkContextFiles(contextPath)) {
		outer.update(entry.relPath);
		outer.update('\0');
		outer.update(hashFile(entry.absPath));
		outer.update('\0');
	}
	return outer.digest('hex');
}

interface ContextFile {
	absPath: string;
	relPath: string;
}

function walkContextFiles(root: string): ContextFile[] {
	const results: ContextFile[] = [];
	const stack: string[] = [root];
	while (stack.length > 0) {
		const dir = stack.pop();
		if (!dir) continue;
		for (const name of readdirSync(dir).sort()) {
			const abs = join(dir, name);
			const st = statSync(abs);
			if (st.isDirectory()) {
				stack.push(abs);
			} else if (st.isFile()) {
				results.push({ absPath: abs, relPath: relative(root, abs).split(sep).join('/') });
			}
		}
	}
	results.sort((a, b) => (a.relPath < b.relPath ? -1 : a.relPath > b.relPath ? 1 : 0));
	return results;
}

function hashFile(path: string): string {
	return createHash('sha256').update(readFileSync(path)).digest('hex');
}

export interface PruneOutcome {
	kept: string[];
	removed: string[];
	skipped: Array<{ image: string; reason: string }>;
}

/**
 * Remove any locally-built bundled images whose `hezo.bundle.sha` label is
 * missing or doesn't match the current on-disk source hash. Called on server
 * startup so Dockerfile/script edits propagate automatically — the next
 * `ensureImage` call rebuilds from the current sources.
 *
 * Removal is forced. Running containers still referencing the image keep
 * their layers alive via Docker's reference counting; only the tag is moved
 * to the rebuilt image.
 */
export async function pruneStaleBundledImages(docker: DockerClient): Promise<PruneOutcome> {
	const outcome: PruneOutcome = { kept: [], removed: [], skipped: [] };
	for (const image of Object.keys(LOCAL_IMAGES)) {
		const resolved = resolveLocalImage(image);
		if (!resolved) {
			outcome.skipped.push({ image, reason: 'source not found on disk' });
			continue;
		}
		let info: Awaited<ReturnType<DockerClient['inspectImage']>>;
		try {
			info = await docker.inspectImage(image);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			outcome.skipped.push({ image, reason: `inspect failed: ${msg}` });
			log.warn(`pruneStaleBundledImages: inspect ${image} failed: ${msg}`);
			continue;
		}
		if (!info) continue;
		const installedHash = info.Config?.Labels?.[BUNDLE_SHA_LABEL];
		if (installedHash === resolved.bundleSourceHash) {
			outcome.kept.push(image);
			continue;
		}
		try {
			await docker.removeImage(image, true);
			outcome.removed.push(image);
			log.info(
				`pruneStaleBundledImages: removed ${image} (label ${installedHash ?? 'missing'} → source ${resolved.bundleSourceHash.slice(0, 12)})`,
			);
		} catch (err) {
			const msg = err instanceof Error ? err.message : String(err);
			outcome.skipped.push({ image, reason: `remove failed: ${msg}` });
			log.warn(`pruneStaleBundledImages: remove ${image} failed: ${msg}`);
		}
	}
	return outcome;
}

import { logger } from '../logger';
import type { ContainerEngine } from './docker';
import { getSharedImageBuildTracker, type ImageBuildTracker } from './image-build-tracker';
import { type BuildOnLine, type BuildOptions, buildImageViaCli } from './image-builder';
import { BUNDLE_SHA_LABEL, type ResolvedLocalImage, resolveLocalImage } from './image-registry';

const log = logger.child('ensure-image');

export interface EnsureImageDeps {
	resolveLocal?: (image: string) => ResolvedLocalImage | null;
	build?: (
		image: string,
		contextPath: string,
		dockerfilePath: string,
		options?: BuildOptions,
	) => Promise<void>;
	onLine?: BuildOnLine;
	/** Receives build start/progress/finish; defaults to the process singleton. */
	tracker?: ImageBuildTracker | null;
	/**
	 * When true, pull `image` first and only build locally if the pull fails.
	 * Set for the managed agent-base image published per release (the version-
	 * pinned GHCR ref). For any other image a pull failure stays terminal.
	 */
	preferPull?: boolean;
}

interface InFlightBuild {
	promise: Promise<void>;
	listeners: Set<BuildOnLine>;
}

/**
 * Tracks builds currently in progress, keyed by image tag. Concurrent
 * `ensureImage` calls for the same tag share one build instead of each spawning
 * `docker build` — a second build of identical content fails on export against
 * Docker's containerd image store with `image "…": already exists`.
 */
const inFlightBuilds = new Map<string, InFlightBuild>();

export async function ensureImage(
	docker: ContainerEngine,
	image: string,
	deps: EnsureImageDeps = {},
): Promise<void> {
	if (await docker.imageExists(image)) return;

	const resolver = deps.resolveLocal ?? resolveLocalImage;
	const local = resolver(image);

	// Managed agent-base in a release binary: prefer the image published for this
	// version, falling back to a local build when the pull fails (not published
	// yet, offline, private fork). Only swallow the pull error when a local spec
	// lets us rebuild; otherwise a failed pull stays terminal.
	if (deps.preferPull) {
		try {
			await docker.pullImage(image);
			return;
		} catch (err) {
			if (!local) throw err;
			const msg = err instanceof Error ? err.message : String(err);
			log.warn(`Pull of ${image} failed; building agent-base locally: ${msg}`);
		}
	}

	if (local) {
		await buildLocalImageOnce(docker, local, deps);
		return;
	}

	await docker.pullImage(image);
}

/**
 * Runs at most one build per image tag at a time. The first caller spawns the
 * build; concurrent callers attach their `onLine` listener and await the shared
 * promise. The build's output fans out to every attached listener so each
 * provision stream still sees the trace.
 */
async function buildLocalImageOnce(
	docker: ContainerEngine,
	local: ResolvedLocalImage,
	deps: EnsureImageDeps,
): Promise<void> {
	const existing = inFlightBuilds.get(local.image);
	if (existing) {
		if (deps.onLine) existing.listeners.add(deps.onLine);
		await existing.promise;
		return;
	}

	const tracker = deps.tracker !== undefined ? deps.tracker : getSharedImageBuildTracker();
	const listeners = new Set<BuildOnLine>();
	if (deps.onLine) listeners.add(deps.onLine);
	const fanout: BuildOnLine = (stream, text) => {
		tracker?.observe(local.image, text);
		for (const listener of listeners) listener(stream, text);
	};

	const builder = deps.build ?? buildImageViaCli;
	const entry: InFlightBuild = {
		listeners,
		promise: (async () => {
			tracker?.start(local.image);
			try {
				await builder(local.image, local.context, local.dockerfile, {
					onLine: fanout,
					labels: { [BUNDLE_SHA_LABEL]: local.bundleSourceHash },
				});
				tracker?.finish(local.image);
			} catch (err) {
				// A build can report failure while the image is actually present —
				// e.g. a racing build already exported identical content under the
				// same tag and Docker's containerd image store rejects the duplicate.
				// The image exists, so the ensure contract is satisfied.
				if (await docker.imageExists(local.image)) {
					const msg = err instanceof Error ? err.message : String(err);
					log.warn(
						`Build of ${local.image} reported failure but image is present; treating as success: ${msg}`,
					);
					tracker?.finish(local.image);
					return;
				}
				tracker?.fail(local.image, err instanceof Error ? err.message : String(err));
				throw err;
			} finally {
				inFlightBuilds.delete(local.image);
			}
		})(),
	};
	inFlightBuilds.set(local.image, entry);
	await entry.promise;
}

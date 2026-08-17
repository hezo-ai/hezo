import { isSandboxBackend, SANDBOX_BACKENDS, SandboxBackend } from '@hezo/shared';
import { redactSandboxApiUrl, type SandboxBackendInfo } from '../../lib/sandbox-backend-info';
import { logger } from '../../logger';
import { DockerClient } from '../docker';
import {
	type DockerPreflightResult,
	evaluateDockerPreflight,
	formatDockerPreflightMessage,
} from '../docker-preflight';
import { describeDockerSocket } from '../docker-socket';
import { DaytonaClient, DEFAULT_DAYTONA_API_URL } from './daytona/client';
import { DaytonaEngine } from './daytona/engine';
import { DockerNotInstalledError, SandboxBackendError } from './errors';
import type { ContainerEngine } from './types';

const log = logger.child('sandbox-backend');

/** Preflight retry backoff - a briefly-restarting endpoint shouldn't kill startup. */
const CONNECT_RETRY_DELAYS_MS = [2000, 4000];

/**
 * How an operator actually gets out of a bad credential, on either surface this
 * error reaches - the boot log and the Containers switch dialog.
 *
 * It used to end "drop --sandbox-backend / HEZO_SANDBOX_BACKEND to run
 * containers on local Docker", which is **false**: the backend is a stored
 * setting that the flag only seeds, so removing the flag changes nothing on an
 * instance that has already chosen a provider. Following it leaves the operator
 * with the same failure and the belief that they are now on Docker.
 */
const KEY_RECOVERY_HINT =
	'Supply a working key with --daytona-api-key / HEZO_DAYTONA_API_KEY, or set one from ' +
	'Settings -> Containers. The key is used for this startup and saved once the instance ' +
	'is unlocked.';

export interface OpenSandboxBackendOptions {
	/** `docker` (default) or a managed provider. */
	backend?: string;
	daytonaApiKey?: string;
	daytonaApiUrl?: string;
	/** `--docker-socket` / `HEZO_DOCKER_SOCKET`, when the operator pinned one. */
	dockerSocket?: string;
	/** Test hook: overrides the preflight retry backoff. */
	retryDelaysMs?: number[];
}

export interface OpenedSandboxBackend {
	engine: ContainerEngine;
	/** Pre-redacted metadata, safe to expose to the settings endpoint. */
	info: SandboxBackendInfo;
}

/**
 * Select and open the container engine - the single place one is constructed at
 * startup, mirroring `openDatabase` and `openAssetStorage`. Application code
 * depends only on `ContainerEngine`; the API key stops here, redacted into
 * `info` before anything else sees it.
 *
 * The contract those two already establish, and which this follows exactly:
 * no configuration means the local default, configuration present means the
 * managed driver plus a preflight, and a preflight that keeps failing is
 * **fatal**. There is deliberately no fallback to Docker - see
 * `SandboxBackendError`.
 */
export async function openSandboxBackend(
	options: OpenSandboxBackendOptions = {},
): Promise<OpenedSandboxBackend> {
	const name = resolveBackendName(options.backend);

	if (name === SandboxBackend.Docker) {
		// Docker is pinged here, with the same retry shape as Daytona, and this is
		// the **only** place it is pinged.
		//
		// There used to be a second gate at the top of `index.ts`, before the
		// database was even open. It could therefore only read the *launch flag*,
		// while the backend actually in use comes from the stored setting - so an
		// instance switched to Daytona from the Containers page and then restarted
		// on a host without Docker exited 1, printing Docker install guidance for a
		// backend it was never going to use. It also could not serve the other call
		// site: a **runtime switch** happens long after boot, and deferring to a
		// boot-time verdict meant switching back to Docker returned an unpinged
		// client. `switchSandboxBackend` destroys every container before swapping,
		// so the operator lost the fleet and gained a backend that could not be
		// reached - precisely what its ordering exists to prevent.
		//
		// This is also where the **socket** is resolved. Hezo supports any
		// Docker-API-compatible runtime (Colima, Rancher Desktop, OrbStack, Lima,
		// rootless), so the daemon has to be *found* rather than assumed at
		// `/var/run/docker.sock` - and the winner recorded before any `DockerClient`
		// is handed out, since every one of them reads it. Doing that here rather
		// than at the top of `index.ts` is what stops it firing on an instance that
		// runs on a managed backend and has no local daemon at all.
		const resolved = await dockerPreflightWithRetry(options);
		if (resolved.socket) log.info(describeDockerSocket(resolved.socket));
		const engine = new DockerClient();
		const info = { backend: SandboxBackend.Docker, display: 'local Docker daemon' } as const;
		return { engine, info };
	}

	const apiUrl = options.daytonaApiUrl || DEFAULT_DAYTONA_API_URL;
	const redacted = redactSandboxApiUrl(apiUrl);
	if (!options.daytonaApiKey) {
		// Caught before any network call: a missing key is a configuration
		// mistake, and reporting it as an unreachable API would send the operator
		// looking at the wrong thing.
		throw new SandboxBackendError(
			`The Daytona sandbox backend is selected but no API key is configured.\n${KEY_RECOVERY_HINT}`,
		);
	}

	const client = new DaytonaClient(options.daytonaApiKey, apiUrl);
	await preflight(
		client,
		options.retryDelaysMs,
		() =>
			`Cannot reach the configured Daytona API at ${redacted}.\n` +
			'Check that the API key is valid and not expired, that it carries the sandbox ' +
			'permission scopes, and that --daytona-api-url / HEZO_DAYTONA_API_URL points at the ' +
			`right region.\n${KEY_RECOVERY_HINT}`,
		'Daytona',
	);

	log.info(`Sandbox backend: Daytona (${redacted})`);
	return {
		engine: new DaytonaEngine(client),
		info: { backend: SandboxBackend.Daytona, display: redacted },
	};
}

/**
 * Find a reachable daemon, with the same bounded backoff every other backend
 * gets, and record the socket that answered.
 *
 * `evaluateDockerPreflight` already walks the candidates in the right order
 * (operator override, `DOCKER_HOST`, the docker CLI's context, then each
 * supported runtime's well-known path) and calls `setResolvedDockerSocket` for
 * the winner - so this only adds the retry, which exists because a daemon that
 * is *starting* is the common case at boot and one that never answers is not
 * distinguishable from it on a single pass.
 *
 * The failure message is the preflight's own - which sockets were tried, and the
 * start command for each runtime it recognised - plus the one thing it cannot
 * know: that a managed backend is an alternative to having a local daemon at all.
 */
async function dockerPreflightWithRetry(
	options: OpenSandboxBackendOptions,
): Promise<DockerPreflightResult> {
	const delays = options.retryDelaysMs ?? CONNECT_RETRY_DELAYS_MS;
	for (let attempt = 0; ; attempt++) {
		const result = await evaluateDockerPreflight({ override: options.dockerSocket });
		if (result.status === 'ok') return result;
		// An endpoint Hezo structurally cannot speak (tcp://, npipe://, ssh://) will
		// not become speakable by waiting, so that one fails on the first pass.
		if (attempt < delays.length && result.status !== 'unsupported-docker-host') {
			log.warn(
				`Docker preflight failed (attempt ${attempt + 1}/${delays.length + 1}), retrying in ${delays[attempt]}ms...`,
			);
			await new Promise((resolve) => setTimeout(resolve, delays[attempt]));
			continue;
		}
		const message =
			`${formatDockerPreflightMessage({ ...result, status: result.status })}\n\n` +
			'Alternatively, set --sandbox-backend / HEZO_SANDBOX_BACKEND to run containers ' +
			'on a managed sandbox service instead of a local daemon.';
		// Same message either way; the narrower type only tells the fatal-exit path
		// that this is the one failure the operator may never get to read.
		throw result.status === 'not-installed'
			? new DockerNotInstalledError(message)
			: new SandboxBackendError(message);
	}
}

/**
 * Ping until it answers, with bounded backoff, then throw a named, actionable
 * error. One definition so "this backend is usable" means the same thing for
 * every backend and at every call site (boot, a runtime switch, and uninstall).
 */
async function preflight(
	engine: { ping(): Promise<boolean> },
	retryDelaysMs: number[] | undefined,
	message: () => string,
	label = 'Docker',
): Promise<void> {
	const delays = retryDelaysMs ?? CONNECT_RETRY_DELAYS_MS;
	for (let attempt = 0; ; attempt++) {
		if (await engine.ping().catch(() => false)) return;
		if (attempt < delays.length) {
			log.warn(
				`${label} preflight failed (attempt ${attempt + 1}/${delays.length + 1}), retrying in ${delays[attempt]}ms...`,
			);
			await new Promise((resolve) => setTimeout(resolve, delays[attempt]));
			continue;
		}
		throw new SandboxBackendError(message());
	}
}

function resolveBackendName(raw?: string): SandboxBackend {
	if (!raw) return SandboxBackend.Docker;
	const value = raw.trim().toLowerCase();
	if (!isSandboxBackend(value)) {
		throw new SandboxBackendError(
			`Unknown sandbox backend "${raw}".\n` +
				`Set --sandbox-backend / HEZO_SANDBOX_BACKEND to one of: ${SANDBOX_BACKENDS.join(', ')}.`,
		);
	}
	return value;
}

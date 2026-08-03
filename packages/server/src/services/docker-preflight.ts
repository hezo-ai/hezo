import { existsSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { DockerClient } from './docker';
import {
	type DockerSocketCandidate,
	dockerSocketCandidates,
	setResolvedDockerSocket,
	tildePath,
} from './docker-socket';

/**
 * Canonical Docker install page, shown to operators when no runtime is found.
 * Covers Docker Engine (Linux), Docker Desktop (macOS/Windows), and the
 * post-install steps for starting the daemon.
 */
export const DOCKER_INSTALL_URL = 'https://docs.docker.com/get-docker/';

/** Where the supported-runtime list and socket-discovery order are documented. */
export const CONTAINER_RUNTIMES_DOCS_URL = 'https://hezo.ai/docs/deployment/container-runtimes';

/**
 * Outcome of the startup Docker check:
 * - `ok`                      — a daemon answered a ping; Hezo can run agents.
 * - `not-installed`           — no `docker` executable on PATH and no socket answered.
 * - `not-running`             — a runtime looks installed but no socket answered.
 * - `unsupported-docker-host` — an explicit endpoint named a transport Hezo can't speak.
 */
export type DockerAvailability = 'ok' | 'not-installed' | 'not-running' | 'unsupported-docker-host';

export interface DockerPreflightProbes {
	/** Resolves true when the Docker daemon answers a ping over its socket. */
	ping: () => Promise<boolean>;
	/** Resolves true when a `docker` executable is present on PATH. */
	binaryInstalled: () => boolean | Promise<boolean>;
}

/**
 * Decide Docker availability from two independent probes. The daemon ping is
 * the authoritative "can Hezo actually use Docker" signal; the binary probe
 * only disambiguates *why* a failed ping happened so we can show the right
 * guidance ("install it" vs "start it"). It is never used as a gate on its own.
 */
export async function checkDockerAvailability(
	probes: DockerPreflightProbes,
): Promise<DockerAvailability> {
	if (await probes.ping()) return 'ok';
	return (await probes.binaryInstalled()) ? 'not-running' : 'not-installed';
}

/**
 * Manual PATH scan for a `docker` executable. Used as the fallback when
 * `Bun.which` is unavailable (i.e. under Node/vitest). Pure and deterministic
 * given an `env`, so the preflight decision stays testable off the Bun runtime.
 */
export function dockerBinaryOnPath(env: NodeJS.ProcessEnv = process.env): boolean {
	const candidates = process.platform === 'win32' ? ['docker.exe', 'docker'] : ['docker'];
	const dirs = (env.PATH ?? '').split(delimiter).filter(Boolean);
	return dirs.some((dir) => candidates.some((name) => existsSync(join(dir, name))));
}

/**
 * Whether a `docker` executable is installed. Prefers Bun's native PATH
 * resolver in production; falls back to a manual scan under Node.
 */
export function dockerBinaryInstalled(env: NodeJS.ProcessEnv = process.env): boolean {
	const bunWhich = (globalThis as { Bun?: { which?: (cmd: string) => string | null } }).Bun?.which;
	if (typeof bunWhich === 'function') return bunWhich('docker') !== null;
	return dockerBinaryOnPath(env);
}

/**
 * Per-candidate ping ceiling. Deliberately much tighter than the client's
 * 10s default: a dead socket path fails immediately, a live one answers in
 * milliseconds, and we may walk several candidates before giving up — so the
 * failure path stays fast instead of multiplying a long timeout.
 */
const CANDIDATE_PING_TIMEOUT_MS = 2_000;

export interface DockerPreflightResult {
	status: DockerAvailability;
	/** The candidate that answered, when `status` is `ok`. */
	socket?: DockerSocketCandidate;
	/** Every socket that was probed, in order — printed in the failure guidance. */
	tried: DockerSocketCandidate[];
	/** Set when `status` is `unsupported-docker-host`. */
	unsupported?: { scheme: string; source: 'flag' | 'docker-host'; value: string };
}

export interface DockerPreflightOptions {
	/** `--docker-socket` / `HEZO_DOCKER_SOCKET`. */
	override?: string;
	env?: NodeJS.ProcessEnv;
	/** Injectable for tests; defaults to a real ping over the candidate's socket. */
	ping?: (socketPath: string) => Promise<boolean>;
	home?: string;
}

function pingSocket(socketPath: string): Promise<boolean> {
	return new DockerClient(socketPath).ping(CANDIDATE_PING_TIMEOUT_MS);
}

/**
 * Find a reachable Docker daemon and report availability. Walks the resolved
 * candidate list (operator override → `DOCKER_HOST` → docker context → the
 * well-known path for each supported runtime) and takes the first socket that
 * answers, recording it so every `DockerClient` uses it. Callers gate startup on
 * an `ok` result.
 */
export async function evaluateDockerPreflight(
	opts: DockerPreflightOptions = {},
): Promise<DockerPreflightResult> {
	const env = opts.env ?? process.env;
	const { candidates, unsupported } = dockerSocketCandidates({
		override: opts.override,
		env,
		home: opts.home,
	});
	if (unsupported) return { status: 'unsupported-docker-host', tried: [], unsupported };

	const ping = opts.ping ?? pingSocket;
	for (const candidate of candidates) {
		if (await ping(candidate.path)) {
			setResolvedDockerSocket(candidate);
			return { status: 'ok', socket: candidate, tried: candidates };
		}
	}

	// Nothing answered. The binary probe only decides which guidance to print.
	const status = await checkDockerAvailability({
		ping: async () => false,
		binaryInstalled: () => dockerBinaryInstalled(env),
	});
	return { status, tried: candidates };
}

/**
 * Why a container runtime is mandatory, shared by every failure message: the
 * container is a security sandbox, not just a packaging convenience. Agents run
 * untrusted-ish code, so isolating them from the host is the whole point.
 */
const SANDBOX_RATIONALE = [
	"Hezo runs each project's AI agents inside isolated OS containers. That",
	'sandbox is a security boundary: it keeps agents off your host so a buggy or',
	"compromised agent can't reach your files, credentials, or wider network.",
];

/** How to start each supported runtime, printed when nothing answered. */
const START_INSTRUCTIONS = [
	'  Docker Desktop   open the app',
	'  Colima           colima start',
	'  Rancher Desktop  open the app',
	'  OrbStack         open the app',
	'  Linux (systemd)  sudo systemctl start docker',
];

// Worded to read correctly whether or not any sockets were listed above it.
const OVERRIDE_HINT = [
	'Daemon listening on a socket Hezo did not check? Point it there:',
	'',
	'  hezo --docker-socket /path/to/docker.sock   (env: HEZO_DOCKER_SOCKET)',
];

/**
 * What Hezo probed. An empty list is its own diagnosis and must not render as
 * silence: it means no runtime had put a socket anywhere we look, which reads
 * very differently from "your socket is there but dead".
 */
function triedBlock(tried: DockerSocketCandidate[], home?: string): string[] {
	if (tried.length === 0) {
		return ['No container-runtime socket was found in any of the usual locations.', ''];
	}
	return ['Sockets tried:', ...tried.map((c) => `  ${tildePath(c.path, home)}`), ''];
}

/**
 * Human-facing guidance for a non-`ok` preflight result, printed to the log
 * right before the server exits. Every variant explains *why* a container
 * runtime is required (host isolation / security), then gives the relevant next
 * step: the install link when nothing is installed, per-runtime start commands
 * plus the sockets we probed when nothing answered, and the override when an
 * explicit endpoint used a transport we can't speak.
 *
 * Never mention HEZO_SKIP_DOCKER here — it's a test-only escape hatch (swaps in
 * the in-process fake docker) and must not be surfaced to users (see AGENTS.md).
 * Hyphens only, never em/en dashes (user-facing prose rule).
 */
export function formatDockerPreflightMessage(
	result: Pick<DockerPreflightResult, 'status' | 'tried' | 'unsupported'> & {
		status: Exclude<DockerAvailability, 'ok'>;
	},
	home?: string,
): string {
	if (result.status === 'not-installed') {
		return [
			'A Docker-compatible container runtime is required to run Hezo, but none appears',
			'to be installed.',
			'',
			...SANDBOX_RATIONALE,
			'',
			'Install a Docker-compatible runtime (Docker, Colima, Rancher Desktop, OrbStack,',
			'Lima), then start Hezo again:',
			'',
			`  ${DOCKER_INSTALL_URL}`,
			'',
			`Supported runtimes: ${CONTAINER_RUNTIMES_DOCS_URL}`,
		].join('\n');
	}

	if (result.status === 'unsupported-docker-host') {
		const flag = result.unsupported?.source === 'flag' ? '--docker-socket' : 'DOCKER_HOST';
		const scheme = result.unsupported?.scheme ?? 'unknown';
		return [
			`${flag} is set to a ${scheme}:// endpoint, which Hezo cannot use.`,
			'',
			...SANDBOX_RATIONALE,
			'',
			'Hezo talks to the daemon over a Unix socket, so tcp://, npipe:// and ssh://',
			'endpoints are not supported. Point it at the socket file instead:',
			'',
			'  hezo --docker-socket /path/to/docker.sock   (env: HEZO_DOCKER_SOCKET)',
			'',
			`More detail: ${CONTAINER_RUNTIMES_DOCS_URL}`,
		].join('\n');
	}

	return [
		'A Docker-compatible runtime is installed, but no daemon answered on any socket',
		'Hezo could find.',
		'',
		...SANDBOX_RATIONALE,
		'',
		'The daemon must be running to provide that isolation. Start your container',
		'runtime, then start Hezo again:',
		'',
		...START_INSTRUCTIONS,
		'',
		...triedBlock(result.tried, home),
		...OVERRIDE_HINT,
		'',
		`Supported runtimes and how Hezo finds them: ${CONTAINER_RUNTIMES_DOCS_URL}`,
	].join('\n');
}

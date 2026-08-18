import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/**
 * The historical default, and still the first thing we look for: native-Linux
 * Docker Engine listens here, and Docker Desktop symlinks it. Kept as the
 * last-resort fallback so a client constructed before resolution behaves
 * exactly as it did before socket discovery existed.
 */
export const DEFAULT_DOCKER_SOCKET = '/var/run/docker.sock';

/** How a candidate socket was arrived at, in precedence order. */
export type DockerSocketSource = 'flag' | 'docker-host' | 'docker-context' | 'discovered';

/**
 * Which Docker-compatible runtime a candidate most likely belongs to. Purely
 * cosmetic — it makes the boot log and the failure guidance name the thing the
 * operator actually installed instead of saying "Docker" at a Colima user.
 */
export type DockerRuntimeHint =
	| 'docker-engine'
	| 'docker-desktop'
	| 'colima'
	| 'rancher-desktop'
	| 'orbstack'
	| 'lima'
	| 'rootless';

/** Human-facing name for each runtime, used in log lines and guidance. */
export const DOCKER_RUNTIME_LABELS: Record<DockerRuntimeHint, string> = {
	'docker-engine': 'Docker Engine',
	'docker-desktop': 'Docker Desktop',
	colima: 'Colima',
	'rancher-desktop': 'Rancher Desktop',
	orbstack: 'OrbStack',
	lima: 'Lima',
	rootless: 'rootless Docker',
};

export interface DockerSocketCandidate {
	/** Absolute filesystem path of the Unix socket. */
	path: string;
	source: DockerSocketSource;
	runtime?: DockerRuntimeHint;
}

/**
 * Parsed form of a `DOCKER_HOST`-style endpoint. Hezo talks to the daemon over a
 * Unix socket only: `DockerClient.request` uses Bun's `fetch({ unix })` and
 * `requestStream` uses `node:http`'s `socketPath`, and both are filesystem-only.
 * A `tcp://`/`npipe://`/`ssh://` endpoint therefore can't be honoured — we report
 * it as unsupported and say so, rather than silently falling back to a default
 * socket and reporting "daemon not reachable" for the wrong reason.
 */
export type ParsedDockerHost =
	| { kind: 'unix'; path: string }
	| { kind: 'unsupported'; scheme: string };

/**
 * Parse a `DOCKER_HOST` / docker-context endpoint. Accepts `unix:///abs/path`,
 * the malformed-but-common `unix://abs/path`, and a bare absolute path. Returns
 * null for an empty value so callers can treat "unset" and "blank" alike.
 */
export function parseDockerHost(value: string | undefined): ParsedDockerHost | null {
	const raw = value?.trim();
	if (!raw) return null;
	if (raw.startsWith('unix://')) {
		// `unix:///var/run/docker.sock` leaves a leading slash; `unix://var/...`
		// (no third slash, seen in hand-written configs) does not — restore it so
		// both spellings resolve to the same absolute path.
		const rest = raw.slice('unix://'.length);
		const path = rest.startsWith('/') ? rest : `/${rest}`;
		return path === '/' ? null : { kind: 'unix', path };
	}
	const scheme = raw.match(/^([a-z][a-z0-9+.-]*):\/\//i)?.[1];
	if (scheme) return { kind: 'unsupported', scheme: scheme.toLowerCase() };
	return raw.startsWith('/')
		? { kind: 'unix', path: raw }
		: { kind: 'unsupported', scheme: 'unknown' };
}

/**
 * Guess the runtime behind a docker context from its name. Context names are
 * set by the runtime's own installer (`colima`, `colima-profile`, `orbstack`,
 * `rancher-desktop`, `desktop-linux`), so this is reliable in practice and
 * costs nothing when it isn't — the hint is only ever used for wording.
 */
export function runtimeHintFromContextName(name: string): DockerRuntimeHint | undefined {
	const n = name.toLowerCase();
	if (n === 'colima' || n.startsWith('colima-')) return 'colima';
	if (n === 'rancher-desktop') return 'rancher-desktop';
	if (n === 'orbstack') return 'orbstack';
	if (n === 'desktop-linux' || n === 'desktop-windows') return 'docker-desktop';
	if (n.startsWith('lima-')) return 'lima';
	return undefined;
}

/** Filesystem reads the resolver needs, injected so it unit-tests without a real FS. */
export interface DockerSocketFs {
	exists: (path: string) => boolean;
	readFile: (path: string) => string | null;
	readDir: (path: string) => string[];
}

export const realDockerSocketFs: DockerSocketFs = {
	exists: (path) => existsSync(path),
	readFile: (path) => {
		try {
			return readFileSync(path, 'utf8');
		} catch {
			return null;
		}
	},
	readDir: (path) => {
		try {
			return readdirSync(path);
		} catch {
			return [];
		}
	},
};

function readJson(fs: DockerSocketFs, path: string): Record<string, unknown> | null {
	const raw = fs.readFile(path);
	if (raw === null) return null;
	try {
		const parsed: unknown = JSON.parse(raw);
		return parsed && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : null;
	} catch {
		return null;
	}
}

export interface DockerSocketLookup {
	env: NodeJS.ProcessEnv;
	home: string;
	fs: DockerSocketFs;
}

/**
 * The docker CLI's *current context* endpoint, read straight from the CLI's own
 * config files rather than by shelling out to `docker context inspect`. Reading
 * the files keeps the resolver pure, testable and free of a subprocess on the
 * startup path, and it works even when the `docker` CLI isn't on PATH.
 *
 * The layout is the docker CLI's context store: `config.json` names the current
 * context (overridden by `DOCKER_CONTEXT`), and each context's metadata lives at
 * `contexts/meta/<sha256(name)>/meta.json`. Anything unexpected returns null and
 * the caller falls through to the well-known paths, so a future layout change
 * degrades to discovery rather than breaking startup.
 */
export function readCurrentDockerContextSocket(
	lookup: DockerSocketLookup,
): DockerSocketCandidate | null {
	const { env, home, fs } = lookup;
	const configDir = env.DOCKER_CONFIG?.trim() || join(home, '.docker');
	const name =
		env.DOCKER_CONTEXT?.trim() ||
		(readJson(fs, join(configDir, 'config.json'))?.currentContext as string | undefined)?.trim();
	// `default` is the CLI's built-in context — it carries no meta.json and means
	// "the standard socket", which the well-known list already covers.
	if (!name || name === 'default') return null;

	const digest = createHash('sha256').update(name).digest('hex');
	const meta = readJson(fs, join(configDir, 'contexts', 'meta', digest, 'meta.json'));
	const endpoints = meta?.Endpoints as Record<string, { Host?: string }> | undefined;
	const parsed = parseDockerHost(endpoints?.docker?.Host);
	if (parsed?.kind !== 'unix') return null;
	return { path: parsed.path, source: 'docker-context', runtime: runtimeHintFromContextName(name) };
}

/**
 * Cap on how many sibling instance/profile directories we expand for the
 * multi-profile runtimes. A `.colima`/`.lima` dir holds one dir per VM; probing
 * every one of an unbounded set would slow the failure path for no benefit.
 */
const MAX_PROFILE_DIRS = 8;

/**
 * Expand `<base>/<profile>/<suffix>` for each profile dir under `base`, with
 * `preferred` first so the common single-VM case probes exactly one path.
 */
function profileSockets(
	fs: DockerSocketFs,
	base: string,
	suffix: string,
	preferred: string,
): string[] {
	const names = fs
		.readDir(base)
		.filter((n) => n !== preferred)
		.sort()
		.slice(0, MAX_PROFILE_DIRS);
	return [preferred, ...names].map((n) => join(base, n, suffix));
}

/**
 * Every socket path a supported runtime is known to use, in probe order. Only
 * paths that exist are returned, so the preflight pings at most a couple of
 * candidates on a real machine.
 *
 * Docker-API-compatible runtimes only (see docs/deployment/container-runtimes).
 * Podman is deliberately absent: its Docker-compat API covers most of what Hezo
 * uses but its exec-streaming and host-gateway behaviour are unverified here, so
 * auto-discovering it would imply support we haven't tested. A Podman user can
 * still point `--docker-socket` at it explicitly.
 */
export function wellKnownDockerSockets(lookup: DockerSocketLookup): DockerSocketCandidate[] {
	const { env, home, fs } = lookup;
	const entries: Array<{ path: string; runtime: DockerRuntimeHint }> = [];
	const add = (path: string, runtime: DockerRuntimeHint) => entries.push({ path, runtime });

	add(DEFAULT_DOCKER_SOCKET, 'docker-engine');
	add(join(home, '.docker', 'run', 'docker.sock'), 'docker-desktop');
	const colimaHome = env.COLIMA_HOME?.trim() || join(home, '.colima');
	for (const p of profileSockets(fs, colimaHome, 'docker.sock', 'default')) add(p, 'colima');
	add(join(home, '.rd', 'docker.sock'), 'rancher-desktop');
	add(join(home, '.orbstack', 'run', 'docker.sock'), 'orbstack');
	for (const p of profileSockets(fs, join(home, '.lima'), join('sock', 'docker.sock'), 'default')) {
		add(p, 'lima');
	}
	const xdg = env.XDG_RUNTIME_DIR?.trim();
	if (xdg) add(join(xdg, 'docker.sock'), 'rootless');

	const seen = new Set<string>();
	const out: DockerSocketCandidate[] = [];
	for (const e of entries) {
		if (seen.has(e.path)) continue;
		seen.add(e.path);
		if (fs.exists(e.path)) out.push({ path: e.path, source: 'discovered', runtime: e.runtime });
	}
	return out;
}

export interface DockerSocketCandidatesOptions {
	/** `--docker-socket` / the config file's `containers.dockerSocket`. Wins over everything else. */
	override?: string;
	env?: NodeJS.ProcessEnv;
	home?: string;
	fs?: DockerSocketFs;
}

export interface DockerSocketCandidatesResult {
	candidates: DockerSocketCandidate[];
	/**
	 * Set when an explicit endpoint (the override or `DOCKER_HOST`) named a
	 * transport Hezo can't speak. The preflight reports this instead of "daemon
	 * not reachable", which would blame the wrong thing.
	 */
	unsupported?: { scheme: string; source: 'flag' | 'docker-host'; value: string };
}

/**
 * Every socket Hezo should try, most-explicit first: the operator's override,
 * then `DOCKER_HOST`, then the docker CLI's current context, then the well-known
 * paths for each supported runtime. An explicit endpoint is authoritative — when
 * one is set we return it alone, so a typo'd override fails loudly rather than
 * silently connecting to some other daemon.
 */
export function dockerSocketCandidates(
	opts: DockerSocketCandidatesOptions = {},
): DockerSocketCandidatesResult {
	const env = opts.env ?? process.env;
	const lookup: DockerSocketLookup = {
		env,
		home: opts.home ?? env.HOME?.trim() ?? homedir(),
		fs: opts.fs ?? realDockerSocketFs,
	};

	const explicit: Array<{ value: string | undefined; source: 'flag' | 'docker-host' }> = [
		{ value: opts.override, source: 'flag' },
		{ value: env.DOCKER_HOST, source: 'docker-host' },
	];
	for (const { value, source } of explicit) {
		const parsed = parseDockerHost(value);
		if (!parsed) continue;
		if (parsed.kind === 'unsupported') {
			return { candidates: [], unsupported: { scheme: parsed.scheme, source, value: value ?? '' } };
		}
		return { candidates: [{ path: parsed.path, source }] };
	}

	const fromContext = readCurrentDockerContextSocket(lookup);
	const wellKnown = wellKnownDockerSockets(lookup);
	if (!fromContext) return { candidates: wellKnown };
	// The context socket goes first, then the well-known paths as a backstop for a
	// stale context pointing at a VM that is no longer running.
	return {
		candidates: [fromContext, ...wellKnown.filter((c) => c.path !== fromContext.path)],
	};
}

/**
 * The socket the preflight actually connected to. Module-level and set once at
 * startup: `DockerClient` reads it lazily per request, so the four production
 * clients (constructed before and after the preflight) all end up on the same
 * socket. Reset only by tests.
 */
let resolved: DockerSocketCandidate | null = null;

/**
 * Memoized static guess for the paths that never run the preflight (`hezo
 * uninstall` builds a `DockerClient` directly). Resolution reads config files
 * and lists directories, and `DockerClient` asks for the socket on **every**
 * request — recomputing it per request would put a `readdir` on the hot path.
 * Invalidated whenever the resolved socket is set or cleared, which is the only
 * thing that can change the answer within a process.
 */
let fallbackGuess: string | null = null;

export function setResolvedDockerSocket(candidate: DockerSocketCandidate | null): void {
	resolved = candidate;
	fallbackGuess = null;
}

export function getResolvedDockerSocket(): DockerSocketCandidate | null {
	return resolved;
}

/**
 * The socket path every `DockerClient` uses when it wasn't given an explicit
 * one. Before the preflight has run (or when it failed) this falls back to the
 * best static guess — the first candidate that exists, else the historical
 * default — so behaviour degrades to what it was rather than to nothing.
 */
export function resolvedDockerSocketPath(): string {
	if (resolved) return resolved.path;
	if (fallbackGuess === null) {
		fallbackGuess = dockerSocketCandidates().candidates[0]?.path ?? DEFAULT_DOCKER_SOCKET;
	}
	return fallbackGuess;
}

/** Collapse a home-prefixed path back to `~/…` so log lines stay readable. */
export function tildePath(path: string, home = process.env.HOME?.trim() || homedir()): string {
	return home && path.startsWith(`${home}/`) ? `~${path.slice(home.length)}` : path;
}

const SOURCE_LABELS: Record<DockerSocketSource, string> = {
	flag: 'via --docker-socket',
	'docker-host': 'via DOCKER_HOST',
	'docker-context': 'via docker context',
	discovered: 'auto-detected',
};

/** One-line boot summary: which socket answered, and how Hezo found it. */
export function describeDockerSocket(candidate: DockerSocketCandidate, home?: string): string {
	const runtime = candidate.runtime ? `${DOCKER_RUNTIME_LABELS[candidate.runtime]}, ` : '';
	return `Docker daemon reachable at ${tildePath(candidate.path, home)} (${runtime}${SOURCE_LABELS[candidate.source]})`;
}

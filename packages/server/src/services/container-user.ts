import { logger } from '../logger';
import type { DockerClient } from './docker';

const log = logger.child('container-user');

/**
 * The user a project container's agent/git execs run as. The agent base image runs
 * as **root** (no `USER` directive); Hezo deprivileges individual execs to a
 * non-root user (the stock image's `node`) purely so bind-mounted files stay
 * non-root-owned — `node` has passwordless sudo, so it is not a security boundary.
 * Custom `docker_base_image`s may have no `node` user, so the user is **detected**,
 * never assumed.
 */
export interface ContainerRunUser {
	/** Username for `docker exec --user` and the socat `user=` socket owner. */
	name: string;
	uid: number;
	gid: number;
}

const ROOT: ContainerRunUser = { name: 'root', uid: 0, gid: 0 };

// Resolved once per container (immutable for the container's lifetime) — the same
// value is needed at provision, at run time, and on every CEO chat turn.
const cache = new Map<string, ContainerRunUser>();

/** Drop a container's cached run-user (call on teardown / rebuild / reprovision). */
export function clearContainerRunUserCache(containerId?: string): void {
	if (containerId) cache.delete(containerId);
	else cache.clear();
}

async function execCapture(
	docker: DockerClient,
	containerId: string,
	script: string,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
	const execId = await docker.execCreate(containerId, {
		Cmd: ['sh', '-c', script],
		User: 'root',
		AttachStdout: true,
		AttachStderr: true,
	});
	const { stdout, stderr } = await docker.execStart(execId);
	const { ExitCode } = await docker.execInspect(execId);
	return { exitCode: ExitCode, stdout, stderr };
}

function delay(ms: number): Promise<void> {
	return new Promise((resolve) => setTimeout(resolve, ms));
}

async function probe(
	docker: DockerClient,
	containerId: string,
	user: 'node' | null,
): Promise<ContainerRunUser | null> {
	// `&&`-chained so a missing user yields a non-zero exit (not a partial reading).
	// `user` is only ever the literal 'node' — there is no shell-injection surface.
	const t = user ? ` ${user}` : '';
	const { exitCode, stdout } = await execCapture(
		docker,
		containerId,
		`id -u${t} && id -g${t} && id -un${t}`,
	);
	if (exitCode !== 0) return null;
	const [uidStr, gidStr, name] = stdout.split('\n').map((l) => l.trim());
	const uid = Number(uidStr);
	const gid = Number(gidStr);
	if (!Number.isInteger(uid) || !Number.isInteger(gid) || !name) return null;
	return { name, uid, gid };
}

/**
 * Resolve the user a project container's agent/git execs should run as. Prefers a
 * `node` user (the stock agent-base) and falls back to the container's default user
 * (root, for an image with no `USER`). Never throws — on any docker failure it
 * defaults to root, which makes the run-user chowns a harmless no-op and lets the
 * (root) container read everything the host wrote. Cached per container.
 */
export async function resolveContainerRunUser(
	docker: DockerClient,
	containerId: string,
): Promise<ContainerRunUser> {
	const cached = cache.get(containerId);
	if (cached) return cached;
	let resolved: ContainerRunUser;
	try {
		resolved =
			(await probe(docker, containerId, 'node')) ??
			(await probe(docker, containerId, null)) ??
			ROOT;
	} catch (e) {
		log.debug(
			`run-user detection failed for ${containerId.slice(0, 12)}, defaulting to root: ${
				e instanceof Error ? e.message : String(e)
			}`,
		);
		resolved = ROOT;
	}
	cache.set(containerId, resolved);
	return resolved;
}

function shSingleQuote(s: string): string {
	return `'${s.replace(/'/g, `'\\''`)}'`;
}

/**
 * Create directories **inside the container** (as root, `mkdir -p`). A host-side
 * `mkdirSync` in a bind mount is not always immediately visible in the container —
 * bind-mount propagation lags on macOS Docker Desktop, most visibly right after a
 * container reprovision — so an in-container `git worktree add` can fail with ENOENT
 * on a path the host just created. Creating the directory from inside the container
 * guarantees it exists in the container's namespace (and writes through the live bind
 * to the host). Best-effort: a failure logs one warning and never throws; the git
 * operation that follows surfaces the actionable error if the path truly can't be made.
 */
export async function mkdirInContainer(
	docker: DockerClient,
	containerId: string,
	containerPaths: string[],
): Promise<void> {
	if (containerPaths.length === 0) return;
	const targets = containerPaths.map(shSingleQuote).join(' ');
	try {
		const { exitCode, stderr } = await execCapture(docker, containerId, `mkdir -p ${targets}`);
		if (exitCode !== 0) {
			log.warn(`mkdir -p exited ${exitCode} for [${containerPaths.join(', ')}]: ${stderr.trim()}`);
		}
	} catch (e) {
		log.warn(
			`mkdir -p failed for [${containerPaths.join(', ')}]: ${
				e instanceof Error ? e.message : String(e)
			}`,
		);
	}
}

const DIR_READY_RETRIES = 5;
const DIR_READY_DELAY_MS = 100;

/**
 * Ensure a directory exists **and is visible** inside the container, retrying to
 * absorb bind-mount propagation lag. Right after a container (re)provision on
 * macOS Docker Desktop, a path the host just `mkdirSync`'d — or even one a prior
 * in-container `mkdir -p` created — can briefly stat as missing in the container's
 * mount namespace, so a follow-on `git worktree add` fails with ENOENT. Each
 * attempt runs `mkdir -p <path> && test -d <path>` as root: the `test -d`
 * re-stats through the live bind, so a `mkdir` that returns 0 before the entry is
 * visible on a later stat still loops. Best-effort: returns `false` (never
 * throws) if the path is never confirmed, logging one warning — the git op that
 * follows surfaces the actionable error if the path truly can't be made.
 */
export async function ensureContainerDirReady(
	docker: DockerClient,
	containerId: string,
	containerPath: string,
	opts: { retries?: number; delayMs?: number } = {},
): Promise<boolean> {
	const retries = opts.retries ?? DIR_READY_RETRIES;
	const delayMs = opts.delayMs ?? DIR_READY_DELAY_MS;
	const target = shSingleQuote(containerPath);
	for (let attempt = 0; attempt < retries; attempt++) {
		try {
			const { exitCode } = await execCapture(
				docker,
				containerId,
				`mkdir -p ${target} && test -d ${target}`,
			);
			if (exitCode === 0) return true;
		} catch {
			// A docker exec error is itself transient right after (re)provision; retry.
		}
		if (attempt < retries - 1) await delay(delayMs);
	}
	log.warn(`mkdir/verify did not confirm ${containerPath} in container after ${retries} attempts`);
	return false;
}

/**
 * Give the container's run-user ownership of paths the host created in a bind mount
 * that the run-user must read or write. The chown runs **inside the container as
 * root** (the base image's default user), so it needs no host privilege and works
 * uniformly across root-host, non-root-host, and macOS deployments — unlike a
 * host-side chown, which would need `CAP_CHOWN` and fail on macOS dev / a non-root
 * `User=hezo` server. A no-op when the run-user is root (the container already
 * accesses everything). Best-effort: a non-zero/failed chown logs one warning and
 * never throws — a permission fix must never abort the run/provision around it.
 */
export async function chownToRunUser(
	docker: DockerClient,
	containerId: string,
	runUser: ContainerRunUser,
	containerPaths: string[],
	opts: { recursive?: boolean } = {},
): Promise<void> {
	if (runUser.uid === 0 || containerPaths.length === 0) return;
	const flag = opts.recursive ? '-R ' : '';
	const owner = `${shSingleQuote(runUser.name)}:${shSingleQuote(runUser.name)}`;
	const targets = containerPaths.map(shSingleQuote).join(' ');
	try {
		const { exitCode, stderr } = await execCapture(
			docker,
			containerId,
			`chown ${flag}${owner} ${targets}`,
		);
		if (exitCode !== 0) {
			log.warn(
				`chown to ${runUser.name} exited ${exitCode} for [${containerPaths.join(', ')}]: ${stderr.trim()}`,
			);
		}
	} catch (e) {
		log.warn(
			`chown to ${runUser.name} failed for [${containerPaths.join(', ')}]: ${
				e instanceof Error ? e.message : String(e)
			}`,
		);
	}
}

import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { logger } from '../logger';
import type { DockerClient } from './docker';
import { getResolvedDockerSocket } from './docker-socket';
import { ensureImage } from './ensure-image';
import { MANAGED_AGENT_BASE_IMAGE, resolveAgentBaseImage } from './image-registry';

const log = logger.child('mount-preflight');

/**
 * Operator opt-out for the boot-time bind-mount check. For a setup whose host
 * path sharing this probe can't model, or who doesn't want a throwaway container
 * booted each start. Never surfaced in the failure guidance - it suppresses the
 * diagnosis, it doesn't fix the underlying problem.
 */
export const SKIP_MOUNT_CHECK_ENV = 'HEZO_SKIP_MOUNT_CHECK';

/** Where the runtime-specific mount guidance lives. */
export const CONTAINER_RUNTIMES_DOCS_URL = 'https://hezo.ai/docs/deployment/container-runtimes';

/** Where the probe dir is mounted inside the throwaway container. */
const PROBE_MOUNT_PATH = '/mnt/hezo-mount-check';

/**
 * - `ok`          - the data dir is shared into the daemon and writable.
 * - `read-only`   - shared, but the container can't write (Colima's default $HOME mount).
 * - `not-mounted` - the daemon can't see the host path at all, or writes don't reach it.
 */
export type MountOutcome = 'ok' | 'read-only' | 'not-mounted';

export interface MountProbeResult {
	/** The container could read the sentinel file the host wrote. */
	sentinelSeen: boolean;
	/** The container's write into the mount succeeded. */
	writeSucceeded: boolean;
	/** The host can see the file the container wrote. */
	hostSawWrite: boolean;
}

/**
 * Decide the outcome from the three probe signals. A container that reports a
 * successful write the host never sees is not a working bind mount - the write
 * landed in the container's own layer, which is the same practical failure as
 * the path not being shared at all, so it classifies as `not-mounted` and gets
 * the same "share this path with the VM" guidance.
 */
export function classifyMount(result: MountProbeResult): MountOutcome {
	if (!result.sentinelSeen) return 'not-mounted';
	if (!result.writeSucceeded) return 'read-only';
	return result.hostSawWrite ? 'ok' : 'not-mounted';
}

/**
 * The shell the probe container runs: echo back the sentinel the host wrote (so
 * we know the mount is really the host's directory and not an empty auto-created
 * stand-in), then try to write into it. Prints `SEEN:<token|-> WRITE:<OK|FAIL>`.
 */
export function buildMountProbeScript(writeName: string): string {
	return (
		`s=$(cat ${PROBE_MOUNT_PATH}/sentinel 2>/dev/null); [ -z "$s" ] && s=-; ` +
		`if touch ${PROBE_MOUNT_PATH}/${writeName} 2>/dev/null; then w=OK; else w=FAIL; fi; ` +
		`printf 'SEEN:%s WRITE:%s\\n' "$s" "$w"`
	);
}

/**
 * Parse the probe container's `SEEN:<token> WRITE:<OK|FAIL>` stdout line. The
 * sentinel must match the token the host wrote - any other value (including the
 * `-` the script prints when the file is missing) means the container is not
 * looking at the host's directory.
 */
export function parseMountProbeOutput(
	stdout: string,
	sentinel: string,
): Omit<MountProbeResult, 'hostSawWrite'> {
	return {
		sentinelSeen: stdout.includes(`SEEN:${sentinel}`),
		writeSucceeded: /WRITE:OK/.test(stdout),
	};
}

/**
 * Operator-actionable guidance for a non-ok mount check, logged at boot. Agents
 * write into the data directory through a bind mount (workspace, worktrees,
 * previews), so a read-only or unshared mount means every run fails on its first
 * write - with an error that looks like a broken agent rather than a host
 * misconfiguration. Name the runtime-specific fix, since the fix differs
 * entirely between a VM-backed runtime and native Linux. Never surfaces
 * HEZO_SKIP_DOCKER or the opt-out env (those hide the symptom).
 *
 * Hyphens only, never em/en dashes (user-facing prose rule).
 */
export function formatMountPreflightMessage(
	outcome: Exclude<MountOutcome, 'ok'>,
	opts: { dataDir: string },
): string {
	const header = [
		outcome === 'read-only'
			? `Agent containers get a READ-ONLY view of the Hezo data directory (${opts.dataDir}).`
			: `Agent containers cannot see the Hezo data directory (${opts.dataDir}).`,
		'',
		"Agents work inside a container on a bind mount of that directory - each project's",
		'workspace, worktrees and previews live there. Until the mount is shared and',
		'writable, every agent run fails on its first write (a failed clone, checkout, or',
		'file edit) even though Docker itself is working.',
		'',
	];

	const vmFix = [
		'Runtimes that run the daemon inside a VM (Colima, Lima, Rancher Desktop) only',
		'share the host paths you list, and Colima shares your home directory read-only',
		'by default. Share the data directory writable:',
		'',
		'  colima stop',
		`  colima start --mount ${opts.dataDir}:w`,
		'',
		'  Lima             add a writable mount for it to the instance YAML, then restart',
		'  Rancher Desktop  Preferences > Virtual Machine > Volumes (use virtiofs)',
		'  Docker Desktop   Settings > Resources > File sharing, then add the path',
		'',
	];

	const tail = [
		'Already sharing it? Check the host permissions on the directory (it must be',
		'writable by the user Hezo runs as), and on SELinux hosts that the mount is',
		'labelled for container access.',
		'',
		`More detail: ${CONTAINER_RUNTIMES_DOCS_URL}`,
	];

	return [...header, ...vmFix, ...tail].join('\n');
}

export interface MountProbeDeps {
	docker: DockerClient;
	image: string;
	dataDir: string;
}

/**
 * Boot a throwaway container with a bind mount of a scratch directory inside the
 * data dir, and have it read the host's sentinel and write a file back. Mirrors
 * project provisioning (sleep-infinity container + exec) so it exercises the same
 * mount path real agent containers use. Always tears the container and the
 * scratch directory down.
 *
 * The exec deliberately passes no `User`, so it runs as **root** in-container -
 * the same footing provisioning chowns the real mount points from. That isolates
 * the question we are actually asking (is the host path shared, and is the mount
 * writable?) from host-vs-container file ownership, which provisioning solves
 * separately via `chownToRunUser`. Deprivileging this exec would turn an ordinary
 * uid mismatch into a false `read-only` verdict on a perfectly healthy host.
 */
async function runMountProbe(deps: MountProbeDeps): Promise<MountProbeResult> {
	const { docker, image, dataDir } = deps;
	const token = randomBytes(8).toString('hex');
	const hostDir = join(dataDir, `.mount-check-${token}`);
	const writeName = `written-${token}`;
	const name = `hezo-mount-check-${token}`;
	let containerId: string | null = null;

	mkdirSync(hostDir, { recursive: true });
	writeFileSync(join(hostDir, 'sentinel'), token, 'utf8');
	try {
		const { Id } = await docker.createContainer(name, {
			Image: image,
			Cmd: ['sleep', 'infinity'],
			Labels: { 'ai.hezo.role': 'mount-preflight' },
			HostConfig: { Binds: [`${hostDir}:${PROBE_MOUNT_PATH}:rw`] },
		});
		containerId = Id;
		await docker.startContainer(Id);
		const execId = await docker.execCreate(Id, {
			Cmd: ['sh', '-c', buildMountProbeScript(writeName)],
			AttachStdout: true,
			AttachStderr: true,
		});
		const { stdout } = await docker.execStart(execId);
		return {
			...parseMountProbeOutput(stdout, token),
			hostSawWrite: existsSync(join(hostDir, writeName)),
		};
	} finally {
		if (containerId) {
			await docker.removeContainer(containerId, true).catch((err: unknown) => {
				log.warn('failed to remove mount-probe container', { error: String(err) });
			});
		}
		try {
			rmSync(hostDir, { recursive: true, force: true });
		} catch (err) {
			log.warn('failed to remove mount-probe directory', { error: String(err) });
		}
	}
}

export interface MountCheckDeps {
	docker: DockerClient;
	dataDir: string;
	/** Injectable for tests; defaults to the real throwaway-container probe. */
	probe?: (deps: MountProbeDeps) => Promise<MountProbeResult>;
	env?: NodeJS.ProcessEnv;
	/** Whether to log the outcome (default true). */
	logOutcome?: boolean;
}

/**
 * Verify agent containers get a writable view of the data directory, and log
 * operator-actionable guidance when they don't. Best-effort and **non-fatal**:
 * it never throws and never gates startup - exiting here would also take down
 * the web UI the operator needs to read the guidance and reconfigure (the same
 * reasoning as the container connectivity check). Skipped under HEZO_SKIP_DOCKER
 * (fake docker / tests) and the documented opt-out.
 *
 * Single attempt, no retry: unlike connectivity there is no transient race here
 * - a mount is shared and writable, or it isn't.
 *
 * Distinct from `verifyContainerWorkspace` (containers.ts), which asks a *live
 * project container* whether its own mounts have gone stale and answers with a
 * boolean. This runs once at boot, before any project exists, and its output is a
 * diagnosis: which host-level misconfiguration is present, and the exact fix.
 */
export async function checkContainerMounts(
	deps: MountCheckDeps,
): Promise<MountOutcome | 'skipped'> {
	const env = deps.env ?? process.env;
	if (env.HEZO_SKIP_DOCKER || env[SKIP_MOUNT_CHECK_ENV]) return 'skipped';

	try {
		const { image, preferPull } = resolveAgentBaseImage(MANAGED_AGENT_BASE_IMAGE);
		await ensureImage(deps.docker, image, { preferPull });
		const probe = deps.probe ?? runMountProbe;
		const outcome = classifyMount(
			await probe({ docker: deps.docker, image, dataDir: deps.dataDir }),
		);

		if (deps.logOutcome !== false) {
			if (outcome === 'ok') {
				log.info('container bind mounts OK (data directory shared and writable)');
			} else {
				// Fatal to agent work - no run can write a single file - so `error`,
				// unlike the bind-host degradations in the connectivity check.
				log.error(`\n${formatMountPreflightMessage(outcome, { dataDir: deps.dataDir })}\n`);
				const runtime = getResolvedDockerSocket()?.runtime;
				if (runtime) log.info(`(detected container runtime: ${runtime})`);
			}
		}
		return outcome;
	} catch (err) {
		// Diagnostics must never break startup. If the probe machinery itself fails
		// (image unavailable offline, Docker hiccup), stay quiet at info - container
		// provisioning would surface a real image/Docker fault anyway.
		log.info('container mount check skipped (probe unavailable)', {
			error: err instanceof Error ? err.message : String(err),
		});
		return 'skipped';
	}
}

import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
	ContainerStatus,
	HeartbeatRunStatus,
	TEST_CONTAINER_LABEL_KEY,
	TEST_CONTAINER_LABEL_VALUE,
	TEST_CONTAINERS_ENV,
	WakeupSource,
	WsMessageType,
	wsRoom,
} from '@hezo/shared';
import type { MasterKeyManager } from '../crypto/master-key';
import type { Db } from '../db/database';
import { trackBackground } from '../lib/background';
import { broadcastProjectUpdate, broadcastRowChange } from '../lib/broadcast';
import { ref } from '../lib/log-ref';
import { stripNulBytes, terminalStatusParams } from '../lib/sql';
import { logger } from '../logger';
import { setAgentIdleIfNoActiveRuns } from './agent-runtime-status';
import type { ContainerLogStreamer } from './container-logs';
import {
	chownToRunUser,
	clearContainerRunUserCache,
	resolveContainerRunUser,
} from './container-user';
import type { DockerClient } from './docker';
import { ensureImage } from './ensure-image';
import { ContainerGitExecutor, mintGitOpScopeId } from './git-executor';
import { resolveAgentBaseImage } from './image-registry';
import type { LogStreamBroker } from './log-stream-broker';
import { ensureProjectRepos } from './repo-sync';
import { type BridgeRunnerArgs, type SshAgentServer, withProvisionBridge } from './ssh-agent';
import { createWakeup } from './wakeup';
import {
	CONTAINER_WORKSPACE_ROOT,
	CONTAINER_WORKTREES_ROOT,
	ensureProjectWorkspace,
	removeProjectWorkspace,
} from './workspace';
import type { WebSocketManager } from './ws';

export type ContainerExitReason = 'container_error' | 'container_stopped';

export interface ContainerTransition {
	projectId: string;
	projectSlug: string;
	teamId: string;
	oldStatus: string | null;
	newStatus: string | null;
}

const log = logger.child('containers');

export interface ProjectRow {
	id: string;
	team_id: string;
	slug: string;
	docker_base_image: string;
	container_id: string | null;
	container_status: string | null;
	dev_ports: Array<{ container: number; host: number }>;
}

export interface ContainerDeps {
	db: Db;
	docker: DockerClient;
	dataDir: string;
	wsManager?: WebSocketManager;
	masterKeyManager?: MasterKeyManager;
	logs?: LogStreamBroker;
	containerLogStreamer?: ContainerLogStreamer;
	sshAgentServer?: SshAgentServer | null;
	egressCAPath?: string | null;
	/** Test seam: override host egress-MTU detection. Defaults to the real probe. */
	detectEgressMtu?: () => Promise<number | null>;
}

/** In-container path the egress CA is bind-mounted to. */
export const CONTAINER_CA_PATH = '/usr/local/share/ca-certificates/hezo-egress.crt';

const PROVISION_CAP_BYTES = 64 * 1024;

/** Docker's default bridge MTU; below this the container link MTU is pinned to match. */
const DEFAULT_BRIDGE_MTU = 1500;

/**
 * The MTU of the host's default-route egress interface, or null when it can't be
 * determined (non-Linux, `ip` absent, or a parse failure). Uses `ip route get` so
 * it honours policy routing — a VPN/mesh (WireGuard, NordVPN, Tailscale) installs
 * its default route in a separate table that `/proc/net/route` alone wouldn't
 * reflect. Containers reach the internet through this interface via NAT, so an
 * egress MTU below the docker bridge MTU means a bulk transfer (a `git fetch`)
 * black-holes at the tunnel boundary unless the container link MTU is pinned to it.
 */
export async function detectHostEgressMtu(): Promise<number | null> {
	try {
		const dev = await new Promise<string | null>((resolve) => {
			execFile('ip', ['-o', 'route', 'get', '1.1.1.1'], { timeout: 3000 }, (err, stdout) => {
				if (err) return resolve(null);
				resolve(stdout.match(/\bdev\s+(\S+)/)?.[1] ?? null);
			});
		});
		if (!dev) return null;
		const mtu = Number.parseInt((await readFile(`/sys/class/net/${dev}/mtu`, 'utf8')).trim(), 10);
		return Number.isFinite(mtu) && mtu > 0 ? mtu : null;
	} catch {
		return null;
	}
}

function provisionStreamId(projectId: string): string {
	return `provision:${projectId}`;
}

function beginProvisionStream(logs: LogStreamBroker | undefined, projectId: string): void {
	if (!logs) return;
	logs.begin({
		streamId: provisionStreamId(projectId),
		room: `container-logs:${projectId}`,
		buildMessage: (line) => ({
			type: WsMessageType.ContainerLog,
			projectId,
			stream: line.stream,
			text: line.text,
		}),
		buildSnapshot: (text) => ({
			type: WsMessageType.ContainerLog,
			projectId,
			stream: 'stdout',
			text,
			replace: true,
		}),
		capBytes: PROVISION_CAP_BYTES,
	});
}

const PORT_POOL_START = 10000;
const PORT_POOL_END = 19999;

const LAST_LOGS_CAP_BYTES = 32 * 1024;

// When true, old containers are kept rather than removed on rebuild and
// teardown, so crashed containers stay around for `docker logs` /
// `docker inspect`. A fresh provision still succeeds because each container
// name carries a random suffix, so a retained container never blocks the new
// one. Set centrally from parseConfig at startup.
let keepOldContainersFlag = false;

export function setKeepOldContainers(value: boolean): void {
	keepOldContainersFlag = value;
}

export function shouldKeepOldContainers(): boolean {
	return keepOldContainersFlag;
}

/**
 * Default per-container working-set ceiling, used when a project has not set
 * its own `projects.memory_limit_gib`. The sync loop stops the container when
 * working-set memory crosses this threshold and records an explanation in
 * `container_error`. Override per project from the Settings page.
 */
export const DEFAULT_MEMORY_LIMIT_GIB = 16;

const memoryLimitBytes = (gib: number) => gib * 1024 ** 3;

/**
 * Headroom the cgroup hard cap sits above the project's working-set ceiling.
 * The stats poller in the sync loop stays the graceful early-stop (clean
 * `stopContainer` + explanation in `container_error` at the configured limit);
 * the cgroup cap exists so a runaway allocation between poll ticks hits the
 * kernel OOM killer (exit 137) instead of destabilizing the host. MemorySwap
 * is set equal to Memory, so the cap has no swap escape valve.
 */
const MEMORY_HARD_CAP_HEADROOM_BYTES = 512 * 1024 ** 2;

/** Fork-bomb backstop; generous for npm/build process fan-out. */
const CONTAINER_PIDS_LIMIT = 4096;

/**
 * Capabilities added back after `CapDrop: ALL` — the minimum the agent
 * workload needs: chown/ownership fixes on the bind-mounted workspace
 * (CHOWN, DAC_OVERRIDE, FOWNER), the `node` user's passwordless-sudo setuid
 * transition and runtime apt installs (SETUID, SETGID), process signalling
 * (KILL), and sudo's audit writes (AUDIT_WRITE). NET_ADMIN is appended
 * separately, only when MTU pinning needs it.
 *
 * Deliberately absent: `no-new-privileges` (would break the sudo/setuid path
 * the runtime apt/npx installs depend on) and `userns-remap` (daemon-global,
 * would remap every other container on the host and break the bind-mount
 * ownership model).
 */
export const CONTAINER_BASE_CAPABILITIES = [
	'CHOWN',
	'DAC_OVERRIDE',
	'FOWNER',
	'SETUID',
	'SETGID',
	'KILL',
	'AUDIT_WRITE',
];

const MEMORY_USAGE_LOG_INTERVAL_MS = 30_000;

interface MemoryUsageEntry {
	lastLogMs: number;
	lastUsedBytes: number;
	limitGib: number;
}

const memoryUsageState = new Map<string, MemoryUsageEntry>();

function formatMemoryLine(entry: MemoryUsageEntry): string {
	const usedGiB = (entry.lastUsedBytes / 1024 ** 3).toFixed(2);
	return `${usedGiB} / ${entry.limitGib} GiB`;
}

/**
 * Pull-and-clear the most recent stats reading for a project, formatted as a
 * single line suitable for appending to `container_last_logs`. Returns null
 * when no reading was ever recorded for this project (e.g. the container died
 * before the first sync tick observed it). Clears the entry as a side effect
 * so subsequent transition handlers do not double-emit.
 */
export function consumeFinalMemoryLine(projectId: string): string | null {
	const entry = memoryUsageState.get(projectId);
	if (!entry) return null;
	memoryUsageState.delete(projectId);
	return `→ Final container memory: ${formatMemoryLine(entry)}`;
}

function appendMemoryLine(existing: string | null, line: string | null): string | null {
	if (!line) return existing;
	if (!existing) return `${line}\n`;
	return existing.endsWith('\n') ? `${existing}${line}\n` : `${existing}\n${line}\n`;
}

/**
 * Pull a one-shot tail of the container's stdout+stderr log buffer. Used to
 * snapshot the last-known console output when a container exits or errors so
 * the user can see what happened without a live stream.
 */
export async function captureContainerLogs(
	docker: DockerClient,
	containerId: string,
	projectSlug?: string | null,
): Promise<string | null> {
	try {
		const res = await docker.containerLogs(containerId, {
			follow: false,
			tail: 500,
			stdout: true,
			stderr: true,
		});
		if (res === null) return null;
		const raw = new Uint8Array(await res.arrayBuffer());
		const decoder = new TextDecoder();
		const chunks: string[] = [];
		let offset = 0;
		while (offset + 8 <= raw.length) {
			const frameSize =
				(raw[offset + 4] << 24) |
				(raw[offset + 5] << 16) |
				(raw[offset + 6] << 8) |
				raw[offset + 7];
			offset += 8;
			if (offset + frameSize > raw.length) break;
			chunks.push(decoder.decode(raw.slice(offset, offset + frameSize)));
			offset += frameSize;
		}
		let combined = stripNulBytes(chunks.join(''));
		if (combined.length > LAST_LOGS_CAP_BYTES) {
			combined = combined.slice(-LAST_LOGS_CAP_BYTES);
		}
		return combined || null;
	} catch (err) {
		log.warn(
			`Failed to capture logs for container ${ref(projectSlug, containerId.slice(0, 12))}:`,
			err,
		);
		return null;
	}
}

export async function provisionContainer(
	deps: ContainerDeps,
	project: ProjectRow,
	teamSlug: string,
): Promise<string> {
	const { db, docker, dataDir, wsManager, masterKeyManager, logs } = deps;
	const teamId = project.team_id;

	await db.query('UPDATE projects SET container_status = $1::container_status WHERE id = $2', [
		ContainerStatus.Creating,
		project.id,
	]);
	// Broadcast the creating transition so the web banner shows for provisions that
	// don't go through the rebuild route (startup repair, self-heal, reprovision).
	await broadcastProjectUpdate(db, wsManager, teamId, project.id);

	beginProvisionStream(logs, project.id);
	const streamId = provisionStreamId(project.id);
	const emit = (stream: 'stdout' | 'stderr', text: string) => logs?.emit(streamId, stream, text);

	try {
		emit('stdout', `→ Preparing workspace for ${teamSlug}/${project.slug}`);
		const projectDir = ensureProjectWorkspace(dataDir, project.team_id, project.id);
		const workspacePath = join(projectDir, 'workspace');
		const worktreesPath = join(projectDir, 'worktrees');
		const previewsPath = join(projectDir, '.previews');

		// Assets are deliberately NOT mounted: blobs live in the configured asset
		// store (local dir or S3-compatible bucket) and agents fetch them over
		// signed download URLs from the asset tools, never the filesystem.
		const binds = [
			`${workspacePath}:/workspace:rw`,
			`${worktreesPath}:/worktrees:rw`,
			`${previewsPath}:/workspace/.previews:rw`,
		];
		if (deps.egressCAPath) {
			binds.push(`${deps.egressCAPath}:${CONTAINER_CA_PATH}:ro`);
		}

		const portBindings: Record<string, Array<{ HostPort: string }>> = {};
		const exposedPorts: Record<string, object> = {};
		const devPorts = project.dev_ports || [];

		const allocatedPorts = await allocateHostPorts(db, devPorts, project.id);

		for (const mapping of allocatedPorts) {
			const containerPort = `${mapping.container}/tcp`;
			portBindings[containerPort] = [{ HostPort: String(mapping.host) }];
			exposedPorts[containerPort] = {};
		}

		if (allocatedPorts.length > 0) {
			await db.query('UPDATE projects SET dev_ports = $1::jsonb WHERE id = $2', [
				JSON.stringify(allocatedPorts),
				project.id,
			]);
		}

		// Bind mounts key on the immutable project id, so a rename never shifts
		// paths or orphans data. The container name embeds the project slug for
		// `docker ps` readability, an 8-char id prefix, and a random suffix so
		// every provision yields a unique name. The old container is always torn
		// down by stored `container_id`, never by name, so when it is retained
		// (keep-old) the fresh name still avoids a create-time conflict.
		const containerName = `hezo-${project.slug}-${project.id.slice(0, 8)}-${randomBytes(4).toString('hex')}`;
		const containerLabels: Record<string, string> = {
			'hezo.team': teamSlug,
			'hezo.project': project.slug,
		};
		// Mark containers spawned by a test run so the test harness's cleanup can scope
		// itself to them and never delete a developer's live dev-server containers.
		if (process.env[TEST_CONTAINERS_ENV] === '1') {
			containerLabels[TEST_CONTAINER_LABEL_KEY] = TEST_CONTAINER_LABEL_VALUE;
		}
		const extraHosts = ['host.docker.internal:host-gateway'];

		// A host whose internet egress is a VPN/mesh tunnel (WireGuard, NordVPN,
		// Tailscale) has a sub-1500 MTU. Containers reach the internet through it via
		// NAT but otherwise inherit the 1500 docker-bridge MTU, so a bulk transfer
		// (a git fetch) black-holes at the tunnel boundary. Pin the container link
		// MTU to the egress MTU; this needs NET_ADMIN, added only when a lower egress
		// MTU is actually detected so default (non-tunnelled) hosts are unaffected.
		const egressMtu = await (deps.detectEgressMtu ?? detectHostEgressMtu)();
		const pinMtu = egressMtu !== null && egressMtu < DEFAULT_BRIDGE_MTU ? egressMtu : null;

		const env: string[] = [];

		// The stored image is the managed sentinel/default for most projects; in a
		// release binary it resolves to the version-pinned GHCR image (pulled, with a
		// local-build fallback). Custom per-project images pass through unchanged.
		const { image: baseImage, preferPull } = resolveAgentBaseImage(project.docker_base_image);
		emit('stdout', `→ Resolving image ${baseImage}`);
		// Docker writes its build trace to stderr even on success; surface it as
		// informational stdout so a clean build isn't a wall of red. A real build
		// failure still throws (non-zero exit) and is reported by the catch below.
		await ensureImage(docker, baseImage, {
			preferPull,
			onLine: (_stream, text) => emit('stdout', text),
		});

		emit('stdout', `→ Creating container ${containerName}`);

		// cgroup hard cap = the project's working-set ceiling + headroom; the
		// sync-loop stats poller remains the graceful early-stop at the ceiling
		// itself (see MEMORY_HARD_CAP_HEADROOM_BYTES).
		const limitRow = await db.query<{ memory_limit_gib: number }>(
			'SELECT memory_limit_gib FROM projects WHERE id = $1',
			[project.id],
		);
		const memoryLimitGib = limitRow.rows[0]?.memory_limit_gib ?? DEFAULT_MEMORY_LIMIT_GIB;
		const memoryHardCapBytes = memoryLimitBytes(memoryLimitGib) + MEMORY_HARD_CAP_HEADROOM_BYTES;

		const { Id } = await docker.createContainer(containerName, {
			Image: baseImage,
			Cmd: ['sleep', 'infinity'],
			Env: env,
			WorkingDir: '/workspace',
			Labels: containerLabels,
			HostConfig: {
				Binds: binds,
				PortBindings: portBindings,
				ExtraHosts: extraHosts,
				Init: true,
				Memory: memoryHardCapBytes,
				MemorySwap: memoryHardCapBytes,
				PidsLimit: CONTAINER_PIDS_LIMIT,
				CapDrop: ['ALL'],
				CapAdd: [...CONTAINER_BASE_CAPABILITIES, ...(pinMtu !== null ? ['NET_ADMIN'] : [])],
			},
			ExposedPorts: exposedPorts,
		});

		emit('stdout', '→ Starting container');
		await docker.startContainer(Id);
		if (pinMtu !== null) {
			emit(
				'stdout',
				`→ Host egress MTU is ${egressMtu} (< ${DEFAULT_BRIDGE_MTU}); pinning container MTU to ${pinMtu}`,
			);
			try {
				const execId = await docker.execCreate(Id, {
					Cmd: ['ip', 'link', 'set', 'dev', 'eth0', 'mtu', String(pinMtu)],
					AttachStdout: true,
					AttachStderr: true,
				});
				const out = await docker.execStart(execId);
				if (out.stderr.trim())
					emit('stderr', `⚠ could not pin container MTU: ${out.stderr.trim()}`);
			} catch (e) {
				emit('stderr', `⚠ could not pin container MTU: ${(e as Error).message}`);
			}
		}
		log.info(
			`project ${ref(project.slug, project.id)} container ${ref(project.slug, Id.slice(0, 12))} provisioned and started`,
		);

		await db.query(
			'UPDATE projects SET container_id = $1, container_status = $2::container_status, container_error = NULL WHERE id = $3',
			[Id, ContainerStatus.Running, project.id],
		);

		if (deps.containerLogStreamer && deps.logs) {
			deps.containerLogStreamer.subscribe(project.id, Id, deps.logs, docker);
		}

		if (deps.egressCAPath) {
			emit('stdout', '→ Trusting Hezo egress CA (update-ca-certificates)');
			try {
				const execId = await docker.execCreate(Id, {
					Cmd: ['update-ca-certificates'],
					AttachStdout: true,
					AttachStderr: true,
				});
				const out = await docker.execStart(execId);
				if (out.stderr.trim()) emit('stderr', out.stderr);
			} catch (e) {
				emit('stderr', `⚠ update-ca-certificates failed: ${(e as Error).message}`);
			}
		}

		// Detect the container's run-user (the stock agent-base's `node`, or root for a
		// custom image without it). The host created the bind-mounted dirs as root;
		// give the run-user ownership of those the deprivileged git/agent execs must
		// write into — repo clones (/workspace), worktrees, previews — plus the per-run
		// ssh socket dir. Chowning in-container (as root) needs no host privilege; a
		// no-op when the run-user is root. Cleared on rebuild so a fresh container
		// re-detects.
		clearContainerRunUserCache(Id);
		const runUser = await resolveContainerRunUser(docker, Id);
		await chownToRunUser(docker, Id, runUser, [
			CONTAINER_WORKSPACE_ROOT,
			CONTAINER_WORKTREES_ROOT,
			`${CONTAINER_WORKSPACE_ROOT}/.previews`,
			'/run/hezo',
		]);

		if (masterKeyManager) {
			emit('stdout', '→ Syncing project repos');
			// Clone in-container (the host has no git). Repos clone over SSH, which
			// needs a bridge back to the host ssh-agent — provisioning isn't a run, so
			// allocate a short-lived one. No agent → no bridge → clone fails and is
			// reported (same as a missing key today).
			const syncRepos = (bridge: BridgeRunnerArgs | null, scopeId: string) =>
				ensureProjectRepos(
					db,
					{ id: project.id, team_id: teamId },
					dataDir,
					ContainerGitExecutor.forPrep(docker, Id, bridge, runUser, scopeId),
					(stream, text) => emit(stream, text),
				);
			const syncRes = deps.sshAgentServer
				? await withProvisionBridge(
						deps.sshAgentServer,
						teamId,
						dataDir,
						runUser.name,
						({ bridge, scopeId }) => syncRepos(bridge, scopeId),
					)
				: await syncRepos(null, mintGitOpScopeId());
			if (syncRes.failed.length > 0) {
				emit(
					'stderr',
					`⚠ ${syncRes.failed.length} repo(s) failed to clone; container is usable but some repos may be missing`,
				);
			}
		}

		emit('stdout', '→ Installing pending local MCP servers');
		try {
			const { installPendingLocalMcps } = await import('./mcp-installer');
			const results = await installPendingLocalMcps({
				db,
				docker,
				containerId: Id,
				teamId,
				projectId: project.id,
				emit,
			});
			const failed = results.filter((r) => r.status === 'failed');
			if (failed.length > 0) {
				emit(
					'stderr',
					`⚠ ${failed.length} MCP server install(s) failed; check the connection's install_error in settings`,
				);
			}
		} catch (e) {
			emit('stderr', `⚠ MCP installer step failed: ${(e as Error).message}`);
		}

		emit('stdout', '✓ Container ready');
		await broadcastProjectUpdate(db, wsManager, teamId, project.id);

		await requeueContainerKilledRuns(deps, project.id, project.slug, teamId).catch((e) =>
			log.error('Failed to requeue container-killed runs after provision:', e),
		);
		// A wakeup that fired while the container was still provisioning could not
		// run (container_status !== running). Now that it's up, nudge every agent
		// holding pending work so freshly-created tasks (e.g. the CEO's coherence
		// pass) start without waiting for the next scheduled heartbeat. Mirrors the
		// container start/rebuild routes.
		await wakeAgentsWithPendingWork(db, project.id, teamId).catch((e) =>
			log.error('Failed to wake agents with pending work after provision:', e),
		);

		return Id;
	} catch (error) {
		const errorMessage = error instanceof Error ? error.message : String(error);
		emit('stderr', `✗ Provisioning failed: ${errorMessage}`);
		await db.query(
			'UPDATE projects SET container_status = $1::container_status, container_error = $2 WHERE id = $3',
			[ContainerStatus.Error, errorMessage, project.id],
		);
		await broadcastProjectUpdate(db, wsManager, teamId, project.id);
		throw error;
	}
}

/**
 * Bring a project's container up on demand and return its running container id.
 * A container that exists but is stopped is started in place (cheaper, preserves
 * state); one that is missing or was never created is provisioned from scratch.
 * Trusts the DB only when Docker agrees the container is actually running, so a
 * stale `running` row that no longer maps to a live container is repaired.
 */
export async function ensureProjectContainerRunning(
	deps: ContainerDeps,
	projectId: string,
): Promise<string> {
	const { db, docker } = deps;
	const res = await db.query<ProjectRow & { team_slug: string }>(
		`SELECT p.id, p.team_id, p.slug, p.docker_base_image, p.container_id, p.container_status,
		        p.dev_ports, c.slug AS team_slug
		 FROM projects p JOIN teams c ON c.id = p.team_id
		 WHERE p.id = $1`,
		[projectId],
	);
	const proj = res.rows[0];
	if (!proj) throw new Error('Project not found');

	if (proj.container_id) {
		const info = await docker.inspectContainer(proj.container_id);
		if (info?.State.Running) return proj.container_id;
		if (info) {
			// Container exists but is stopped — start it in place.
			await docker.startContainer(proj.container_id);
			await db.query(
				'UPDATE projects SET container_status = $1::container_status, container_error = NULL WHERE id = $2',
				[ContainerStatus.Running, proj.id],
			);
			if (deps.containerLogStreamer && deps.logs) {
				deps.containerLogStreamer.subscribe(proj.id, proj.container_id, deps.logs, docker);
			}
			await broadcastProjectUpdate(db, deps.wsManager, proj.team_id, proj.id);
			return proj.container_id;
		}
	}

	// No container id, or the stored id no longer exists in Docker — provision.
	return provisionContainer(deps, proj, proj.team_slug);
}

export async function teardownContainer(
	deps: ContainerDeps,
	projectId: string,
	projectSlug: string,
	teamId: string,
): Promise<void> {
	const { db, docker, dataDir } = deps;

	const result = await db.query<{ container_id: string | null }>(
		'SELECT container_id FROM projects WHERE id = $1',
		[projectId],
	);

	const teardownContainerId = result.rows[0]?.container_id;
	if (teardownContainerId && !keepOldContainersFlag) {
		try {
			await docker.stopContainer(teardownContainerId);
		} catch {
			// Container may already be stopped
		}
		try {
			await docker.removeContainer(teardownContainerId, true);
		} catch {
			// Container may already be removed
		}
	}

	await db.query('UPDATE projects SET container_id = NULL, container_status = NULL WHERE id = $1', [
		projectId,
	]);

	removeProjectWorkspace(dataDir, teamId, projectId);
	memoryUsageState.delete(projectId);

	if (teardownContainerId) {
		log.info(
			`project ${ref(projectSlug, projectId)} container ${ref(projectSlug, teardownContainerId.slice(0, 12))} torn down`,
		);
	} else {
		log.info(`project ${ref(projectSlug, projectId)} torn down (no container was provisioned)`);
	}
}

export async function stopContainerGracefully(
	deps: ContainerDeps,
	projectId: string,
	projectSlug: string,
	teamId: string,
	containerId: string,
): Promise<void> {
	const { db, docker, wsManager } = deps;

	const lastLogs = await captureContainerLogs(docker, containerId, projectSlug);
	const annotatedLogs = appendMemoryLine(lastLogs, consumeFinalMemoryLine(projectId));

	let exitReason: ContainerExitReason = 'container_stopped';
	try {
		await docker.stopContainer(containerId);
		await db.query(
			`UPDATE projects
			 SET container_status = $1::container_status,
			     container_last_logs = COALESCE($2, container_last_logs),
			     container_error = NULL
			 WHERE id = $3`,
			[ContainerStatus.Stopped, annotatedLogs, projectId],
		);
		log.info(
			`project ${ref(projectSlug, projectId)} container ${ref(projectSlug, containerId.slice(0, 12))} stopped`,
		);
	} catch (err) {
		const errorMessage = err instanceof Error ? err.message : String(err);
		await db.query(
			`UPDATE projects
			 SET container_status = $1::container_status,
			     container_last_logs = COALESCE($2, container_last_logs),
			     container_error = $3
			 WHERE id = $4`,
			[ContainerStatus.Error, annotatedLogs, errorMessage, projectId],
		);
		exitReason = 'container_error';
		log.warn(
			`project ${ref(projectSlug, projectId)} container ${ref(projectSlug, containerId.slice(0, 12))} stop failed: ${errorMessage}`,
		);
	}

	await failProjectRuns(deps, projectId, projectSlug, teamId, exitReason).catch((e) =>
		log.error('Failed to fail project runs on stop:', e),
	);

	await broadcastProjectUpdate(db, wsManager, teamId, projectId);
}

/**
 * Verify that the container's `/workspace` and `/worktrees` bind mounts are
 * reachable — and that `/worktrees` is writable — from inside. Docker Desktop on
 * macOS can leave a container in a state where it inspects as Running but its bind
 * mounts have gone stale: `docker exec` then fails with "current working directory
 * is outside of container mount namespace root", or a freshly-provisioned mount is
 * present-but-not-yet-writable. A cheap in-container probe catches both, where
 * `inspectContainer` cannot. `/worktrees` is exercised with a create+remove
 * because it is the mount an agent run writes first (its per-task worktree) and
 * the one whose lag surfaces as a spurious worktree-prep failure.
 */
export async function verifyContainerWorkspace(
	docker: DockerClient,
	containerId: string,
): Promise<boolean> {
	try {
		const execId = await docker.execCreate(containerId, {
			Cmd: [
				'sh',
				'-c',
				'ls /workspace && d=/worktrees/.hezo-mount-probe && mkdir -p "$d" && rmdir "$d"',
			],
			AttachStdout: true,
			AttachStderr: true,
		});
		await docker.execStart(execId);
		const info = await docker.execInspect(execId);
		return info.ExitCode === 0;
	} catch {
		return false;
	}
}

export async function rebuildContainer(
	deps: ContainerDeps,
	project: ProjectRow,
	teamSlug: string,
): Promise<string> {
	const { db, docker, logs } = deps;
	beginProvisionStream(logs, project.id);
	const streamId = provisionStreamId(project.id);

	if (project.container_id) {
		log.info(
			`project ${ref(project.slug, project.id)} container ${ref(project.slug, project.container_id.slice(0, 12))} rebuild started`,
		);
		logs?.emit(
			streamId,
			'stdout',
			`→ Removing previous container ${project.container_id.slice(0, 12)}`,
		);
		const lastLogs = await captureContainerLogs(docker, project.container_id, project.slug);
		const annotatedLogs = appendMemoryLine(lastLogs, consumeFinalMemoryLine(project.id));
		if (annotatedLogs) {
			await db.query('UPDATE projects SET container_last_logs = $1 WHERE id = $2', [
				annotatedLogs,
				project.id,
			]);
		}
		if (!keepOldContainersFlag) {
			try {
				await docker.stopContainer(project.container_id);
			} catch {
				// Already stopped
			}
			try {
				await docker.removeContainer(project.container_id, true);
			} catch {
				// Already removed
			}
		}
	} else {
		log.info(`project ${ref(project.slug, project.id)} rebuild started (no previous container)`);
	}

	return provisionContainer(deps, project, teamSlug);
}

export async function syncContainerStatus(
	db: Db,
	docker: DockerClient,
	projectId: string,
	projectSlug: string,
	containerId: string,
	previousStatus?: string | null,
): Promise<string | null> {
	let info: Awaited<ReturnType<DockerClient['inspectContainer']>>;
	try {
		info = await docker.inspectContainer(containerId);
	} catch (err) {
		log.warn(
			`Container sync transport error for project ${ref(projectSlug, projectId)}; will retry`,
			err,
		);
		return null;
	}

	if (info === null) {
		await db.query(
			`UPDATE projects SET container_status = $1::container_status, container_id = NULL,
			     container_error = COALESCE(container_error, $2)
			 WHERE id = $3`,
			[
				ContainerStatus.Error,
				'Container no longer exists in Docker (removed externally).',
				projectId,
			],
		);
		return ContainerStatus.Error;
	}

	const status = info.State.Running ? ContainerStatus.Running : ContainerStatus.Stopped;

	if (previousStatus === ContainerStatus.Running && status !== ContainerStatus.Running) {
		const lastLogs = await captureContainerLogs(docker, containerId, projectSlug);
		const finalMemoryLine = consumeFinalMemoryLine(projectId);
		const annotatedLogs = appendMemoryLine(lastLogs, finalMemoryLine);
		const exitCode = info.State.ExitCode;
		const exitStatus = info.State.Status;
		const errorMessage =
			exitCode && exitCode !== 0
				? `Container exited with code ${exitCode} (${exitStatus}).`
				: `Container stopped (${exitStatus}).`;
		if (finalMemoryLine) {
			log.info(
				`project ${ref(projectSlug, projectId)} container ${ref(projectSlug, containerId.slice(0, 12))} exited; ${finalMemoryLine.replace(/^→ /, '')}`,
			);
		}
		await db.query(
			`UPDATE projects
			 SET container_status = $1::container_status,
			     container_last_logs = COALESCE($2, container_last_logs),
			     container_error = $3
			 WHERE id = $4`,
			[status, annotatedLogs, errorMessage, projectId],
		);
	} else {
		await db.query('UPDATE projects SET container_status = $1::container_status WHERE id = $2', [
			status,
			projectId,
		]);
	}

	return status;
}

/**
 * If the container's working-set memory crosses the per-project memory ceiling
 * (`projects.memory_limit_gib`, default {@link DEFAULT_MEMORY_LIMIT_GIB}), stop
 * it and record an explanatory message in `container_error`. The banner and
 * container page both surface that field. Returns the synthesised status when the
 * container was stopped, or null when it was within budget or stats were unavailable.
 *
 * Failure modes are non-fatal — a transport error on stats or stop must not stop
 * the surrounding sync loop from servicing other projects.
 */
async function enforceContainerMemoryLimit(
	deps: ContainerDeps,
	projectId: string,
	projectSlug: string,
	teamId: string,
	containerId: string,
	memoryLimitGib: number,
): Promise<string | null> {
	const { db, docker } = deps;

	let stats: Awaited<ReturnType<DockerClient['containerStats']>>;
	try {
		stats = await docker.containerStats(containerId);
	} catch (err) {
		log.warn(
			`Container stats transport error for project ${ref(projectSlug, projectId)}; will retry`,
			err,
		);
		return null;
	}
	if (!stats) return null;

	const now = Date.now();
	const prevEntry = memoryUsageState.get(projectId);
	const entry: MemoryUsageEntry = {
		lastLogMs: prevEntry?.lastLogMs ?? 0,
		lastUsedBytes: stats.usedBytes,
		limitGib: memoryLimitGib,
	};
	if (now - entry.lastLogMs >= MEMORY_USAGE_LOG_INTERVAL_MS) {
		entry.lastLogMs = now;
		log.debug(
			`project ${ref(projectSlug, projectId)} container ${ref(projectSlug, containerId.slice(0, 12))} memory: ${formatMemoryLine(entry)}`,
		);
	}
	memoryUsageState.set(projectId, entry);

	const limitBytes = memoryLimitBytes(memoryLimitGib);
	if (stats.usedBytes <= limitBytes) return null;

	const usedGiB = (stats.usedBytes / 1024 ** 3).toFixed(2);
	const errorMessage =
		`Container was using ${usedGiB} GiB of RAM, above the ${memoryLimitGib} GiB safety limit, ` +
		`and was stopped automatically to keep your machine responsive. Restart the container ` +
		`to try again, or raise the limit on the project settings page.`;

	const lastLogs = await captureContainerLogs(docker, containerId, projectSlug);

	try {
		await docker.stopContainer(containerId);
	} catch (err) {
		log.warn(
			`docker.stopContainer failed during memory-limit enforcement for project ${ref(projectSlug, projectId)}; recording error anyway`,
			err,
		);
	}

	await db.query(
		`UPDATE projects
		 SET container_status = $1::container_status,
		     container_last_logs = COALESCE($2, container_last_logs),
		     container_error = $3
		 WHERE id = $4`,
		[ContainerStatus.Error, lastLogs, errorMessage, projectId],
	);

	log.warn(
		`Auto-stopped container ${ref(projectSlug, containerId.slice(0, 12))} for project ${ref(projectSlug, projectId)}: used ${usedGiB} GiB (> ${memoryLimitGib} GiB)`,
	);

	memoryUsageState.delete(projectId);

	await failProjectRuns(deps, projectId, projectSlug, teamId, 'container_error').catch((e) =>
		log.error('Failed to fail project runs after memory-limit stop:', e),
	);

	return ContainerStatus.Error;
}

export async function syncAllContainerStatuses(
	deps: ContainerDeps,
): Promise<ContainerTransition[]> {
	const { db, docker, wsManager } = deps;

	const projects = await db.query<{
		id: string;
		slug: string;
		team_id: string;
		container_id: string;
		container_status: string | null;
		memory_limit_gib: number;
	}>(
		'SELECT id, slug, team_id, container_id, container_status, memory_limit_gib FROM projects WHERE container_id IS NOT NULL',
	);

	const transitions: ContainerTransition[] = [];
	for (const project of projects.rows) {
		const oldStatus = project.container_status;
		let newStatus = await syncContainerStatus(
			db,
			docker,
			project.id,
			project.slug,
			project.container_id,
			oldStatus,
		);

		if (newStatus === ContainerStatus.Running) {
			const overrideStatus = await enforceContainerMemoryLimit(
				deps,
				project.id,
				project.slug,
				project.team_id,
				project.container_id,
				project.memory_limit_gib,
			);
			if (overrideStatus !== null) {
				newStatus = overrideStatus;
			}
		}

		if (newStatus !== null && newStatus !== oldStatus) {
			transitions.push({
				projectId: project.id,
				projectSlug: project.slug,
				teamId: project.team_id,
				oldStatus,
				newStatus,
			});
			await broadcastProjectUpdate(db, wsManager, project.team_id, project.id);
		}
	}

	return transitions;
}

/**
 * Mark all in-flight heartbeat_runs for a project's tasks as failed with the
 * given reason, reset affected agents' runtime_status to idle, release execution
 * locks, and broadcast row changes. Caller is responsible for first aborting any
 * live in-process runs via the JobManager registry.
 */
export async function failProjectRuns(
	deps: ContainerDeps,
	projectId: string,
	projectSlug: string,
	teamId: string,
	reason: ContainerExitReason,
): Promise<void> {
	const { db, wsManager } = deps;

	const failedRuns = await db.query<{ id: string; member_id: string; task_id: string | null }>(
		`UPDATE heartbeat_runs
		 SET status = $1::heartbeat_run_status,
		     finished_at = now(),
		     error = $2,
		     exit_code = -1
		 WHERE status = $3::heartbeat_run_status
		   AND task_id IN (SELECT id FROM tasks WHERE project_id = $4)
		 RETURNING id, member_id, task_id`,
		[HeartbeatRunStatus.Failed, reason, HeartbeatRunStatus.Running, projectId],
	);

	if (failedRuns.rows.length === 0) return;

	const memberIds = Array.from(new Set(failedRuns.rows.map((r) => r.member_id)));

	await db.query(
		`UPDATE execution_locks SET released_at = now()
		 WHERE released_at IS NULL
		   AND task_id IN (SELECT id FROM tasks WHERE project_id = $1)`,
		[projectId],
	);

	for (const run of failedRuns.rows) {
		broadcastRowChange(wsManager, wsRoom.team(teamId), 'heartbeat_runs', 'UPDATE', {
			id: run.id,
			member_id: run.member_id,
			task_id: run.task_id,
			project_id: projectId,
			status: HeartbeatRunStatus.Failed,
			error: reason,
		});
	}

	let idleCount = 0;
	for (const memberId of memberIds) {
		const transitioned = await setAgentIdleIfNoActiveRuns(
			db,
			memberId,
			teamId,
			undefined,
			wsManager,
		);
		if (transitioned) idleCount++;
	}

	log.info(
		`Failed ${failedRuns.rows.length} run(s) in project ${ref(projectSlug, projectId)} due to ${reason}; ${idleCount}/${memberIds.length} agent(s) marked idle`,
	);
}

const REQUEUE_LIMIT = 50;
const REQUEUE_LOOKBACK_HOURS = 24;

/**
 * After a container is brought back to running, enqueue wakeups for any runs
 * that were killed by a `container_error` and have not been retried since.
 * Runs killed via a graceful `container_stopped` are intentionally skipped.
 */
export async function requeueContainerKilledRuns(
	deps: ContainerDeps,
	projectId: string,
	projectSlug: string,
	teamId: string,
): Promise<number> {
	const { db } = deps;

	const killed = await db.query<{
		id: string;
		member_id: string;
		task_id: string;
	}>(
		`SELECT DISTINCT ON (member_id, task_id) id, member_id, task_id
		 FROM heartbeat_runs
		 WHERE task_id IN (SELECT id FROM tasks WHERE project_id = $1)
		   AND error = $2
		   AND finished_at > now() - ($3 || ' hours')::interval
		   AND NOT EXISTS (
		     SELECT 1 FROM heartbeat_runs h2
		     WHERE h2.member_id = heartbeat_runs.member_id
		       AND h2.task_id = heartbeat_runs.task_id
		       AND h2.started_at > heartbeat_runs.finished_at
		   )
		 ORDER BY member_id, task_id, finished_at DESC
		 LIMIT $4`,
		[projectId, 'container_error', String(REQUEUE_LOOKBACK_HOURS), REQUEUE_LIMIT],
	);

	for (const run of killed.rows) {
		await createWakeup(db, run.member_id, teamId, WakeupSource.Timer, {
			reason: 'container_recovery',
			task_id: run.task_id,
			previous_run_id: run.id,
		});
	}

	if (killed.rows.length > 0) {
		log.info(
			`Re-queued ${killed.rows.length} container-killed run(s) in project ${ref(projectSlug, projectId)} after container recovery`,
		);
	}

	return killed.rows.length;
}

/**
 * Queue a wakeup for every enabled agent that has a non-terminal task assigned
 * in this project. Used after a container transitions to running (initial
 * provision, start, rebuild) so pending work is picked up promptly instead of
 * waiting for the next scheduled heartbeat.
 */
export async function wakeAgentsWithPendingWork(
	db: Db,
	projectId: string,
	teamId: string,
): Promise<void> {
	const { placeholders, values } = terminalStatusParams(3);
	const pending = await db.query<{ agent_id: string }>(
		`SELECT DISTINCT i.assignee_id AS agent_id
		 FROM tasks i
		 JOIN member_agents ma ON ma.id = i.assignee_id
		 WHERE i.project_id = $1 AND i.team_id = $2
		   AND i.status NOT IN (${placeholders})
		   AND ma.admin_status = 'enabled'`,
		[projectId, teamId, ...values],
	);
	for (const row of pending.rows) {
		trackBackground(
			createWakeup(db, row.agent_id, teamId, WakeupSource.Automation, {
				trigger: 'container_start',
				project_id: projectId,
			}).catch((e) => log.error('Failed to create wakeup on container start:', e)),
		);
	}
}

async function allocateHostPorts(
	db: Db,
	devPorts: Array<{ container: number; host?: number }>,
	projectId: string,
): Promise<Array<{ container: number; host: number }>> {
	if (devPorts.length === 0) return [];

	const usedResult = await db.query<{ dev_ports: Array<{ host: number }> }>(
		"SELECT dev_ports FROM projects WHERE id != $1 AND dev_ports != '[]'::jsonb",
		[projectId],
	);

	const usedPorts = new Set<number>();
	for (const row of usedResult.rows) {
		for (const p of row.dev_ports || []) {
			if (p.host) usedPorts.add(p.host);
		}
	}

	let nextPort = PORT_POOL_START;

	return devPorts.map((p) => {
		if (p.host && !usedPorts.has(p.host)) {
			usedPorts.add(p.host);
			return { container: p.container, host: p.host };
		}
		while (usedPorts.has(nextPort) && nextPort <= PORT_POOL_END) {
			nextPort++;
		}
		const host = nextPort++;
		usedPorts.add(host);
		return { container: p.container, host };
	});
}

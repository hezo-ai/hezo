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
import { forEachConcurrent } from '../lib/concurrency';
import { withKeyedLock } from '../lib/keyed-lock';
import { ref } from '../lib/log-ref';
import { stripNulBytes, terminalStatusParams } from '../lib/sql';
import { getDefaultRamCapPerContainerGb, getProjectContainerDiskGb } from '../lib/system-meta';
import { logger } from '../logger';
import { setAgentIdleIfNoActiveRuns } from './agent-runtime-status';
import type { ContainerLogStreamer } from './container-logs';
import {
	chownToRunUser,
	clearContainerRunUserCache,
	resolveContainerRunUser,
} from './container-user';
import type { ContainerEngine } from './docker';
import { ensureImage } from './ensure-image';
import { ContainerGitExecutor, mintGitOpScopeId } from './git-executor';
import { resolveAgentBaseImage } from './image-registry';
import type { LogStreamBroker } from './log-stream-broker';
import { ensureProjectRepos } from './repo-sync';
import { getActiveContainers, projectContainerMemoryGb } from './run-concurrency';
import { DOCKER_HOST_GATEWAY_ENTRY } from './sandbox/endpoints';
import { INSTANCE_LABEL } from './sandbox/orphan-reaper';
import {
	claimPoolMember,
	decidePoolAcquisition,
	listPoolContainerIds,
	listPoolMembersForReconcile,
	releasePoolMember,
	removePoolMember,
	setPoolMemberState,
	upsertPoolMember,
} from './sandbox/pool-db';
import { type BridgeRunnerArgs, type SshAgentServer, withProvisionBridge } from './ssh-agent';
import { getOrCreateInstanceId } from './telemetry';
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

/**
 * Serializes container lifecycle *decisions* per project: ensure-running
 * (start/provision at run or chat start) and the idle-stop cron's
 * check-then-stop. Without it, two runs dispatching into the same stopped
 * project could both provision (two containers, one orphaned), and idle-stop
 * could stop a container between a dispatch's capacity check and its exec.
 * Never held across an agent exec — only across the brief inspect/start/
 * provision/stop step — so it is not a throughput ceiling on runs themselves.
 * Keyed by project id; in-process only (single-server assumption).
 */
const containerLifecycleLocks = new Map<string, Promise<unknown>>();
export function withContainerLifecycleLock<T>(projectId: string, fn: () => Promise<T>): Promise<T> {
	return withKeyedLock(containerLifecycleLocks, projectId, fn);
}

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
	docker: ContainerEngine;
	dataDir: string;
	wsManager?: WebSocketManager;
	masterKeyManager?: MasterKeyManager;
	logs?: LogStreamBroker;
	containerLogStreamer?: ContainerLogStreamer;
	sshAgentServer?: SshAgentServer | null;
	egressCAPath?: string | null;
	/** Test seam: override host egress-MTU detection. Defaults to the real probe. */
	detectEgressMtu?: () => Promise<number | null>;
	/**
	 * How often a running container's working-set memory is sampled, in ms.
	 * Defaults to {@link MEMORY_CHECK_INTERVAL_MS}. Tests set 0 to check on
	 * every pass.
	 */
	memoryCheckIntervalMs?: number;
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

// The per-container working-set ceiling is the instance-wide
// `default_ram_cap_per_container_gb` setting (system_meta, default 2GB),
// overridable per project via `projects.memory_limit_gib` (NULL = inherit).
// The old hardcoded 16GiB default was a no-op on small hosts — 8x physical
// RAM on a 2GB VPS — so a runaway in-container process triggered a *global*
// OOM kill instead of a contained cgroup one.

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
	lastMemoryCheckAt.delete(projectId);
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
	docker: ContainerEngine,
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
			// Names the instance that created it, so the orphan sweep can never
			// destroy another instance's containers - several Hezo instances can
			// share one managed-backend account.
			[INSTANCE_LABEL]: await getOrCreateInstanceId(deps.db),
		};
		// Mark containers spawned by a test run so the test harness's cleanup can scope
		// itself to them and never delete a developer's live dev-server containers.
		if (process.env[TEST_CONTAINERS_ENV] === '1') {
			containerLabels[TEST_CONTAINER_LABEL_KEY] = TEST_CONTAINER_LABEL_VALUE;
		}
		// Not how the container reaches Hezo - that is its tunnel, on every
		// backend. This survives for one unrelated case: an operator can point a
		// local model provider at their own machine
		// (`http://host.docker.internal:11434` for Ollama), which the container
		// dials directly like any other model-provider endpoint.
		const extraHosts = [DOCKER_HOST_GATEWAY_ENTRY];

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
		const limitRow = await db.query<{ memory_limit_gib: number | null }>(
			'SELECT memory_limit_gib FROM projects WHERE id = $1',
			[project.id],
		);
		const memoryLimitGib =
			limitRow.rows[0]?.memory_limit_gib ?? (await getDefaultRamCapPerContainerGb(db));
		const memoryHardCapBytes = memoryLimitBytes(memoryLimitGib) + MEMORY_HARD_CAP_HEADROOM_BYTES;
		// Same precedence as the memory cap: the project's override, else the
		// instance default. Stated on every backend; what it means is the engine's
		// to absorb (see ContainerConfig.HostConfig.DiskGb).
		const diskGb = await getProjectContainerDiskGb(db, project.id);

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
				DiskGb: diskGb,
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
			`UPDATE projects
			 SET container_id = $1, container_status = $2::container_status,
			     container_error = NULL, container_last_started_at = now()
			 WHERE id = $3`,
			[Id, ContainerStatus.Running, project.id],
		);
		// Join the project's pool. Registered here rather than at create so a member
		// never exists in a state no run could use, and registered for every
		// container - `projects.container_id` still names one of them for the UI and
		// for the columns not yet migrated, but the pool is what the ladder reads.
		// The disk it was actually provisioned with rides along, so the pool judges
		// this container against its own allocation rather than against whatever the
		// setting happens to say later.
		await upsertPoolMember(db, project.id, Id, 'idle', diskGb);

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
						{ engine: docker, containerId: Id, teamId, dataDir, runUser },
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
	// The whole inspect→start/provision step runs under the per-project lifecycle
	// lock so every caller (agent runner, chat session, repo provisioning) is
	// covered without call-site changes: concurrent ensures serialize, and the
	// second caller sees a running container instead of double-provisioning.
	return withContainerLifecycleLock(projectId, async () => {
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
			if (info?.State.Running) {
				// Docker is the truth; if the row lags (e.g. an out-of-band start),
				// reconcile it and stamp the start floor so the idle-stop cron can
				// see — and eventually reclaim — this container.
				if (proj.container_status !== ContainerStatus.Running) {
					await db.query(
						`UPDATE projects
						 SET container_status = $1::container_status, container_error = NULL,
						     container_last_started_at = now()
						 WHERE id = $2`,
						[ContainerStatus.Running, proj.id],
					);
					await broadcastProjectUpdate(db, deps.wsManager, proj.team_id, proj.id);
				}
				return proj.container_id;
			}
			if (info) {
				// Container exists but is stopped — start it in place.
				await docker.startContainer(proj.container_id);
				await db.query(
					`UPDATE projects
					 SET container_status = $1::container_status, container_error = NULL,
					     container_last_started_at = now()
					 WHERE id = $2`,
					[ContainerStatus.Running, proj.id],
				);
				if (deps.containerLogStreamer && deps.logs) {
					deps.containerLogStreamer.subscribe(proj.id, proj.container_id, deps.logs, docker);
				}
				await broadcastProjectUpdate(db, deps.wsManager, proj.team_id, proj.id);
				log.info(
					`project ${ref(proj.slug, proj.id)} container ${ref(proj.slug, proj.container_id.slice(0, 12))} started on demand`,
				);
				return proj.container_id;
			}
		}

		// No container id, or the stored id no longer exists in Docker — provision.
		return provisionContainer(deps, proj, proj.team_slug);
	});
}

/**
 * Thrown when the pool has nothing to give and the cap forbids another container.
 *
 * A distinct error rather than a null return: the dispatcher already refuses to
 * start a run it has no capacity for (`isContainerCapacityBlockedInDb`), so
 * reaching here means capacity was taken between that check and this acquire.
 * The run is requeued rather than failed.
 */
export class PoolCapacityError extends Error {
	constructor(projectId: string) {
		super(
			`no container available for project ${projectId} and its next container ` +
				`does not fit the instance memory budget`,
		);
		this.name = 'PoolCapacityError';
	}
}

/** A container claimed for one run, and the handle that gives it back. */
export interface AcquiredContainer {
	containerId: string;
	/** Idempotent. Returns the container to the pool as idle, recording task affinity. */
	release(): Promise<void>;
}

/**
 * Claim a container for one run.
 *
 * This is where the pool stops being a table and starts being the thing that
 * decides blast radius: a container serves **at most one run at a time**, so a
 * run that exceeds the memory cap can only take itself down, never every sibling
 * run in its project the way one shared container did.
 *
 * The ladder itself lives in `selectPoolMember` and is pure. What happens here is
 * the part that cannot be: turning a decision into a claim, under the
 * per-project lifecycle lock, and re-deciding if another acquire won the race for
 * the same member.
 */
export async function acquireRunContainer(
	deps: ContainerDeps,
	projectId: string,
	taskId: string | null,
): Promise<AcquiredContainer> {
	const { db, docker } = deps;
	const containerId = await withContainerLifecycleLock(projectId, async () => {
		// Adopt a container the project already names but the pool has no row for.
		// `projects.container_*` stays authoritative until every lifecycle call site
		// has moved over (migration 049 is additive), so during that window a live
		// container can be recorded in one place and not the other. Reading only the
		// pool would provision a second container beside a perfectly good one -
		// which is not a fallback path but the two representations of one container
		// being reconciled, the same UNION `getActiveContainers` already does.
		await adoptUnpooledContainer(deps, projectId);
		// Bounded: each iteration either claims a member or removes one from
		// contention (a lost race retries against a pool one member smaller), so
		// this cannot spin. The cap is the pool's own size, not a timeout.
		for (let attempt = 0; attempt < MAX_ACQUIRE_ATTEMPTS; attempt++) {
			const [active, requestMemoryGb] = await Promise.all([
				getActiveContainers(db, deps.docker),
				projectContainerMemoryGb(db, projectId),
			]);
			const decision = await decidePoolAcquisition(db, projectId, taskId, {
				usedMemoryGb: active.usedMemoryGb,
				budgetGb: active.budgetGb,
				requestMemoryGb,
			});

			if (decision.kind === 'queue') throw new PoolCapacityError(projectId);

			if (decision.kind === 'create') {
				const proj = await loadProjectRow(db, projectId);
				const id = await provisionContainer(deps, proj, proj.team_slug);
				if (await claimPoolMember(db, id, taskId)) return id;
				continue;
			}

			const member = decision.member;
			if (decision.kind === 'reuse') {
				// Trusting the row is not enough: a container can be removed out from
				// under Hezo (an operator, a daemon restart, a provider reaping a
				// sandbox), and handing a run an id the engine no longer knows fails
				// it on the first exec with nothing pointing at the cause. Verify,
				// then drop and re-decide - which is how a stale member gets repaired.
				const info = await docker.inspectContainer(member.id).catch(() => null);
				if (!info?.State.Running) {
					await removePoolMember(db, member.id);
					continue;
				}
			}
			if (decision.kind === 'resume') {
				// Resume is a start in place: the writable layer is intact, so the
				// clones and worktrees this container already built are still there.
				try {
					await docker.startContainer(member.id);
				} catch {
					// The container is gone from under the row. Drop it and re-decide
					// rather than handing a run an id the engine no longer knows.
					await removePoolMember(db, member.id);
					continue;
				}
				await setPoolMemberState(db, member.id, 'idle');
				await markProjectContainerStarted(deps, projectId, member.id);
			}
			if (await claimPoolMember(db, member.id, taskId)) return member.id;
		}
		throw new PoolCapacityError(projectId);
	});

	let released = false;
	return {
		containerId,
		release: async () => {
			if (released) return;
			released = true;
			await releasePoolMember(db, containerId, taskId).catch(() => undefined);
		},
	};
}

/** See {@link acquireRunContainer} - the loop is bounded by contention, not by time. */
const MAX_ACQUIRE_ATTEMPTS = 8;

/**
 * Reflect a resume on the project row, which is what the Container page reads.
 *
 * `projects.container_*` is still the surface an operator sees, so a container
 * the pool resumed has to stop reading as stopped there - and the log stream has
 * to be resubscribed, since the old one died with the container.
 */
async function markProjectContainerStarted(
	deps: ContainerDeps,
	projectId: string,
	containerId: string,
): Promise<void> {
	const { db, docker } = deps;
	const res = await db.query<{ team_id: string; slug: string }>(
		`UPDATE projects
		    SET container_id = $2,
		        container_status = $3::container_status,
		        container_error = NULL,
		        container_last_started_at = now()
		  WHERE id = $1
		 RETURNING team_id, slug`,
		[projectId, containerId, ContainerStatus.Running],
	);
	const row = res.rows[0];
	if (!row) return;
	if (deps.containerLogStreamer && deps.logs) {
		deps.containerLogStreamer.subscribe(projectId, containerId, deps.logs, docker);
	}
	await broadcastProjectUpdate(db, deps.wsManager, row.team_id, projectId);
}

/**
 * Register `projects.container_id` as a pool member when it is live and unpooled.
 *
 * Only when the engine agrees it is running: a stale row naming a container that
 * no longer exists must fall through to provisioning, which is what repairs it.
 */
async function adoptUnpooledContainer(deps: ContainerDeps, projectId: string): Promise<void> {
	const { db, docker } = deps;
	const res = await db.query<{ container_id: string | null }>(
		`SELECT p.container_id FROM projects p
		  WHERE p.id = $1
		    AND p.container_id IS NOT NULL
		    AND NOT EXISTS (
		      SELECT 1 FROM container_pool_members m WHERE m.container_id = p.container_id
		    )`,
		[projectId],
	);
	const containerId = res.rows[0]?.container_id;
	if (!containerId) return;
	const info = await docker.inspectContainer(containerId).catch(() => null);
	// A stale row naming a container the engine no longer knows is left alone, so
	// the decision falls through to provisioning - which is what repairs it.
	if (!info) return;
	await upsertPoolMember(db, projectId, containerId, info.State.Running ? 'idle' : 'suspended');
}

async function loadProjectRow(
	db: Db,
	projectId: string,
): Promise<ProjectRow & { team_slug: string }> {
	const res = await db.query<ProjectRow & { team_slug: string }>(
		`SELECT p.id, p.team_id, p.slug, p.docker_base_image, p.container_id, p.container_status,
		        p.dev_ports, c.slug AS team_slug
		 FROM projects p JOIN teams c ON c.id = p.team_id
		 WHERE p.id = $1`,
		[projectId],
	);
	const proj = res.rows[0];
	if (!proj) throw new Error('Project not found');
	return proj;
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

	// Every member, not just the one `projects.container_id` names: a project can
	// hold several, and one left behind is a container nothing references and
	// nobody stops - free to ignore on a local daemon, billed for on a managed
	// backend until someone notices.
	const poolIds = await listPoolContainerIds(db, projectId);
	const teardownContainerId = result.rows[0]?.container_id;
	const toRemove = new Set(poolIds);
	if (teardownContainerId) toRemove.add(teardownContainerId);
	if (!keepOldContainersFlag) {
		for (const id of toRemove) {
			try {
				await docker.stopContainer(id);
			} catch {
				// Container may already be stopped
			}
			try {
				await docker.removeContainer(id, true);
			} catch {
				// Container may already be removed
			}
		}
	}
	for (const id of toRemove) await removePoolMember(db, id);

	await db.query('UPDATE projects SET container_id = NULL, container_status = NULL WHERE id = $1', [
		projectId,
	]);

	removeProjectWorkspace(dataDir, teamId, projectId);
	memoryUsageState.delete(projectId);
	lastMemoryCheckAt.delete(projectId);

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
		// A stopped container is a *suspended* pool member: it still exists and its
		// filesystem is intact, but it is not running. Recording that here rather
		// than at each caller is what stops the ladder from handing a run a
		// container that is not up - the two representations of one container have
		// to move together or the pool reads stale.
		await setPoolMemberState(db, containerId, 'suspended');
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
 * Activity that holds a project's container up, shared by the idle-stop cron's
 * candidate scan and its under-lock recheck. Evaluated activity-side so an idle
 * instance's cost tracks activity inside the window, not table history. A
 * project is busy when it has: an active (queued/running) run; a run finished
 * inside the idle window (idx_runs_finished); a queued wakeup that could
 * actually dispatch — capacity-skipped wakeups deliberately do NOT hold a
 * container, else a backlog waiting on the container cap would pin containers
 * warm forever ('project_at_capacity' is the pre-rename legacy value, re-stamped
 * within seconds of an upgrade); or a live chat session with recent activity or
 * an in-flight (pending/streaming) turn (idx_chat_messages_inflight).
 * `$1` is the idle window in minutes everywhere.
 */
const UUID_RE = '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$';
const BUSY_PROJECTS_SQL = `
	SELECT DISTINCT t.project_id FROM heartbeat_runs hr
	 JOIN tasks t ON t.id = hr.task_id
	 WHERE hr.status IN ('queued', 'running')
	UNION
	SELECT DISTINCT t.project_id FROM heartbeat_runs hr
	 JOIN tasks t ON t.id = hr.task_id
	 WHERE hr.finished_at > now() - ($1 * interval '1 minute')
	UNION
	SELECT DISTINCT t.project_id FROM agent_wakeup_requests w
	 JOIN tasks t ON t.id = (w.payload->>'task_id')::uuid
	 WHERE w.status = 'queued'
	   AND w.payload->>'task_id' ~ '${UUID_RE}'
	   AND (w.last_skipped_reason IS NULL
	     OR w.last_skipped_reason NOT IN ('instance_at_capacity', 'project_at_capacity'))
	UNION
	SELECT DISTINCT (w.payload->>'project_id')::uuid AS project_id FROM agent_wakeup_requests w
	 WHERE w.status = 'queued'
	   AND w.payload->>'project_id' ~ '${UUID_RE}'
	   AND (w.last_skipped_reason IS NULL
	     OR w.last_skipped_reason NOT IN ('instance_at_capacity', 'project_at_capacity'))
	UNION
	SELECT cs.project_id FROM chat_sessions cs
	 WHERE cs.status IN ('starting', 'running')
	   AND (cs.last_activity_at > now() - ($1 * interval '1 minute')
	     OR EXISTS (SELECT 1 FROM chat_messages cm
	                WHERE cm.session_id = cs.id AND cm.status IN ('pending', 'streaming')))
`;

/**
 * The per-candidate predicate the idle-stop cron applies: container running,
 * up for at least one full idle window (the start-time floor — a manual start
 * or fresh provision is never stopped early; NULL-started rows never match, so
 * they are never idle-stopped), and no busy signal. `extraSql` narrows to one
 * project for the under-lock recheck.
 */
const IDLE_CANDIDATE_SQL = (extraSql: string, limitSql: string) => `
	WITH busy AS (${BUSY_PROJECTS_SQL})
	SELECT p.id, p.slug, p.team_id, p.container_id
	FROM projects p
	WHERE p.container_status = 'running'::container_status
	  AND p.container_id IS NOT NULL
	  AND p.container_last_started_at IS NOT NULL
	  AND p.container_last_started_at < now() - ($1 * interval '1 minute')
	  AND p.id NOT IN (SELECT project_id FROM busy)
	  ${extraSql}
	${limitSql}
`;

export interface IdleContainerCandidate {
	id: string;
	slug: string;
	team_id: string;
	container_id: string;
}

/** Projects whose running container has been idle past the timeout. */
export async function findIdleContainerCandidates(
	db: Db,
	timeoutMin: number,
	limit: number,
): Promise<IdleContainerCandidate[]> {
	const res = await db.query<IdleContainerCandidate>(IDLE_CANDIDATE_SQL('', 'LIMIT $2'), [
		timeoutMin,
		limit,
	]);
	return res.rows;
}

/**
 * Re-verify one candidate immediately before stopping it (run under the
 * project's lifecycle lock, after the caller's in-memory checks).
 */
export async function isProjectIdleForContainerStop(
	db: Db,
	projectId: string,
	timeoutMin: number,
): Promise<boolean> {
	const res = await db.query(IDLE_CANDIDATE_SQL('AND p.id = $2', 'LIMIT 1'), [
		timeoutMin,
		projectId,
	]);
	return res.rows.length > 0;
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
	docker: ContainerEngine,
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
	docker: ContainerEngine,
	projectId: string,
	projectSlug: string,
	containerId: string,
	previousStatus?: string | null,
): Promise<string | null> {
	let info: Awaited<ReturnType<ContainerEngine['inspectContainer']>>;
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
		// Only write on an actual transition. This runs for every project with a
		// container on every sync tick, and `projects` carries `container_last_logs`
		// — so an unconditional rewrite of an unchanged row produced a dead tuple
		// per project per tick, with no autovacuum on the embedded backend to
		// reclaim them. Same write-amplification shape the run-log chunk table
		// fixed, in a different table.
		await db.query(
			`UPDATE projects SET container_status = $1::container_status
			 WHERE id = $2 AND container_status IS DISTINCT FROM $1::container_status`,
			[status, projectId],
		);
	}

	return status;
}

/**
 * If the container's working-set memory crosses its effective memory ceiling
 * (`projects.memory_limit_gib` override, else the instance-wide ram cap), stop
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

	let stats: Awaited<ReturnType<ContainerEngine['containerStats']>>;
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
	lastMemoryCheckAt.delete(projectId);

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
		memory_limit_gib: number | null;
	}>(
		'SELECT id, slug, team_id, container_id, container_status, memory_limit_gib FROM projects WHERE container_id IS NOT NULL',
	);

	// Effective per-container ceiling: the project override, else the
	// instance-wide default — read once per pass, not once per project.
	const defaultRamCapGib = await getDefaultRamCapPerContainerGb(db);

	const transitions: ContainerTransition[] = [];
	const now = Date.now();

	// Liveness runs every tick; the memory check does not. `containerStats` is
	// the expensive call, and a container's working set does not meaningfully
	// change inside a second — polling it at 1Hz per project put a serial fan-out
	// of Docker round trips on the same socket the live exec streams use, which
	// is what made a tick overrun its period once a handful of projects existed.
	const projectsToSync = projects.rows;
	await forEachConcurrent(projectsToSync, CONTAINER_SYNC_CONCURRENCY, async (project) => {
		const oldStatus = project.container_status;
		let newStatus = await syncContainerStatus(
			db,
			docker,
			project.id,
			project.slug,
			project.container_id,
			oldStatus,
		);

		if (
			newStatus === ContainerStatus.Running &&
			dueForMemoryCheck(project.id, now, deps.memoryCheckIntervalMs)
		) {
			const overrideStatus = await enforceContainerMemoryLimit(
				deps,
				project.id,
				project.slug,
				project.team_id,
				project.container_id,
				project.memory_limit_gib ?? defaultRamCapGib,
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
	});

	return transitions;
}

/** Projects checked in parallel per sync pass — enough to keep the pass short without burying the Docker socket. */
const CONTAINER_SYNC_CONCURRENCY = 4;

/** How often a running container's working-set memory is sampled. */
const MEMORY_CHECK_INTERVAL_MS = 15_000;

const lastMemoryCheckAt = new Map<string, number>();

function dueForMemoryCheck(projectId: string, now: number, intervalMs?: number): boolean {
	const interval = intervalMs ?? MEMORY_CHECK_INTERVAL_MS;
	const last = lastMemoryCheckAt.get(projectId) ?? 0;
	if (now - last < interval) return false;
	lastMemoryCheckAt.set(projectId, now);
	return true;
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

/**
 * How stale a pool member must be before it is checked, and how many are checked
 * per pass. The floor keeps a just-created container from being judged missing
 * before the provider can answer for it; the bound keeps a large pool from
 * turning one tick into a fan-out of engine round trips.
 */
const POOL_RECONCILE_MIN_AGE_SECONDS = 60;
const POOL_RECONCILE_LIMIT = 50;

/**
 * Drop pool members whose container no longer exists.
 *
 * The acquire path repairs a stale member on two rungs - `reuse` verifies the
 * container still runs, `resume` drops it if the start throws - but both only
 * fire for a member the ladder actually **picks**, and the ladder never picks a
 * `busy` one. A run that died without releasing its row therefore leaves a
 * member nothing ever revisits. That is not merely untidy: `getActiveContainers`
 * counts `creating`/`idle`/`busy` members towards the instance memory budget, so
 * each orphan permanently consumes capacity, and enough of them make every run
 * in the project fail admission with "no container available".
 *
 * This matters more on a managed backend than on a local daemon, because there a
 * container disappearing is normal rather than anomalous - the provider stops,
 * archives or reaps sandboxes on its own schedule and enforces quota by refusing
 * or removing them.
 *
 * **A member is dropped only on a definite answer.** `inspectContainer` returns
 * null for a container the engine does not know; anything else - a timeout, an
 * unreachable API - throws, and a throw means "could not determine", which
 * leaves the row exactly as it was. Treating an unanswerable check as "gone"
 * would delete the record of a live container and orphan it on the backend,
 * which is the strictly worse failure.
 */
export async function reconcilePoolMembers(deps: ContainerDeps): Promise<number> {
	const { db, docker } = deps;
	const stale = await listPoolMembersForReconcile(
		db,
		POOL_RECONCILE_MIN_AGE_SECONDS,
		POOL_RECONCILE_LIMIT,
	);
	if (stale.length === 0) return 0;

	let dropped = 0;
	for (const member of stale) {
		let info: Awaited<ReturnType<ContainerEngine['inspectContainer']>>;
		try {
			info = await docker.inspectContainer(member.containerId);
		} catch {
			continue;
		}
		if (info !== null) continue;
		await removePoolMember(db, member.containerId);
		dropped++;
		log.info(
			`pool member ${member.containerId.slice(0, 12)} (${member.state}) no longer exists on the backend — dropped`,
		);
	}
	return dropped;
}

import { execFile } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
	CHAT_IDLE_TIMEOUT_MIN,
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
import { type ContainerLogStreamer, containerStreamId } from './container-logs';
import {
	chownToRunUser,
	clearContainerRunUserCache,
	resolveContainerRunUser,
} from './container-user';
import type { ContainerEngine } from './docker';
import type { EgressProxy } from './egress';
import { ensureImage } from './ensure-image';
import { ContainerGitExecutor, mintGitOpScopeId } from './git-executor';
import { resolveAgentBaseImage } from './image-registry';
import type { LogStreamBroker } from './log-stream-broker';
import { ensureProjectRepos } from './repo-sync';
import { getActiveContainers, projectContainerMemoryGb } from './run-concurrency';
import { DOCKER_HOST_GATEWAY_ENTRY } from './sandbox/endpoints';
import { INSTANCE_LABEL, PROJECT_LABEL, TEAM_LABEL } from './sandbox/labels';
import {
	claimPoolMember,
	clearProjectContainerIfNamed,
	decidePoolAcquisition,
	listPoolContainerIds,
	listPoolMembersForReconcile,
	loadPoolMembers,
	releasePoolMember,
	removePoolMember,
	setPoolMemberChatReservation,
	setPoolMemberOutcome,
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
	/**
	 * Substitutes the credential placeholder in a provisioning clone's remote.
	 * Required for a private repo to clone at all - see `withProvisionBridge`.
	 */
	egressProxy?: EgressProxy | null;
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

/**
 * In-container path the egress CA is written to.
 *
 * Split into its directory and filename because the file seam is rooted on a
 * directory, and derived from the one constant so the two can never disagree -
 * `NODE_EXTRA_CA_CERTS` names the full path while the write names the parts.
 */
export const CONTAINER_CA_PATH = '/usr/local/share/ca-certificates/hezo-egress.crt';
export const CONTAINER_CA_DIR = CONTAINER_CA_PATH.slice(0, CONTAINER_CA_PATH.lastIndexOf('/'));
export const CONTAINER_CA_FILENAME = CONTAINER_CA_PATH.slice(
	CONTAINER_CA_PATH.lastIndexOf('/') + 1,
);

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

/** Human-readable elapsed time for a provision, e.g. `58.2s`. */
function elapsedSeconds(startedAt: number): string {
	return `${((Date.now() - startedAt) / 1000).toFixed(1)}s`;
}

/**
 * Provisioning output, streamed to the container it is bringing up.
 *
 * **Keyed on the container, which does not exist yet when provisioning starts.**
 * The stream therefore opens only once the engine has returned an id, and the
 * lines emitted before that - workspace preparation, and waiting on the shared
 * base image - are buffered and flushed into it (see `bufferedEmit` in
 * `provisionContainer`). Nothing is dropped, and nothing is attributed to a
 * project rather than to the container an operator is actually looking at.
 *
 * The alternative, a project-keyed stream, is what this replaced: a project
 * holds as many containers as it has concurrent runs, so their provisioning
 * output interleaved into one stream and was shown as whichever container the
 * page happened to be displaying.
 *
 * It opens **the** container stream ({@link containerStreamId}), not a
 * provisioning-only one beside it - see that function for why two streams in one
 * room silently erased each other.
 */
function beginProvisionStream(
	logs: LogStreamBroker | undefined,
	projectId: string,
	containerId: string,
): void {
	if (!logs) return;
	logs.begin({
		streamId: containerStreamId(containerId),
		room: wsRoom.containerLogs(containerId),
		buildMessage: (line) => ({
			type: WsMessageType.ContainerLog,
			containerId,
			projectId,
			stream: line.stream,
			text: line.text,
		}),
		buildSnapshot: (text, trimmed) => ({
			type: WsMessageType.ContainerLog,
			containerId,
			projectId,
			stream: 'stdout',
			text,
			replace: true,
			trimmed,
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

	// Measured from the moment the project goes `creating`, which is also when the
	// Containers page starts showing it as Starting - so "how long did that take?"
	// is answerable from the log rather than inferred from the gap between two
	// unrelated lines.
	const provisionStartedAt = Date.now();
	await db.query('UPDATE projects SET container_status = $1::container_status WHERE id = $2', [
		ContainerStatus.Creating,
		project.id,
	]);
	// Broadcast the creating transition so the web banner shows for provisions that
	// don't go through the rebuild route (startup repair, self-heal, reprovision).
	await broadcastProjectUpdate(db, wsManager, teamId, project.id);

	// Held until the engine hands back an id, then flushed into that container's
	// stream. Bounded by the provisioning sequence itself (a couple of dozen
	// lines) rather than by anything an agent controls.
	const preContainer: Array<{ stream: 'stdout' | 'stderr'; text: string }> = [];
	let streamId: string | null = null;
	// The id the engine handed back, readable from the catch below - where the
	// `const` from the try block is out of scope. Null means the failure landed
	// before any container existed, so there is nothing to mark or to show.
	let createdContainerId: string | null = null;
	const emit = (stream: 'stdout' | 'stderr', text: string) => {
		if (streamId === null) {
			preContainer.push({ stream, text });
			return;
		}
		logs?.emit(streamId, stream, text);
	};
	const openStream = (containerId: string) => {
		beginProvisionStream(logs, project.id, containerId);
		streamId = containerStreamId(containerId);
		createdContainerId = containerId;
		for (const line of preContainer) logs?.emit(streamId, line.stream, line.text);
		preContainer.length = 0;
	};

	try {
		emit('stdout', `→ Preparing workspace for ${teamSlug}/${project.slug}`);
		const projectDir = ensureProjectWorkspace(dataDir, project.team_id, project.id);
		const workspacePath = join(projectDir, 'workspace');
		const worktreesPath = join(projectDir, 'worktrees');
		const previewsPath = join(projectDir, '.previews');

		// Assets are deliberately NOT mounted: blobs live in the configured asset
		// store (local dir or S3-compatible bucket) and agents fetch them over
		// signed download URLs from the asset tools, never the filesystem.
		// The egress CA is deliberately NOT here. It used to ride in as a
		// `<host file>:<container file>` bind, which is a Docker primitive: a
		// managed backend has no host to bind *from*, and Daytona's adapter -
		// which can only render a bind as a directory to create - resolved it to
		// `mkdir -p /usr/local/share/ca-certificates` and dropped the file. The
		// result was a container where `NODE_EXTRA_CA_CERTS` named a path that did
		// not exist and `update-ca-certificates` installed nothing, so every TLS
		// call through the proxy failed on an unknown issuer. It is written
		// through `SandboxFiles` below instead - one path, both backends.
		const binds = [
			`${workspacePath}:/workspace:rw`,
			`${worktreesPath}:/worktrees:rw`,
			`${previewsPath}:/workspace/.previews:rw`,
		];

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
			[INSTANCE_LABEL]: await getOrCreateInstanceId(deps.db, dataDir),
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

		// The project's working-set ceiling, stated as itself. The sync-loop stats
		// poller is the graceful early-stop at exactly this figure; whether a margin
		// sits above it, and how big, is the engine's business - see
		// `ContainerConfig.HostConfig.Memory` and `MEMORY_HARD_CAP_HEADROOM_BYTES`.
		const limitRow = await db.query<{ memory_limit_gib: number | null }>(
			'SELECT memory_limit_gib FROM projects WHERE id = $1',
			[project.id],
		);
		const memoryLimitGib =
			limitRow.rows[0]?.memory_limit_gib ?? (await getDefaultRamCapPerContainerGb(db));
		const memoryCeilingBytes = memoryLimitBytes(memoryLimitGib);
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
				Memory: memoryCeilingBytes,
				MemorySwap: memoryCeilingBytes,
				DiskGb: diskGb,
				PidsLimit: CONTAINER_PIDS_LIMIT,
				CapDrop: ['ALL'],
				CapAdd: [...CONTAINER_BASE_CAPABILITIES, ...(pinMtu !== null ? ['NET_ADMIN'] : [])],
			},
			ExposedPorts: exposedPorts,
		});

		openStream(Id);
		// Joined the pool the moment the container exists, not once it is finished.
		// Everything below - starting, the MTU pin, the CA, the repo sync, the MCP
		// installs - is the expensive part, and until this write the container was
		// recorded nowhere: `projects.container_id` is set at the end and the member
		// row was written beside it, so the global Containers page showed nothing
		// while a container was coming up and its log stream (already open, keyed on
		// this id) had no row to be reached from. `creating` is skipped by the
		// allocation ladder, so registering early cannot hand a half-built container
		// to a run; the `idle` upsert below is what makes it allocatable.
		await upsertPoolMember(db, project.id, Id, 'creating', diskGb);
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
			`project ${ref(project.slug, project.id)} container ${ref(project.slug, Id.slice(0, 12))} provisioned and started in ${elapsedSeconds(provisionStartedAt)}`,
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
				// Copy the CA in through the file seam, then install it. Both steps
				// have to happen on every backend: `NODE_EXTRA_CA_CERTS` points at the
				// file itself, while curl, git, Codex and Grok read only the system
				// trust store `update-ca-certificates` builds from it - so a missing
				// file breaks far more than Node.
				await docker
					.files(Id, CONTAINER_CA_DIR)
					.write(CONTAINER_CA_FILENAME, await readFile(deps.egressCAPath, 'utf8'), {
						mode: 0o644,
					});
				const execId = await docker.execCreate(Id, {
					Cmd: ['update-ca-certificates'],
					AttachStdout: true,
					AttachStderr: true,
				});
				const out = await docker.execStart(execId);
				if (out.stderr.trim()) emit('stderr', out.stderr);
			} catch (e) {
				// Loud, and not fatal to provisioning: a container without the CA is
				// still usable for everything that does not transit the proxy, and the
				// failure is legible here rather than as an unknown-issuer error
				// thousands of lines into a run.
				emit('stderr', `⚠ installing the egress CA failed: ${(e as Error).message}`);
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
			// Clone in-container (the host has no git). A private repo's remote carries
			// a credential placeholder the egress proxy substitutes, and the bridge
			// carries commit signing — provisioning isn't a run, so allocate a
			// short-lived pair. Without them the clone still runs but ships the
			// placeholder unsubstituted, so a private repo fails as a bad token.
			const syncRepos = (
				bridge: BridgeRunnerArgs | null,
				scopeId: string,
				proxyEnv: string[] = [],
			) =>
				ensureProjectRepos(
					db,
					{ id: project.id, team_id: teamId },
					dataDir,
					ContainerGitExecutor.forPrep(docker, Id, bridge, runUser, scopeId, proxyEnv),
					(stream, text) => emit(stream, text),
				);
			const syncRes =
				deps.sshAgentServer && deps.egressProxy
					? await withProvisionBridge(
							deps.sshAgentServer,
							{
								engine: docker,
								containerId: Id,
								teamId,
								dataDir,
								runUser,
								db,
								egressProxy: deps.egressProxy,
								projectId: project.id,
							},
							({ bridge, scopeId, proxyEnv }) => syncRepos(bridge, scopeId, proxyEnv),
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
		emit(
			'stderr',
			`✗ Provisioning failed after ${elapsedSeconds(provisionStartedAt)}: ${errorMessage}`,
		);
		// A container that was created and then failed part-way through setup is
		// still a real container on the engine, so it is left in the pool as
		// `error` with the reason on it: it lists as Failed, its detail page shows
		// the reason and whatever its log captured, and Remove is exactly the fix.
		// Dropping the member instead would leave it running and unreachable -
		// invisible on a local daemon, billed for on a managed backend.
		if (createdContainerId) {
			await setPoolMemberState(db, createdContainerId, 'error');
			await setPoolMemberOutcome(db, createdContainerId, null, errorMessage);
		}
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
 * What the container is being taken for. The ladder is the same either way; four
 * things around it are not.
 *
 * - **`task-run`** claims the member busy, is gated on the memory budget, and
 *   gives it back when the run ends.
 * - **`chat`** *pins* it instead (`reserved_for_chat`), leaving the state idle:
 *   the member is then excluded from the ladder (`usable`) and from
 *   `usedMemoryGb` (`getActiveContainers`), which together are what "the chat's
 *   container" means. It is not gated, because the budget already holds a
 *   container's worth back for chat up front - a queued task run is invisible
 *   and harmless, a queued chat turn is a person watching a spinner. And it is
 *   never released per turn: the session holds it until teardown, which clears
 *   the pin.
 */
export type ContainerWorkload = 'task-run' | 'chat';

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
 *
 * **The chat comes through here too, and that is the point.** It used to take
 * whatever `projects.container_id` named, which under a pool may be a member
 * currently serving a task run - so the chat pinned it and executed turns on it,
 * two workloads sharing one memory cap, which is precisely the shared-fate
 * failure the pool exists to remove. Routing it through the same ladder is what
 * guarantees the container it pins is one nothing else is using. Both callers
 * take the same per-project lifecycle lock, so a task run cannot claim a member
 * between the chat deciding on it and pinning it.
 */
export async function acquireRunContainer(
	deps: ContainerDeps,
	projectId: string,
	taskId: string | null,
	workload: ContainerWorkload = 'task-run',
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
		// A pin the chat already holds is its own rung, and it has to come before
		// the ladder rather than inside it: `selectPoolMember` excludes reserved
		// members by design, so a session reconnecting would otherwise be handed a
		// *different* container from the one it parked on - losing the filesystem
		// its conversation was built against, and pinning a second container beside
		// the one it already holds.
		if (workload === 'chat') {
			const existing = await reusableChatMember(deps, projectId);
			if (existing) return existing;
		}
		// Bounded: each iteration either claims a member or removes one from
		// contention (a lost race retries against a pool one member smaller), so
		// this cannot spin. The cap is the pool's own size, not a timeout.
		for (let attempt = 0; attempt < MAX_ACQUIRE_ATTEMPTS; attempt++) {
			const [active, requestMemoryGb] = await Promise.all([
				getActiveContainers(db, deps.docker),
				projectContainerMemoryGb(db, projectId),
			]);
			const decision = await decidePoolAcquisition(
				db,
				projectId,
				taskId,
				// Chat is exempt from the budget rather than charged against it: the
				// automatic budget already subtracts one container's worth up front
				// (`computeDefaultMaxActiveContainers`), so charging it again would
				// reserve for the chat twice and refuse it on a small host. An
				// unreachable ceiling states that here without a second ladder.
				workload === 'chat'
					? { usedMemoryGb: 0, budgetGb: Number.POSITIVE_INFINITY, requestMemoryGb: 0 }
					: {
							usedMemoryGb: active.usedMemoryGb,
							budgetGb: active.budgetGb,
							requestMemoryGb,
						},
			);

			if (decision.kind === 'queue') throw new PoolCapacityError(projectId);

			if (decision.kind === 'create') {
				const proj = await loadProjectRow(db, projectId);
				const id = await provisionContainer(deps, proj, proj.team_slug);
				if (await takeMember(deps, projectId, id, taskId, workload)) return id;
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
			if (await takeMember(deps, projectId, member.id, taskId, workload)) return member.id;
		}
		throw new PoolCapacityError(projectId);
	});

	let released = false;
	return {
		containerId,
		release: async () => {
			if (released) return;
			released = true;
			// A chat pin outlives the turn that established it - the session holds
			// its container across every turn, and `teardown` is what clears the
			// reservation. Releasing here would hand it back after the first turn.
			if (workload === 'chat') return;
			await releasePoolMember(db, containerId, taskId).catch(() => undefined);
		},
	};
}

/** See {@link acquireRunContainer} - the loop is bounded by contention, not by time. */
const MAX_ACQUIRE_ATTEMPTS = 8;

/**
 * Take a decided member for `workload`, answering whether the take succeeded.
 *
 * A task run **claims** it busy, which is also the atomic did-I-win check
 * against a concurrent acquire. The chat **pins** it instead and leaves it idle:
 * that pair of facts - idle, reserved - is what makes a container the chat's,
 * since `usable` then skips it in the ladder and `getActiveContainers` stops
 * charging it against the budget. Both callers hold the same per-project
 * lifecycle lock, so the pin needs no compare-and-set of its own.
 */
async function takeMember(
	deps: ContainerDeps,
	projectId: string,
	containerId: string,
	taskId: string | null,
	workload: ContainerWorkload,
): Promise<boolean> {
	if (workload !== 'chat') return claimPoolMember(deps.db, containerId, taskId);

	await setPoolMemberChatReservation(deps.db, containerId, true);
	// Point the project row at it when it is not already there. `container_id` is
	// the operator's view - it is what the Container page shows, what the sync
	// loop polls, and what `container_error`/`container_last_logs` attach to - and
	// the chat's container is the long-lived one they are most likely to be
	// looking at. Now that the chat takes a member from the ladder rather than
	// whatever the column happened to name, the column has to follow it. Skipped
	// when it already matches so a reuse writes no row (§ never write a row that
	// has not changed).
	const named = await deps.db.query<{ container_id: string | null }>(
		'SELECT container_id FROM projects WHERE id = $1',
		[projectId],
	);
	if (named.rows[0]?.container_id !== containerId) {
		await markProjectContainerStarted(deps, projectId, containerId);
	}
	return true;
}

/**
 * The container the chat already holds, if it is still usable.
 *
 * Answers null rather than repairing anything when the pin points at a member
 * that is gone or unreachable - the caller falls through to the ladder, which is
 * where a fresh container comes from. A stale pin is dropped on the way past so
 * it cannot keep a phantom container out of the budget forever.
 */
async function reusableChatMember(deps: ContainerDeps, projectId: string): Promise<string | null> {
	const { db, docker } = deps;
	const pinned = (await loadPoolMembers(db, projectId)).find((m) => m.reservedForChat);
	if (!pinned) return null;

	if (pinned.state === 'suspended') {
		try {
			await docker.startContainer(pinned.id);
		} catch {
			await removePoolMember(db, pinned.id);
			return null;
		}
		await setPoolMemberState(db, pinned.id, 'idle');
		await markProjectContainerStarted(deps, projectId, pinned.id);
		return pinned.id;
	}

	const info = await docker.inspectContainer(pinned.id).catch(() => null);
	if (!info?.State.Running) {
		await removePoolMember(db, pinned.id);
		return null;
	}
	return pinned.id;
}

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

/**
 * Stop and remove one container on the engine, tolerating one that is already
 * gone in either direction.
 *
 * Three callers wanted this exact pair, which is two more than a copy survives:
 * project teardown, the operator's own Remove, and (formerly) rebuild. It also
 * owns the `--keep-old-containers` escape in one place - a flag honoured at two
 * of three call sites is worse than one honoured nowhere, because the
 * inconsistency is invisible until someone is debugging a container they were
 * promised would still be there.
 *
 * It deliberately touches **only** the engine. The database half differs per
 * caller (teardown clears the whole project, Remove clears one row), and folding
 * them together is what made the old rebuild path forget the pool.
 */
async function removeFromEngine(docker: ContainerEngine, containerId: string): Promise<void> {
	if (keepOldContainersFlag) return;
	try {
		await docker.stopContainer(containerId);
	} catch {
		// Container may already be stopped
	}
	try {
		await docker.removeContainer(containerId, true);
	} catch {
		// Container may already be removed
	}
}

/**
 * Remove **one** container at an operator's request, from the global Containers
 * page.
 *
 * This is what replaced Rebuild. Rebuild meant "throw away this project's
 * containers and provision a new one", which stopped corresponding to anything
 * once a project could hold several: the operator was looking at one container
 * and the button acted on all of them. A container that has wedged is one
 * container, and removing it is the whole fix - the pool provisions a
 * replacement on the next run that needs one, which is the path every other
 * container already takes.
 *
 * Removing one that is **serving a run** is allowed, and is in fact the main
 * reason to reach for this: the run dies through the ordinary container-death
 * path (`failProjectRuns`, scoped to this container so a sibling run in another
 * container of the same project is untouched), exactly as it would if the
 * container had crashed. Refusing while busy would block precisely the case the
 * button exists for.
 */
export async function destroyContainer(
	deps: ContainerDeps,
	projectId: string,
	projectSlug: string,
	teamId: string,
	containerId: string,
): Promise<void> {
	const { db, docker, wsManager } = deps;

	// Captured before the container goes, and kept on the member row: it is the
	// only account of why this container was worth removing, and the detail page
	// shows it after the container itself is gone.
	//
	// The engine's own log is empty on every backend (PID 1 is `sleep infinity`)
	// and absent entirely on a managed one, so the live stream's buffer - the
	// provisioning and lifecycle output Hezo wrote itself - is what actually
	// carries the account. Falling back to it is the difference between a removed
	// container's page reading "No output was captured" and showing how it came up.
	const lastLogs =
		(await captureContainerLogs(docker, containerId, projectSlug)) ??
		deps.logs?.getLogText(containerStreamId(containerId)) ??
		null;
	const annotated = appendMemoryLine(lastLogs || null, consumeFinalMemoryLine(projectId));
	await setPoolMemberOutcome(db, containerId, annotated, null);

	await removeFromEngine(docker, containerId);
	await removePoolMember(db, containerId);
	// The project row still names a single "the" container; leaving it pointing at
	// one that no longer exists makes the 1 Hz sync read a container it cannot
	// inspect as one that died, and report a spurious error on a project whose
	// other containers are fine.
	await clearProjectContainerIfNamed(db, projectId, containerId);

	await failProjectRuns(
		deps,
		projectId,
		projectSlug,
		teamId,
		'container_stopped',
		containerId,
	).catch((e) => log.error('Failed to fail runs on container removal:', e));

	// The one event that ends a container's log stream. Viewer churn deliberately
	// does not (see `ContainerLogStreamer.unsubscribe`), so this is also what
	// bounds the broker's map - every stream it opens is closed by the container
	// it belongs to going away.
	if (deps.logs) await deps.containerLogStreamer?.end(containerId, deps.logs);

	await broadcastProjectUpdate(db, wsManager, teamId, projectId);
	log.info(
		`container ${ref(projectSlug, containerId.slice(0, 12))} removed from project ${ref(projectSlug, projectId)}`,
	);
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
	for (const id of toRemove) await removeFromEngine(docker, id);
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
		await setPoolMemberOutcome(db, containerId, annotatedLogs, null);
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
		await setPoolMemberOutcome(db, containerId, annotatedLogs, errorMessage);
		exitReason = 'container_error';
		log.warn(
			`project ${ref(projectSlug, projectId)} container ${ref(projectSlug, containerId.slice(0, 12))} stop failed: ${errorMessage}`,
		);
	}

	// This container is being stopped, so only its runs die - a sibling in
	// another container of the same project keeps going.
	await failProjectRuns(deps, projectId, projectSlug, teamId, exitReason, containerId).catch((e) =>
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
	-- A live chat keeps its container on its **own**, longer window. A pause
	-- between messages is a person thinking, not an idle project, and reclaiming
	-- at the run window suspended the container out from under an open chatbox.
	SELECT cs.project_id FROM chat_sessions cs
	 WHERE cs.status IN ('starting', 'running')
	   AND (cs.last_activity_at > now() - (${CHAT_IDLE_TIMEOUT_MIN} * interval '1 minute')
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
		// The message, not the error object. An occasional transport failure is
		// expected on this path - the engine has already exhausted its own retries
		// and the next tick simply asks again - so a stack per project per tick
		// buries everything else in the log during a provider outage. The stack is
		// one level away rather than gone.
		log.warn(
			`Container sync transport error for project ${ref(projectSlug, projectId)}; will retry: ${(err as Error).message}`,
		);
		log.debug(`Container sync transport error for ${ref(projectSlug, projectId)}`, err);
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
		await setPoolMemberOutcome(db, containerId, annotatedLogs, errorMessage);
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
	await setPoolMemberOutcome(db, containerId, lastLogs, errorMessage);

	log.warn(
		`Auto-stopped container ${ref(projectSlug, containerId.slice(0, 12))} for project ${ref(projectSlug, projectId)}: used ${usedGiB} GiB (> ${memoryLimitGib} GiB)`,
	);

	memoryUsageState.delete(projectId);
	lastMemoryCheckAt.delete(projectId);

	// Scoped to the container that actually exceeded its cap. Failing the whole
	// project here is what the pool was built to stop: a sibling run in its own
	// container is unaffected by this one's memory use and must not die with it.
	await failProjectRuns(deps, projectId, projectSlug, teamId, 'container_error', containerId).catch(
		(e) => log.error('Failed to fail project runs after memory-limit stop:', e),
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
 * Fail the in-flight runs a dead container was carrying, reset their agents to
 * idle, release their execution locks and broadcast the changes. The caller
 * first aborts any live in-process runs via the JobManager registry.
 *
 * **Scoped to the container when one is named.** The pool exists so that a run
 * cannot take down its siblings, and that promise is kept or broken precisely
 * here: failing by *project* would fail runs sitting healthy in their own
 * containers because some other container OOMed, which is the shared-fate blast
 * radius the whole rearchitecture removes. `heartbeat_runs.container_id` (added
 * in 049) is what makes the narrower question answerable.
 *
 * Passing `containerId: null` deliberately keeps the project-wide behaviour, for
 * the two callers that have no container to blame - a project-level teardown,
 * and the boot sweep reconciling runs from a previous lifetime.
 *
 * Runs whose `container_id` is NULL (recorded before 049, or never attributed)
 * are failed alongside the named container's. That is the safe direction: an
 * unattributable run is one nothing can prove is still alive, and leaving it
 * `running` forever would hold its agent's slot and its execution lock.
 */
export async function failProjectRuns(
	deps: ContainerDeps,
	projectId: string,
	projectSlug: string,
	teamId: string,
	reason: ContainerExitReason,
	containerId: string | null = null,
): Promise<void> {
	const { db, wsManager } = deps;

	// `$5::text IS NULL` rather than building the SQL in two shapes: one
	// statement, one plan, and the scoped/unscoped difference stays visible.
	const scope = `AND ($5::text IS NULL OR container_id = $5::text OR container_id IS NULL)`;
	const failedRuns = await db.query<{ id: string; member_id: string; task_id: string | null }>(
		`UPDATE heartbeat_runs
		 SET status = $1::heartbeat_run_status,
		     finished_at = now(),
		     error = $2,
		     exit_code = -1
		 WHERE status = $3::heartbeat_run_status
		   AND task_id IN (SELECT id FROM tasks WHERE project_id = $4)
		   ${scope}
		 RETURNING id, member_id, task_id`,
		[HeartbeatRunStatus.Failed, reason, HeartbeatRunStatus.Running, projectId, containerId],
	);

	if (failedRuns.rows.length === 0) return;

	const memberIds = Array.from(new Set(failedRuns.rows.map((r) => r.member_id)));

	// Only the locks of the runs actually failed - a sibling run still executing
	// in another container must keep its lock, or a second run could be
	// dispatched onto the task it is still working.
	await db.query(
		`UPDATE execution_locks SET released_at = now()
		 WHERE released_at IS NULL
		   AND task_id = ANY($1::uuid[])`,
		[failedRuns.rows.map((r) => r.task_id).filter((id): id is string => id !== null)],
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

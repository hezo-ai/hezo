import { join } from 'node:path';
import type { PGlite } from '@electric-sql/pglite';
import {
	AgentRuntimeStatus,
	ContainerStatus,
	HeartbeatRunStatus,
	WakeupSource,
	WsMessageType,
	wsRoom,
} from '@hezo/shared';
import type { MasterKeyManager } from '../crypto/master-key';
import { broadcastProjectUpdate, broadcastRowChange } from '../lib/broadcast';
import { logger } from '../logger';
import type { DockerClient } from './docker';
import { ensureImage } from './ensure-image';
import type { LogStreamBroker } from './log-stream-broker';
import { ensureProjectRepos } from './repo-sync';
import type { SshAgentServer } from './ssh-agent';
import { createWakeup } from './wakeup';
import { ensureProjectRunDir, ensureProjectWorkspace, removeProjectWorkspace } from './workspace';
import type { WebSocketManager } from './ws';

export type ContainerExitReason = 'container_error' | 'container_stopped';

export interface ContainerTransition {
	projectId: string;
	companyId: string;
	oldStatus: string | null;
	newStatus: string | null;
}

const log = logger.child('containers');

export interface ProjectRow {
	id: string;
	company_id: string;
	slug: string;
	docker_base_image: string;
	container_id: string | null;
	container_status: string | null;
	dev_ports: Array<{ container: number; host: number }>;
}

export interface ContainerDeps {
	db: PGlite;
	docker: DockerClient;
	dataDir: string;
	wsManager?: WebSocketManager;
	masterKeyManager?: MasterKeyManager;
	logs?: LogStreamBroker;
	sshAgentServer?: SshAgentServer | null;
	egressCAPath?: string | null;
}

/** In-container path the egress CA is bind-mounted to. */
export const CONTAINER_CA_PATH = '/usr/local/share/ca-certificates/hezo-egress.crt';

const PROVISION_CAP_BYTES = 64 * 1024;

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
		capBytes: PROVISION_CAP_BYTES,
	});
}

const PORT_POOL_START = 10000;
const PORT_POOL_END = 19999;

const LAST_LOGS_CAP_BYTES = 32 * 1024;

/**
 * Pull a one-shot tail of the container's stdout+stderr log buffer. Used to
 * snapshot the last-known console output when a container exits or errors so
 * the user can see what happened without a live stream.
 */
export async function captureContainerLogs(
	docker: DockerClient,
	containerId: string,
): Promise<string | null> {
	try {
		const res = await docker.containerLogs(containerId, {
			follow: false,
			tail: 500,
			stdout: true,
			stderr: true,
		});
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
		let combined = chunks.join('');
		if (combined.length > LAST_LOGS_CAP_BYTES) {
			combined = combined.slice(-LAST_LOGS_CAP_BYTES);
		}
		return combined || null;
	} catch (err) {
		log.warn(`Failed to capture logs for container ${containerId}:`, err);
		return null;
	}
}

export async function provisionContainer(
	deps: ContainerDeps,
	project: ProjectRow,
	companySlug: string,
): Promise<string> {
	const { db, docker, dataDir, wsManager, masterKeyManager, logs } = deps;
	const companyId = project.company_id;

	await db.query('UPDATE projects SET container_status = $1::container_status WHERE id = $2', [
		ContainerStatus.Creating,
		project.id,
	]);

	beginProvisionStream(logs, project.id);
	const streamId = provisionStreamId(project.id);
	const emit = (stream: 'stdout' | 'stderr', text: string) => logs?.emit(streamId, stream, text);

	try {
		emit('stdout', `→ Preparing workspace for ${companySlug}/${project.slug}`);
		const projectDir = ensureProjectWorkspace(dataDir, companySlug, project.slug);
		const workspacePath = join(projectDir, 'workspace');
		const worktreesPath = join(projectDir, 'worktrees');
		const previewsPath = join(projectDir, '.previews');

		// Host-side SSH agent socket lives in this dir for host-side git operations.
		// In-container SSH socket is allocated fresh by the per-run socat bridge so
		// no bind-mount is required, which sidesteps Docker Desktop's lack of
		// AF_UNIX bind-mount forwarding on macOS.
		ensureProjectRunDir(dataDir, companySlug, project.slug);

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

		const containerName = `hezo-${companySlug}-${project.slug}`;
		const extraHosts = ['host.docker.internal:host-gateway'];

		const env = ['HEZO_API_URL=http://host.docker.internal:3100/agent-api'];

		emit('stdout', `→ Resolving image ${project.docker_base_image}`);
		await ensureImage(docker, project.docker_base_image, {
			onLine: (stream, text) => emit(stream, text),
		});

		emit('stdout', `→ Creating container ${containerName}`);
		try {
			await docker.removeContainer(containerName, true);
		} catch {
			// Container doesn't exist — expected
		}

		const { Id } = await docker.createContainer(containerName, {
			Image: project.docker_base_image,
			Cmd: ['sleep', 'infinity'],
			Env: env,
			WorkingDir: '/workspace',
			HostConfig: {
				Binds: binds,
				PortBindings: portBindings,
				ExtraHosts: extraHosts,
			},
			ExposedPorts: exposedPorts,
		});

		emit('stdout', '→ Starting container');
		await docker.startContainer(Id);

		await db.query(
			'UPDATE projects SET container_id = $1, container_status = $2::container_status, container_error = NULL WHERE id = $3',
			[Id, ContainerStatus.Running, project.id],
		);

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

		if (masterKeyManager) {
			emit('stdout', '→ Syncing project repos');
			const syncRes = await ensureProjectRepos(
				db,
				masterKeyManager,
				{
					id: project.id,
					company_id: companyId,
					companySlug,
					projectSlug: project.slug,
				},
				dataDir,
				deps.sshAgentServer ?? null,
				(stream, text) => emit(stream, text),
			);
			if (syncRes.failed.length > 0) {
				emit(
					'stderr',
					`⚠ ${syncRes.failed.length} repo(s) failed to clone; container is usable but some repos may be missing`,
				);
			}
		}

		emit('stdout', '✓ Container ready');
		await broadcastProjectUpdate(db, wsManager, companyId, project.id);

		await requeueContainerKilledRuns(deps, project.id, companyId).catch((e) =>
			log.error('Failed to requeue container-killed runs after provision:', e),
		);

		return Id;
	} catch (error) {
		const errorMessage = error instanceof Error ? error.message : String(error);
		emit('stderr', `✗ Provisioning failed: ${errorMessage}`);
		await db.query(
			'UPDATE projects SET container_status = $1::container_status, container_error = $2 WHERE id = $3',
			[ContainerStatus.Error, errorMessage, project.id],
		);
		await broadcastProjectUpdate(db, wsManager, companyId, project.id);
		throw error;
	}
}

export async function teardownContainer(
	deps: ContainerDeps,
	projectId: string,
	companySlug: string,
	projectSlug: string,
): Promise<void> {
	const { db, docker, dataDir } = deps;

	const result = await db.query<{ container_id: string | null }>(
		'SELECT container_id FROM projects WHERE id = $1',
		[projectId],
	);

	if (result.rows[0]?.container_id) {
		try {
			await docker.stopContainer(result.rows[0].container_id);
		} catch {
			// Container may already be stopped
		}
		try {
			await docker.removeContainer(result.rows[0].container_id, true);
		} catch {
			// Container may already be removed
		}
	}

	await db.query('UPDATE projects SET container_id = NULL, container_status = NULL WHERE id = $1', [
		projectId,
	]);

	removeProjectWorkspace(dataDir, companySlug, projectSlug);
}

export async function stopContainerGracefully(
	deps: ContainerDeps,
	projectId: string,
	companyId: string,
	containerId: string,
): Promise<void> {
	const { db, docker, wsManager } = deps;

	const lastLogs = await captureContainerLogs(docker, containerId);

	let exitReason: ContainerExitReason = 'container_stopped';
	try {
		await docker.stopContainer(containerId);
		await db.query(
			`UPDATE projects
			 SET container_status = $1::container_status,
			     container_last_logs = COALESCE($2, container_last_logs),
			     container_error = NULL
			 WHERE id = $3`,
			[ContainerStatus.Stopped, lastLogs, projectId],
		);
	} catch (err) {
		const errorMessage = err instanceof Error ? err.message : String(err);
		await db.query(
			`UPDATE projects
			 SET container_status = $1::container_status,
			     container_last_logs = COALESCE($2, container_last_logs),
			     container_error = $3
			 WHERE id = $4`,
			[ContainerStatus.Error, lastLogs, errorMessage, projectId],
		);
		exitReason = 'container_error';
	}

	await failProjectRuns(deps, projectId, companyId, exitReason).catch((e) =>
		log.error('Failed to fail project runs on stop:', e),
	);

	await broadcastProjectUpdate(db, wsManager, companyId, projectId);
}

/**
 * Verify that the container's `/workspace` bind mount is reachable from inside.
 * Docker Desktop on macOS can leave a container in a state where it inspects as
 * Running but its bind mounts have gone stale — `docker exec` then fails with
 * "current working directory is outside of container mount namespace root". Doing
 * a cheap exec catches that case where `inspectContainer` cannot.
 */
export async function verifyContainerWorkspace(
	docker: DockerClient,
	containerId: string,
): Promise<boolean> {
	try {
		const execId = await docker.execCreate(containerId, {
			Cmd: ['ls', '/workspace'],
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
	companySlug: string,
): Promise<string> {
	const { db, docker, logs } = deps;
	beginProvisionStream(logs, project.id);
	const streamId = provisionStreamId(project.id);

	if (project.container_id) {
		logs?.emit(
			streamId,
			'stdout',
			`→ Removing previous container ${project.container_id.slice(0, 12)}`,
		);
		const lastLogs = await captureContainerLogs(docker, project.container_id);
		if (lastLogs) {
			await db.query('UPDATE projects SET container_last_logs = $1 WHERE id = $2', [
				lastLogs,
				project.id,
			]);
		}
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

	return provisionContainer(deps, project, companySlug);
}

export async function syncContainerStatus(
	db: PGlite,
	docker: DockerClient,
	projectId: string,
	containerId: string,
	previousStatus?: string | null,
): Promise<string | null> {
	let info: Awaited<ReturnType<DockerClient['inspectContainer']>>;
	try {
		info = await docker.inspectContainer(containerId);
	} catch (err) {
		log.warn(`Container sync transport error for project ${projectId}; will retry`, err);
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
		const lastLogs = await captureContainerLogs(docker, containerId);
		const exitCode = info.State.ExitCode;
		const exitStatus = info.State.Status;
		const errorMessage =
			exitCode && exitCode !== 0
				? `Container exited with code ${exitCode} (${exitStatus}).`
				: `Container stopped (${exitStatus}).`;
		await db.query(
			`UPDATE projects
			 SET container_status = $1::container_status,
			     container_last_logs = COALESCE($2, container_last_logs),
			     container_error = $3
			 WHERE id = $4`,
			[status, lastLogs, errorMessage, projectId],
		);
	} else {
		await db.query('UPDATE projects SET container_status = $1::container_status WHERE id = $2', [
			status,
			projectId,
		]);
	}

	return status;
}

export async function syncAllContainerStatuses(
	db: PGlite,
	docker: DockerClient,
	wsManager?: WebSocketManager,
): Promise<ContainerTransition[]> {
	const projects = await db.query<{
		id: string;
		company_id: string;
		container_id: string;
		container_status: string | null;
	}>(
		'SELECT id, company_id, container_id, container_status FROM projects WHERE container_id IS NOT NULL',
	);

	const transitions: ContainerTransition[] = [];
	for (const project of projects.rows) {
		const oldStatus = project.container_status;
		const newStatus = await syncContainerStatus(
			db,
			docker,
			project.id,
			project.container_id,
			oldStatus,
		);

		if (newStatus !== null && newStatus !== oldStatus) {
			transitions.push({
				projectId: project.id,
				companyId: project.company_id,
				oldStatus,
				newStatus,
			});
			await broadcastProjectUpdate(db, wsManager, project.company_id, project.id);
		}
	}

	return transitions;
}

/**
 * Mark all in-flight heartbeat_runs for a project's issues as failed with the
 * given reason, reset affected agents' runtime_status to idle, release execution
 * locks, and broadcast row changes. Caller is responsible for first aborting any
 * live in-process runs via the JobManager registry.
 */
export async function failProjectRuns(
	deps: ContainerDeps,
	projectId: string,
	companyId: string,
	reason: ContainerExitReason,
): Promise<void> {
	const { db, wsManager } = deps;

	const failedRuns = await db.query<{ id: string; member_id: string; issue_id: string | null }>(
		`UPDATE heartbeat_runs
		 SET status = $1::heartbeat_run_status,
		     finished_at = now(),
		     error = $2,
		     exit_code = -1
		 WHERE status = $3::heartbeat_run_status
		   AND issue_id IN (SELECT id FROM issues WHERE project_id = $4)
		 RETURNING id, member_id, issue_id`,
		[HeartbeatRunStatus.Failed, reason, HeartbeatRunStatus.Running, projectId],
	);

	if (failedRuns.rows.length === 0) return;

	const memberIds = Array.from(new Set(failedRuns.rows.map((r) => r.member_id)));

	await db.query(
		`UPDATE member_agents SET runtime_status = $1::agent_runtime_status
		 WHERE id = ANY($2::uuid[]) AND runtime_status = $3::agent_runtime_status`,
		[AgentRuntimeStatus.Idle, memberIds, AgentRuntimeStatus.Active],
	);

	await db.query(
		`UPDATE execution_locks SET released_at = now()
		 WHERE released_at IS NULL
		   AND issue_id IN (SELECT id FROM issues WHERE project_id = $1)`,
		[projectId],
	);

	for (const run of failedRuns.rows) {
		broadcastRowChange(wsManager, wsRoom.company(companyId), 'heartbeat_runs', 'UPDATE', {
			id: run.id,
			member_id: run.member_id,
			issue_id: run.issue_id,
			status: HeartbeatRunStatus.Failed,
			error: reason,
		});
	}

	for (const memberId of memberIds) {
		broadcastRowChange(wsManager, wsRoom.company(companyId), 'member_agents', 'UPDATE', {
			id: memberId,
			runtime_status: AgentRuntimeStatus.Idle,
		});
	}

	log.info(
		`Failed ${failedRuns.rows.length} run(s) in project ${projectId} due to ${reason}; ${memberIds.length} agent(s) marked idle`,
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
	companyId: string,
): Promise<number> {
	const { db } = deps;

	const killed = await db.query<{
		id: string;
		member_id: string;
		issue_id: string;
	}>(
		`SELECT DISTINCT ON (member_id, issue_id) id, member_id, issue_id
		 FROM heartbeat_runs
		 WHERE issue_id IN (SELECT id FROM issues WHERE project_id = $1)
		   AND error = $2
		   AND finished_at > now() - ($3 || ' hours')::interval
		   AND NOT EXISTS (
		     SELECT 1 FROM heartbeat_runs h2
		     WHERE h2.member_id = heartbeat_runs.member_id
		       AND h2.issue_id = heartbeat_runs.issue_id
		       AND h2.started_at > heartbeat_runs.finished_at
		   )
		 ORDER BY member_id, issue_id, finished_at DESC
		 LIMIT $4`,
		[projectId, 'container_error', String(REQUEUE_LOOKBACK_HOURS), REQUEUE_LIMIT],
	);

	for (const run of killed.rows) {
		await createWakeup(db, run.member_id, companyId, WakeupSource.Timer, {
			reason: 'container_recovery',
			issue_id: run.issue_id,
			previous_run_id: run.id,
		});
	}

	if (killed.rows.length > 0) {
		log.info(
			`Re-queued ${killed.rows.length} container-killed run(s) in project ${projectId} after container recovery`,
		);
	}

	return killed.rows.length;
}

async function allocateHostPorts(
	db: PGlite,
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

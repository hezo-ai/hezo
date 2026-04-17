import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { PGlite } from '@electric-sql/pglite';
import { ContainerStatus, WsMessageType } from '@hezo/shared';
import type { MasterKeyManager } from '../crypto/master-key';
import { broadcastProjectUpdate } from '../lib/broadcast';
import { logger } from '../logger';
import type { DockerClient } from './docker';
import { ensureImage } from './ensure-image';
import type { LogStreamBroker } from './log-stream-broker';
import { ensureProjectRepos } from './repo-sync';
import { ensureProjectWorkspace, removeProjectWorkspace } from './workspace';
import type { WebSocketManager } from './ws';

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
}

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

		const binds = [
			`${workspacePath}:/workspace:rw`,
			`${worktreesPath}:/worktrees:rw`,
			`${previewsPath}:/workspace/.previews:rw`,
		];

		const gitconfigPath = join(homedir(), '.gitconfig');
		if (existsSync(gitconfigPath)) {
			binds.push(`${gitconfigPath}:/root/.gitconfig:ro`);
		}

		const sshAuthSock = process.env.SSH_AUTH_SOCK;
		if (sshAuthSock) {
			binds.push(`${sshAuthSock}:/tmp/ssh-agent.sock`);
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
		if (sshAuthSock) {
			env.push('SSH_AUTH_SOCK=/tmp/ssh-agent.sock');
		}

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
			'UPDATE projects SET container_id = $1, container_status = $2::container_status WHERE id = $3',
			[Id, ContainerStatus.Running, project.id],
		);

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

		return Id;
	} catch (error) {
		emit(
			'stderr',
			`✗ Provisioning failed: ${error instanceof Error ? error.message : String(error)}`,
		);
		await db.query('UPDATE projects SET container_status = $1::container_status WHERE id = $2', [
			ContainerStatus.Error,
			project.id,
		]);
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

	try {
		await docker.stopContainer(containerId);
		await db.query('UPDATE projects SET container_status = $1::container_status WHERE id = $2', [
			ContainerStatus.Stopped,
			projectId,
		]);
	} catch {
		await db.query('UPDATE projects SET container_status = $1::container_status WHERE id = $2', [
			ContainerStatus.Error,
			projectId,
		]);
	}

	// Release stale execution locks for issues in this project
	await db
		.query(
			`UPDATE execution_locks SET released_at = now()
		 WHERE released_at IS NULL
		   AND issue_id IN (SELECT id FROM issues WHERE project_id = $1)`,
			[projectId],
		)
		.catch((e) => log.error('Failed to release execution locks on stop:', e));

	await broadcastProjectUpdate(db, wsManager, companyId, projectId);
}

export async function rebuildContainer(
	deps: ContainerDeps,
	project: ProjectRow,
	companySlug: string,
): Promise<string> {
	const { docker, logs } = deps;
	beginProvisionStream(logs, project.id);
	const streamId = provisionStreamId(project.id);

	if (project.container_id) {
		logs?.emit(
			streamId,
			'stdout',
			`→ Removing previous container ${project.container_id.slice(0, 12)}`,
		);
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
): Promise<string> {
	try {
		const info = await docker.inspectContainer(containerId);
		const status = info.State.Running ? ContainerStatus.Running : ContainerStatus.Stopped;
		await db.query('UPDATE projects SET container_status = $1::container_status WHERE id = $2', [
			status,
			projectId,
		]);
		return status;
	} catch {
		await db.query(
			'UPDATE projects SET container_status = $1::container_status, container_id = NULL WHERE id = $2',
			[ContainerStatus.Error, projectId],
		);
		return ContainerStatus.Error;
	}
}

export async function syncAllContainerStatuses(
	db: PGlite,
	docker: DockerClient,
	wsManager?: WebSocketManager,
): Promise<void> {
	const projects = await db.query<{
		id: string;
		company_id: string;
		container_id: string;
		container_status: string;
	}>(
		'SELECT id, company_id, container_id, container_status FROM projects WHERE container_id IS NOT NULL',
	);

	for (const project of projects.rows) {
		const oldStatus = project.container_status;
		const newStatus = await syncContainerStatus(db, docker, project.id, project.container_id);

		if (newStatus !== oldStatus) {
			await broadcastProjectUpdate(db, wsManager, project.company_id, project.id);
		}
	}
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

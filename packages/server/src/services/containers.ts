import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { PGlite } from '@electric-sql/pglite';
import type { DockerClient } from './docker';
import { ensureProjectWorkspace, removeProjectWorkspace } from './workspace';

export interface ProjectRow {
	id: string;
	company_id: string;
	slug: string;
	docker_base_image: string;
	container_id: string | null;
	container_status: string | null;
	dev_ports: Array<{ container: number; host: number }>;
}

const PORT_POOL_START = 10000;
const PORT_POOL_END = 19999;

export async function provisionContainer(
	db: PGlite,
	docker: DockerClient,
	project: ProjectRow,
	companySlug: string,
	dataDir: string,
): Promise<string> {
	await db.query(
		"UPDATE projects SET container_status = 'creating'::container_status WHERE id = $1",
		[project.id],
	);

	try {
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

		await docker.pullImage(project.docker_base_image);

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

		await docker.startContainer(Id);

		await db.query(
			"UPDATE projects SET container_id = $1, container_status = 'running'::container_status WHERE id = $2",
			[Id, project.id],
		);

		return Id;
	} catch (error) {
		await db.query(
			"UPDATE projects SET container_status = 'error'::container_status WHERE id = $1",
			[project.id],
		);
		throw error;
	}
}

export async function teardownContainer(
	db: PGlite,
	docker: DockerClient,
	projectId: string,
	companySlug: string,
	projectSlug: string,
	dataDir: string,
): Promise<void> {
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

export async function rebuildContainer(
	db: PGlite,
	docker: DockerClient,
	project: ProjectRow,
	companySlug: string,
	dataDir: string,
): Promise<string> {
	if (project.container_id) {
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

	return provisionContainer(db, docker, project, companySlug, dataDir);
}

export async function syncContainerStatus(
	db: PGlite,
	docker: DockerClient,
	projectId: string,
	containerId: string,
): Promise<string> {
	try {
		const info = await docker.inspectContainer(containerId);
		const status = info.State.Running ? 'running' : 'stopped';
		await db.query('UPDATE projects SET container_status = $1::container_status WHERE id = $2', [
			status,
			projectId,
		]);
		return status;
	} catch {
		await db.query(
			"UPDATE projects SET container_status = 'error'::container_status, container_id = NULL WHERE id = $1",
			[projectId],
		);
		return 'error';
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

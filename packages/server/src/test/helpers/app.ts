import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PGlite } from '@electric-sql/pglite';
import { AgentAdminStatus, CAPTAIN_AGENT_SLUG, INTERNAL_PROJECT_SLUG } from '@hezo/shared';
import { generateMasterKey, MasterKeyManager } from '../../crypto/master-key';
import { loadAgentRoles } from '../../db/agent-roles';
import { seedBuiltins } from '../../db/seed';
import { toSlug, uniqueSlug } from '../../lib/slug';
import { signAgentJwt, signBoardJwt } from '../../middleware/auth';
import { resolveProjectTaskPrefix } from '../../routes/projects';
import type { DockerClient } from '../../services/docker';
import { createProjectWithPlanningTask } from '../../services/project-create';
import { buildApp } from '../../startup';
import { createTestDbWithMigrations } from './db';

const STUB_DOCKER_METHODS = {
	ping: async () => true,
	imageExists: async () => true,
	pullImage: async () => {},
	createContainer: async () => ({ Id: 'stub-container', Warnings: [] }),
	startContainer: async () => {},
	stopContainer: async () => {},
	removeContainer: async () => {},
	inspectContainer: async () => ({
		Id: 'stub-container',
		State: { Status: 'running', Running: true, Pid: 1, ExitCode: 0 },
		Config: { Image: 'stub' },
	}),
	containerLogs: async () => ({ arrayBuffer: async () => new ArrayBuffer(0) }),
	execCreate: async () => {
		throw new Error('execCreate not mocked — pass a mock docker via RunnerDeps');
	},
	execStart: async () => ({ stdout: '', stderr: '' }),
	execInspect: async () => ({ ExitCode: 0, Running: false, Pid: 0 }),
};

export function createStubDocker<T extends Record<string, unknown>>(
	overrides: T = {} as T,
): DockerClient & T {
	return { ...STUB_DOCKER_METHODS, ...overrides } as unknown as DockerClient & T;
}

export async function createTestApp(opts: { webUrl?: string } = {}) {
	const db = await createTestDbWithMigrations();
	const masterKeyManager = new MasterKeyManager();
	const masterKeyHex = generateMasterKey();
	await masterKeyManager.initialize(db, masterKeyHex);
	const roleDocs = await loadAgentRoles();
	await seedBuiltins(db, roleDocs);
	const dataDir = mkdtempSync(join(tmpdir(), 'hezo-test-'));
	const app = buildApp(
		db,
		masterKeyManager,
		{
			dataDir,
			webUrl: opts.webUrl ?? '',
		},
		createStubDocker(),
	);
	const userResult = await db.query<{ id: string }>(
		"INSERT INTO users (display_name, is_superuser) VALUES ('Test Admin', true) RETURNING id",
	);
	const token = await signBoardJwt(masterKeyManager, userResult.rows[0].id);

	return { app, db, token, masterKeyHex, masterKeyManager, dataDir };
}

export function authHeader(token: string) {
	return { Authorization: `Bearer ${token}` };
}

export async function createAgentRun(
	db: PGlite,
	agentId: string,
	teamId: string,
	taskId?: string | null,
	wakeupOpts?: { source?: string; payload?: Record<string, unknown> },
): Promise<string> {
	const source = wakeupOpts?.source ?? 'on_demand';
	const payload = wakeupOpts?.payload ?? {};
	const wakeup = await db.query<{ id: string }>(
		`INSERT INTO agent_wakeup_requests (member_id, team_id, source, status, payload, claimed_at)
		 VALUES ($1, $2, $3::wakeup_source, 'claimed'::wakeup_status, $4::jsonb, now())
		 RETURNING id`,
		[agentId, teamId, source, JSON.stringify(payload)],
	);
	const wakeupId = wakeup.rows[0].id;
	const result = await db.query<{ id: string }>(
		`INSERT INTO heartbeat_runs (member_id, team_id, task_id, wakeup_id, status, started_at)
		 VALUES ($1, $2, $3, $4, 'running'::heartbeat_run_status, now())
		 RETURNING id`,
		[agentId, teamId, taskId ?? null, wakeupId],
	);
	return result.rows[0].id;
}

export async function mintAgentToken(
	db: PGlite,
	masterKeyManager: MasterKeyManager,
	agentId: string,
	teamId: string,
	taskId?: string | null,
	opts: { projectId?: string; crossProject?: boolean } = {},
): Promise<{ token: string; runId: string; projectId: string; crossProject: boolean }> {
	const runId = await createAgentRun(db, agentId, teamId, taskId);
	let projectId = opts.projectId;
	let crossProject = opts.crossProject;
	if (!projectId) {
		if (taskId) {
			const taskProject = await db.query<{ id: string; is_internal: boolean }>(
				`SELECT p.id, p.is_internal FROM tasks t
				 JOIN projects p ON p.id = t.project_id
				 WHERE t.id = $1`,
				[taskId],
			);
			projectId = taskProject.rows[0]?.id;
			if (crossProject === undefined) crossProject = taskProject.rows[0]?.is_internal ?? false;
		}
		if (!projectId) {
			const fallback = await db.query<{ id: string }>(
				`SELECT id FROM projects WHERE team_id = $1 AND slug = $2 LIMIT 1`,
				[teamId, INTERNAL_PROJECT_SLUG],
			);
			projectId = fallback.rows[0]?.id;
			if (crossProject === undefined) crossProject = true;
		}
	}
	if (!projectId) throw new Error('mintAgentToken: could not resolve a projectId');
	if (crossProject === undefined) crossProject = false;
	const token = await signAgentJwt(
		masterKeyManager,
		agentId,
		teamId,
		runId,
		projectId,
		crossProject,
	);
	return { token, runId, projectId, crossProject };
}

export interface CreatedTestProject {
	id: string;
	slug: string;
	task_prefix: string;
	name: string;
	description: string;
	team_id: string;
	is_internal: boolean;
	docker_base_image: string;
	container_id: string | null;
	container_status: string | null;
	planning_task_id: string | null;
	planning_task_identifier: string | null;
}

/**
 * Test-only helper: creates a user-facing project plus its planning task by
 * calling the project service directly. Bypasses the captain intake flow that
 * `POST /api/teams/:teamId/projects` now triggers (which opens an intake ticket
 * and a pending approval). Use in tests that need a ready-to-use project.
 *
 * The return value is shaped like a `fetch` Response so existing tests that
 * call `.json()` followed by `.data.id` extraction keep working unchanged
 * after swapping the `app.request(...)` block for `createTestProject(...)`.
 */
export async function createTestProject(
	db: PGlite,
	teamId: string,
	input: {
		name: string;
		description?: string;
		task_prefix?: string;
		initial_prd?: string | null;
		docker_base_image?: string;
	},
): Promise<{
	status: 201;
	json: () => Promise<{ data: CreatedTestProject }>;
}> {
	const captain = await db.query<{ id: string }>(
		`SELECT ma.id FROM member_agents ma
		 JOIN members m ON m.id = ma.id
		 WHERE m.team_id = $1 AND ma.slug = $3 AND ma.admin_status = $2::agent_admin_status
		 LIMIT 1`,
		[teamId, AgentAdminStatus.Enabled, CAPTAIN_AGENT_SLUG],
	);
	const captainMemberId = captain.rows[0]?.id;
	if (!captainMemberId) {
		throw new Error('createTestProject: team has no enabled Captain');
	}

	const prefixResult = await resolveProjectTaskPrefix(db, teamId, input.task_prefix, input.name);
	if (!prefixResult.ok) {
		throw new Error(`createTestProject: ${prefixResult.message}`);
	}

	const slug = await uniqueSlug(toSlug(input.name), async (s) => {
		const r = await db.query('SELECT 1 FROM projects WHERE team_id = $1 AND slug = $2', [
			teamId,
			s,
		]);
		return r.rows.length > 0;
	});

	const { project, planningTask } = await createProjectWithPlanningTask(db, {
		teamId,
		captainMemberId,
		name: input.name,
		slug,
		taskPrefix: prefixResult.prefix,
		description: input.description ?? '',
		dockerBaseImage: input.docker_base_image,
		initialPrd: input.initial_prd ?? null,
	});

	const data: CreatedTestProject = {
		id: project.id as string,
		slug: project.slug as string,
		task_prefix: project.task_prefix as string,
		name: project.name as string,
		description: (project.description as string) ?? '',
		team_id: project.team_id as string,
		is_internal: (project.is_internal as boolean) ?? false,
		docker_base_image: (project.docker_base_image as string) ?? 'hezo/agent-base:latest',
		container_id: (project.container_id as string | null) ?? null,
		container_status: (project.container_status as string | null) ?? null,
		planning_task_id: planningTask.id as string,
		planning_task_identifier: planningTask.identifier as string,
	};

	return {
		status: 201,
		json: async () => ({ data }),
	};
}

export async function finalizeAgentRun(
	db: PGlite,
	runId: string,
	status: 'succeeded' | 'failed' | 'cancelled' | 'timed_out' = 'succeeded',
): Promise<void> {
	await db.query(
		`UPDATE heartbeat_runs SET status = $1::heartbeat_run_status, finished_at = now() WHERE id = $2`,
		[status, runId],
	);
}

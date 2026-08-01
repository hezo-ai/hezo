import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	AgentAdminStatus,
	buildLoginMessage,
	buildUnlockMessage,
	CAPTAIN_AGENT_SLUG,
	deriveAuthKeyPair,
	derivePasswordKeyPair,
	deriveUnlockKey,
	generateMnemonic,
	generatePasswordSalt,
	signAuthMessage,
} from '@hezo/shared';
import type { Hono } from 'hono';
import type { AssetStore } from '../../src/assets/store';
import { encrypt } from '../../src/crypto/encryption';
import { MasterKeyManager } from '../../src/crypto/master-key';
import { loadAgentRoles } from '../../src/db/agent-roles';
import type { Db } from '../../src/db/database';
import { seedBuiltins } from '../../src/db/seed';
import { DomainEventBus } from '../../src/events/bus';
import { getHostMemory } from '../../src/lib/host-memory';
import type { SandboxBackendInfo } from '../../src/lib/sandbox-backend-info';
import { toSlug, uniqueSlug } from '../../src/lib/slug';
import type { Env } from '../../src/lib/types';
import { signAdminJwt, signAgentJwt } from '../../src/middleware/auth';
import { ContainerLogStreamer } from '../../src/services/container-logs';
import { createFakeDockerClient } from '../../src/services/fake-docker';
import { JobManager } from '../../src/services/job-manager';
import { LogStreamBroker } from '../../src/services/log-stream-broker';
import { getMarketplaceTeam } from '../../src/services/marketplace';
import {
	createProjectWithPlanningTask,
	resolveProjectTaskPrefix,
} from '../../src/services/project-create';
import type { SandboxFiles } from '../../src/services/sandbox/files';
import type { ContainerEngine } from '../../src/services/sandbox/types';
import { type CreatedTeamRow, createTeam, seedDefaultTeam } from '../../src/services/teams';
import { WebSocketManager } from '../../src/services/ws';
import { buildApp } from '../../src/startup';
import { seedTestAppTeamTemplate } from './app-team-template';
import { createTestDbWithMigrations } from './db';

// Typed, so the compiler rejects an incomplete stub. AGENTS.md requires every
// inline docker mock to extend this rather than hand-rolling a partial object;
// that only holds if the base itself is complete.
/**
 * The two engine seams a run exercises regardless of what a test is asserting:
 * it stages its prompt and runtime home through `files`, and it opens a tunnel
 * through `openExecChannel` before the first agent exec. An inline mock that
 * omits either fails with "not a function" from deep inside the runner, so
 * spread this into any hand-built engine.
 */
export function stubEngineSeams(): Pick<ContainerEngine, 'files' | 'openExecChannel'> {
	const stub = createStubDocker();
	return { files: stub.files, openExecChannel: stub.openExecChannel };
}

const STUB_DOCKER_METHODS: ContainerEngine = {
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
	findContainerByNamePrefix: async () => null,
	inspectImage: async () => null,
	removeImage: async () => {},
	listContainersByLabel: async () => [],
	inspectNetwork: async () => ({ IPAM: { Config: [{ Gateway: '172.17.0.1' }] } }),
	containerStats: async () => null,
	containerLogs: async () => new Response(new Uint8Array()),
	execCreate: async () => {
		throw new Error('execCreate not mocked — pass a mock docker via RunnerDeps');
	},
	execStart: async () => ({ stdout: '', stderr: '' }),
	execInspect: async () => ({ ExitCode: 0, Running: false, Pid: 0 }),
	// A channel that carries nothing. The tunnel treats a closed channel as
	// fail-closed, so a stubbed engine simply never tunnels.
	openExecChannel: async () => ({
		write: () => {},
		onData: () => {},
		onStderr: () => {},
		onClose: () => {},
		close: () => {},
	}),
	killRunProcesses: async () => {},
	killProcessesByEnvMarker: async () => {},
	listHezoProcesses: async () => [],
	killPids: async () => {},
	diskUsedBytes: async () => null,
	// Same answer the fake gives: a stub engine stands in for the local daemon.
	containerHostMemory: () => getHostMemory(),
	// Same bind-resolved view the fake engine gives, so a test that stages a file
	// through the seam reads it back off disk exactly as a bind mount would.
	files: (containerId: string, containerRoot: string) =>
		createFakeDockerClient().files(containerId, containerRoot),
};

/**
 * The live test app's db + dataDir, so a `createStubDocker()` built anywhere in a
 * spec can resolve container paths to the same workspace the app is using.
 *
 * Most specs construct their own scripted engine with `createStubDocker({...})`
 * and no context, so threading it through every call site would mean touching
 * every spec; the harness records it once instead.
 */
const testContexts: Array<{ db: Db; dataDir: string }> = [];

/** Register a live app so any stub engine can resolve container paths against it. */
function rememberTestContext(db: Db, dataDir: string): void {
	testContexts.unshift({ db, dataDir });
	// Bounded: a worker runs many files, and only the most recent few can still
	// own a live container.
	if (testContexts.length > 8) testContexts.length = 8;
}

/**
 * A {@link SandboxFiles} that resolves against whichever registered app knows
 * the container, deferring the choice to the operation so a context created
 * after the engine still counts.
 */
function firstResolvableFiles(
	candidates: Array<{ db: Db; dataDir: string }>,
	containerId: string,
	containerRoot: string,
): SandboxFiles {
	const pick = async (): Promise<SandboxFiles> => {
		for (const candidate of candidates) {
			try {
				const row = await candidate.db.query<{ id: string }>(
					'SELECT id FROM projects WHERE container_id = $1 LIMIT 1',
					[containerId],
				);
				if (row.rows.length > 0) {
					return createFakeDockerClient(candidate.db, candidate.dataDir).files(
						containerId,
						containerRoot,
					);
				}
			} catch {
				// A closed db from a finished spec - try the next one.
			}
		}
		return createFakeDockerClient(candidates[0]?.db, candidates[0]?.dataDir).files(
			containerId,
			containerRoot,
		);
	};
	return {
		exists: async (p) => (await pick()).exists(p),
		read: async (p) => (await pick()).read(p),
		readBytes: async (p) => (await pick()).readBytes(p),
		size: async (p) => (await pick()).size(p),
		list: async (p) => (await pick()).list(p),
		remove: async (p) => (await pick()).remove(p),
		removeDir: async (p) => (await pick()).removeDir(p),
		findByName: async (d, n, depth) => (await pick()).findByName(d, n, depth),
		write: async (p, c, o) => (await pick()).write(p, c, o),
		writeBytes: async (p, c, o) => (await pick()).writeBytes(p, c, o),
		mkdir: async (p, o) => (await pick()).mkdir(p, o),
	};
}

// `T extends object` rather than `Record<string, unknown>`: an interface type has
// no index signature, so the narrower constraint rejected the perfectly ordinary
// case of passing one stub engine in as the base for another.
export function createStubDocker<T extends object>(
	overrides: T = {} as T,
	ctx?: { db?: Db; dataDir?: string },
): ContainerEngine & T {
	// `files` resolves the container's workspace the way a bind mount would, from
	// the project row - so a test that stages a file through the seam reads it
	// back off disk exactly as it did when the runner used `node:fs` directly.
	// Try each live app in turn: a spec can stand up an isolated context
	// alongside the file-level one, and only the app that actually owns the
	// container can say where its workspace is.
	const candidates =
		ctx?.db && ctx?.dataDir ? [{ db: ctx.db, dataDir: ctx.dataDir }] : testContexts;
	const files: ContainerEngine['files'] = (containerId, containerRoot) =>
		firstResolvableFiles(candidates, containerId, containerRoot);
	return { ...STUB_DOCKER_METHODS, files, ...overrides } as ContainerEngine & T;
}

/**
 * Re-exported from the server's crypto module so tests across packages can
 * import it via the `@hezo/server/test/helpers/app` path the workspace
 * symlink + vitest alias both resolve. Importing from `@hezo/server/crypto/*`
 * directly would only work under the vitest alias, not under TS module
 * resolution.
 */
export { encrypt };

export async function createTestApp(
	opts: {
		webUrl?: string;
		assetStore?: AssetStore;
		/**
		 * Stand in a different engine - the managed-backend shape, say, whose
		 * containers report no host memory. Defaults to the local-daemon stub.
		 */
		docker?: ContainerEngine;
		sandboxBackendInfo?: SandboxBackendInfo;
	} = {},
) {
	const db = await createTestDbWithMigrations();
	const masterKeyManager = new MasterKeyManager();
	const mnemonic = generateMnemonic();
	const unlockKeyHex = deriveUnlockKey(mnemonic);
	const authKeys = deriveAuthKeyPair(mnemonic);
	await masterKeyManager.initialize(db, unlockKeyHex, authKeys.publicKeyHex);
	const roleDocs = await loadAgentRoles();
	await seedBuiltins(db, roleDocs);
	await seedTestAppTeamTemplate(db);
	const dataDir = mkdtempSync(join(tmpdir(), 'hezo-test-'));
	rememberTestContext(db, dataDir);
	const docker = opts.docker ?? createStubDocker({}, { db, dataDir });
	const wsManager = new WebSocketManager();
	const logs = new LogStreamBroker();
	logs.setWsManager(wsManager);
	const containerLogStreamer = new ContainerLogStreamer();
	const events = new DomainEventBus();
	const jobManager = new JobManager({
		db,
		docker,
		masterKeyManager,
		serverPort: 0,
		dataDir,
		wsManager,
		events,
		logs,
		containerLogStreamer,
	});
	const app = buildApp(
		db,
		masterKeyManager,
		{
			dataDir,
			webUrl: opts.webUrl ?? '',
			sandboxBackendInfo: opts.sandboxBackendInfo,
		},
		docker,
		wsManager,
		jobManager,
		logs,
		null,
		null,
		containerLogStreamer,
		events,
		undefined,
		undefined,
		opts.assetStore,
	);
	const userResult = await db.query<{ id: string }>(
		"INSERT INTO users (display_name, is_superuser) VALUES ('Test Admin', true) RETURNING id",
	);
	// Enroll a password verifier so `/api/status` reports passwordSet:true (the web
	// gate lands on the app rather than the create-password step). The plaintext is
	// exposed for auth-flow tests that drive the real challenge/verify login.
	const password = 'test-password';
	const passwordSalt = generatePasswordSalt();
	const passwordKeys = await derivePasswordKeyPair(password, passwordSalt);
	await db.query('UPDATE users SET password_salt = $1, password_public_key = $2 WHERE id = $3', [
		passwordSalt,
		passwordKeys.publicKeyHex,
		userResult.rows[0].id,
	]);
	const token = await signAdminJwt(masterKeyManager, userResult.rows[0].id);

	// Seed the HQ team (CEO + Coach + HQ project). Coordination flows (intake,
	// hiring, coherence, OAuth verification) resolve the CEO from here.
	await seedDefaultTeam({
		db,
		docker,
		dataDir,
		wsManager,
		masterKeyManager,
		logs,
		containerLogStreamer,
	});

	return {
		app,
		db,
		token,
		mnemonic,
		unlockKeyHex,
		authKeys,
		masterKeyManager,
		dataDir,
		password,
		passwordSalt,
	};
}

/**
 * A test app whose master key was never set (state 'unset'): no canary, no
 * enrolled public key, no superuser, no token. Mirrors a fresh production
 * boot, which also seeds the default team before any key exists. For suites
 * exercising /api/auth/setup.
 */
export async function createUnsetTestApp() {
	const db = await createTestDbWithMigrations();
	const masterKeyManager = new MasterKeyManager();
	await masterKeyManager.initialize(db);
	const roleDocs = await loadAgentRoles();
	await seedBuiltins(db, roleDocs);
	await seedTestAppTeamTemplate(db);
	const dataDir = mkdtempSync(join(tmpdir(), 'hezo-test-'));
	rememberTestContext(db, dataDir);
	const docker = createStubDocker({}, { db, dataDir });
	const wsManager = new WebSocketManager();
	const logs = new LogStreamBroker();
	logs.setWsManager(wsManager);
	const containerLogStreamer = new ContainerLogStreamer();
	const events = new DomainEventBus();
	const app = buildApp(
		db,
		masterKeyManager,
		{ dataDir, webUrl: '' },
		docker,
		wsManager,
		undefined,
		logs,
		null,
		null,
		containerLogStreamer,
		events,
	);
	await seedDefaultTeam({
		db,
		docker,
		dataDir,
		wsManager,
		masterKeyManager,
		logs,
		containerLogStreamer,
	});
	return { app, db, masterKeyManager, dataDir };
}

/**
 * Drives the full challenge-response login over the app's HTTP surface and
 * returns the /api/auth/verify response. `includeUnlockKey` mirrors the
 * locked-server flow (signature covers nonce + unlock key). Extra `headers`
 * land on the verify request — the one that captures the instance base URL.
 */
export async function loginViaAuthApi(
	app: Hono<Env>,
	mnemonic: string,
	opts: { headers?: Record<string, string>; includeUnlockKey?: boolean } = {},
): Promise<Response> {
	const headers = { 'Content-Type': 'application/json', ...(opts.headers ?? {}) };
	const challengeRes = await app.request('/api/auth/challenge', { method: 'POST', headers });
	if (challengeRes.status !== 200) return challengeRes;
	const challenge = (await challengeRes.json()) as {
		data: { challenge_id: string; nonce: string };
	};
	const { challenge_id, nonce } = challenge.data;
	const keys = deriveAuthKeyPair(mnemonic);
	const body: Record<string, string> = { challenge_id };
	if (opts.includeUnlockKey) {
		const unlockKeyHex = deriveUnlockKey(mnemonic);
		body.unlock_key = unlockKeyHex;
		body.signature = signAuthMessage(keys.privateKey, buildUnlockMessage(nonce, unlockKeyHex));
	} else {
		body.signature = signAuthMessage(keys.privateKey, buildLoginMessage(nonce));
	}
	return app.request('/api/auth/verify', {
		method: 'POST',
		headers,
		body: JSON.stringify(body),
	});
}

/**
 * Simulates a server restart over the same database: a fresh manager holds no
 * key material, so the canary leaves it 'locked' until an unlock-flow login.
 */
export async function restartTestApp(db: Db, dataDir: string) {
	const masterKeyManager = new MasterKeyManager();
	await masterKeyManager.initialize(db);
	const app = buildApp(db, masterKeyManager, { dataDir, webUrl: '' }, createStubDocker());
	return { app, masterKeyManager };
}

export function authHeader(token: string) {
	return { Authorization: `Bearer ${token}` };
}

export async function createAgentRun(
	db: Db,
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
	db: Db,
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
				`SELECT id FROM projects WHERE team_id = $1 ORDER BY is_internal LIMIT 1`,
				[teamId],
			);
			projectId = fallback.rows[0]?.id;
			if (crossProject === undefined) crossProject = false;
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

/**
 * A team is addressed through its single project. Returns that project's slug,
 * creating it idempotently. Lets tests that used to hit `internal-<teamSlug>`
 * resolve the team's real project handle inline.
 */
export async function projectSlugFor(db: Db, teamId: string): Promise<string> {
	const res = await createTestProject(db, teamId, { name: 'Work Project' });
	return (await res.json()).data.slug;
}

/** Same as {@link projectSlugFor} but keyed by the team's slug. */
export async function projectSlugForTeamSlug(db: Db, teamSlug: string): Promise<string> {
	const t = await db.query<{ id: string }>('SELECT id FROM teams WHERE slug = $1', [teamSlug]);
	return projectSlugFor(db, t.rows[0].id);
}

/** The single instance-level Coach member id (lives in HQ). */
export async function instanceCoachId(db: Db): Promise<string> {
	const r = await db.query<{ id: string }>(
		"SELECT id FROM member_agents WHERE slug = 'coach' LIMIT 1",
	);
	return r.rows[0].id;
}

/** The single instance-level CEO member id (lives in HQ). */
export async function instanceCeoId(db: Db): Promise<string> {
	const r = await db.query<{ id: string }>(
		"SELECT id FROM member_agents WHERE slug = 'ceo' LIMIT 1",
	);
	return r.rows[0].id;
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
 * calling the project service directly. Bypasses the CEO-assisted intake flow
 * that project creation can trigger (an intake ticket and a pending approval).
 * Use in tests that need a ready-to-use project.
 *
 * The return value is shaped like a `fetch` Response so existing tests that
 * call `.json()` followed by `.data.id` extraction keep working unchanged
 * after swapping the `app.request(...)` block for `createTestProject(...)`.
 */
export async function createTestProject(
	db: Db,
	teamId: string,
	input: {
		name: string;
		description?: string;
		task_prefix?: string;
		initial_project_plan?: string | null;
		docker_base_image?: string;
	},
): Promise<{
	status: 201;
	json: () => Promise<{ data: CreatedTestProject }>;
}> {
	// With the 1:1 invariant a team has at most one (non-internal) project. Return
	// it idempotently so a test can set up its project regardless of call order and
	// without tripping the UNIQUE(projects.team_id) constraint on a second call.
	const existing = await db.query<Record<string, unknown>>(
		`SELECT p.*,
		        (SELECT i.id FROM tasks i WHERE i.project_id = p.id AND i.labels @> '["planning"]'::jsonb LIMIT 1) AS planning_task_id,
		        (SELECT i.identifier FROM tasks i WHERE i.project_id = p.id AND i.labels @> '["planning"]'::jsonb LIMIT 1) AS planning_task_identifier
		 FROM projects p WHERE p.team_id = $1 AND p.is_internal = false LIMIT 1`,
		[teamId],
	);
	if (existing.rows[0]) {
		const p = existing.rows[0];
		const data: CreatedTestProject = {
			id: p.id as string,
			slug: p.slug as string,
			task_prefix: p.task_prefix as string,
			name: p.name as string,
			description: (p.description as string) ?? '',
			team_id: p.team_id as string,
			is_internal: (p.is_internal as boolean) ?? false,
			docker_base_image: (p.docker_base_image as string) ?? 'hezo/agent-base:latest',
			container_id: (p.container_id as string | null) ?? null,
			container_status: (p.container_status as string | null) ?? null,
			planning_task_id: (p.planning_task_id as string | null) ?? '',
			planning_task_identifier: (p.planning_task_identifier as string | null) ?? '',
		};
		return { status: 201, json: async () => ({ data }) };
	}

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
		const r = await db.query('SELECT 1 FROM projects WHERE slug = $1', [s]);
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
		initialProjectPlan: input.initial_project_plan ?? null,
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

/**
 * Test-only: stand up a team (roster + optional template) by calling the
 * `createTeam` service directly, the way `POST /api/teams` used to before that
 * route was removed. Returns a `fetch`-Response-shaped object so existing
 * `.json()` → `.data.slug` / `.data.id` extraction in call sites keeps working
 * after swapping the `app.request('/api/teams', { method: 'POST' })` block.
 *
 * `createTeam` provisions no container (only the roster), so the stub docker is
 * never exercised; the throwaway `dataDir` only matters for skill provisioning,
 * which no-ops when no skills are installed (the default test state).
 *
 * Mirrors `POST /api/teams` called with the admin token: the creating admin
 * becomes a member of the new team. Defaults `creatorUserId` to the seeded
 * superuser so admin-authored actions (mentions, reactions, `created_by`,
 * actor names, ui-state) resolve to a real member row, as they did when the
 * route created the team. Pass `creatorUserId` explicitly to override.
 */
export async function createTestTeam(
	db: Db,
	input: {
		name: string;
		description?: string;
		template_id?: string;
		/** Provision a full roster from a marketplace team def (e.g. 'software-development'). */
		marketplace_slug?: string;
		creatorUserId?: string;
	},
): Promise<{ status: 201; json: () => Promise<{ data: CreatedTeamRow }> }> {
	let creatorUserId = input.creatorUserId;
	if (creatorUserId === undefined) {
		const admin = await db.query<{ id: string }>(
			'SELECT id FROM users WHERE is_superuser = true ORDER BY created_at LIMIT 1',
		);
		creatorUserId = admin.rows[0]?.id;
	}
	const marketplaceDef = input.marketplace_slug
		? ((await getMarketplaceTeam(input.marketplace_slug)) ?? undefined)
		: undefined;
	if (input.marketplace_slug && !marketplaceDef) {
		throw new Error(`Marketplace team "${input.marketplace_slug}" not found in test env`);
	}
	const team = await createTeam(
		{
			db,
			docker: createStubDocker(),
			dataDir: mkdtempSync(join(tmpdir(), 'hezo-test-team-')),
		},
		{
			name: input.name.trim(),
			description: input.description,
			templateId: input.template_id,
			marketplaceDef,
			creatorUserId,
		},
	);
	return { status: 201, json: async () => ({ data: team }) };
}

export async function finalizeAgentRun(
	db: Db,
	runId: string,
	status: 'succeeded' | 'failed' | 'cancelled' | 'timed_out' = 'succeeded',
): Promise<void> {
	await db.query(
		`UPDATE heartbeat_runs SET status = $1::heartbeat_run_status, finished_at = now() WHERE id = $2`,
		[status, runId],
	);
}

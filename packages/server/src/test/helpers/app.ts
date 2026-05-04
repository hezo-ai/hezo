import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { PGlite } from '@electric-sql/pglite';
import { generateMasterKey, MasterKeyManager } from '../../crypto/master-key';
import { loadAgentRoles } from '../../db/agent-roles';
import { seedBuiltins } from '../../db/seed';
import { signAgentJwt, signBoardJwt } from '../../middleware/auth';
import type { DockerClient } from '../../services/docker';
import { buildApp } from '../../startup';
import { createTestDbWithMigrations } from './db';

export function createStubDocker(): DockerClient {
	return {
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
		containerLogs: async () => new ReadableStream(),
		execCreate: async () => {
			throw new Error('execCreate not mocked — pass a mock docker via RunnerDeps');
		},
		execStart: async () => ({ stdout: '', stderr: '' }),
		execInspect: async () => ({ ExitCode: 0, Running: false, Pid: 0 }),
	} as unknown as DockerClient;
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
	companyId: string,
	issueId?: string | null,
	wakeupOpts?: { source?: string; payload?: Record<string, unknown> },
): Promise<string> {
	const source = wakeupOpts?.source ?? 'on_demand';
	const payload = wakeupOpts?.payload ?? {};
	const wakeup = await db.query<{ id: string }>(
		`INSERT INTO agent_wakeup_requests (member_id, company_id, source, status, payload, claimed_at)
		 VALUES ($1, $2, $3::wakeup_source, 'claimed'::wakeup_status, $4::jsonb, now())
		 RETURNING id`,
		[agentId, companyId, source, JSON.stringify(payload)],
	);
	const wakeupId = wakeup.rows[0].id;
	const result = await db.query<{ id: string }>(
		`INSERT INTO heartbeat_runs (member_id, company_id, issue_id, wakeup_id, status, started_at)
		 VALUES ($1, $2, $3, $4, 'running'::heartbeat_run_status, now())
		 RETURNING id`,
		[agentId, companyId, issueId ?? null, wakeupId],
	);
	return result.rows[0].id;
}

export async function mintAgentToken(
	db: PGlite,
	masterKeyManager: MasterKeyManager,
	agentId: string,
	companyId: string,
	issueId?: string | null,
): Promise<{ token: string; runId: string }> {
	const runId = await createAgentRun(db, agentId, companyId, issueId);
	const token = await signAgentJwt(masterKeyManager, agentId, companyId, runId);
	return { token, runId };
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

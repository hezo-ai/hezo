// A run that succeeds clears the agent-error notice the give-up paths filed.
//
// `fileLostRunApproval` leaves a pending Strategy approval with an `agent_error`
// payload when an agent burned its retry budget or the provider refused it for
// hours. Nothing but a person used to close it, so an agent that recovered - a
// switched model, a provider back on its feet - kept its stale notice in the
// Inbox. Now the success itself closes it, through the same resolve path a
// human uses. A real strategy proposal in the same Inbox is not touched.
//
// Cribbed from `agent-runner-capacity-park.test.ts` for the app/team/project
// scaffolding and the exit-0 stub docker.

import {
	AgentRuntime,
	ApprovalStatus,
	ApprovalType,
	ContainerStatus,
	WsMessageType,
} from '@hezo/shared';
import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { MasterKeyManager } from '../src/crypto/master-key';
import type { Db } from '../src/db/database';
import type { Env } from '../src/lib/types';
import { type RunnerDeps, runAgent } from '../src/services/agent-runner';
import { LogStreamBroker } from '../src/services/log-stream-broker';
import type { ContainerEngine } from '../src/services/sandbox/types';
import type { WebSocketManager } from '../src/services/ws';
import { safeClose } from './helpers';
import {
	authHeader,
	createStubDocker,
	createTestApp,
	createTestProject,
	createTestTeam,
} from './helpers/app';

let app: Hono<Env>;
let db: Db;
let adminToken: string;
let masterKeyManager: MasterKeyManager;
let dataDir: string;
let teamId: string;
let projectId: string;
let projectSlug: string;
let agentId: string;
let agentSlug: string;

let seq = 0;
function successDocker(): ContainerEngine {
	const base = createStubDocker({
		createContainer: vi.fn(async () => ({ Id: `recover-cid-${seq++}`, Warnings: [] })),
		startContainer: vi.fn(async () => {}),
		execCreate: vi.fn(async () => 'exec-recover'),
		// Flip produced_output the way the MCP tool layer does, so an exit-0 run
		// reads as a genuine success rather than "run produced no output".
		execStart: vi.fn(async () => {
			await db.query(
				`UPDATE heartbeat_runs SET produced_output = true WHERE member_id = $1 AND status = 'running'`,
				[agentId],
			);
			return { stdout: 'done', stderr: '' };
		}),
		execInspect: vi.fn(async () => ({ ExitCode: 0, Running: false, Pid: 0 })),
		inspectContainer: vi.fn(async (id: string) => ({
			Id: id,
			State: { Status: 'running', Running: true, Pid: 1, ExitCode: 0 },
			Config: { Image: 'stub' },
		})),
	});
	return base as unknown as ContainerEngine;
}

function deps(extra: Partial<RunnerDeps> = {}): RunnerDeps {
	return {
		db,
		docker: successDocker(),
		masterKeyManager,
		serverPort: 3000,
		dataDir,
		logs: new LogStreamBroker(),
		...extra,
	};
}

function agent() {
	return { id: agentId, title: 'Recovering Runner', slug: agentSlug, team_id: teamId };
}

function project() {
	return {
		id: projectId,
		slug: projectSlug,
		team_id: teamId,
		team_slug: 'recover-co',
		container_id: null,
		container_status: ContainerStatus.Stopped,
		designated_repo_id: null,
		is_internal: false,
	};
}

async function makeTask(title: string) {
	const res = await app.request(`/api/projects/${projectSlug}/tasks`, {
		method: 'POST',
		headers: { ...authHeader(adminToken), 'Content-Type': 'application/json' },
		body: JSON.stringify({ project_id: projectId, title, assignee_id: agentId }),
	});
	const row = (await res.json()).data;
	return {
		id: row.id as string,
		identifier: row.identifier as string,
		title,
		description: 'Recovery description',
		status: 'backlog',
		priority: 'medium',
		project_id: projectId,
		rules: null,
		progress_summary: null,
		runtime_type: AgentRuntime.ClaudeCode,
	};
}

/** The record `fileLostRunApproval` leaves, inserted the way it inserts it. */
async function insertAgentErrorNotice(memberId: string, message: string): Promise<string> {
	const r = await db.query<{ id: string }>(
		`INSERT INTO approvals (team_id, type, requested_by_member_id, payload)
		 VALUES ($1, $2::approval_type, $3, $4::jsonb) RETURNING id`,
		[
			teamId,
			ApprovalType.Strategy,
			memberId,
			JSON.stringify({
				type: 'agent_error',
				member_id: memberId,
				run_id: null,
				task_id: null,
				last_error: null,
				message,
			}),
		],
	);
	return r.rows[0].id;
}

async function approvalRow(id: string) {
	const r = await db.query<{
		status: string;
		resolution_note: string | null;
		resolved_at: string | null;
	}>('SELECT status, resolution_note, resolved_at FROM approvals WHERE id = $1', [id]);
	return r.rows[0];
}

beforeAll(async () => {
	const ctx = await createTestApp();
	app = ctx.app;
	db = ctx.db;
	adminToken = ctx.token;
	masterKeyManager = ctx.masterKeyManager;
	dataDir = ctx.dataDir;

	const teamRes = await createTestTeam(db, { name: 'Recover Co' });
	teamId = (await teamRes.json()).data.id;

	// The runner resolves a credential before it runs anything; without one
	// every run here fails on configuration instead of succeeding.
	const originalFetch = globalThis.fetch;
	globalThis.fetch = vi.fn().mockResolvedValue({ ok: true }) as unknown as typeof fetch;
	await app.request('/api/ai-providers', {
		method: 'POST',
		headers: { ...authHeader(adminToken), 'Content-Type': 'application/json' },
		body: JSON.stringify({
			provider: 'anthropic',
			api_key: 'sk-ant-recover-key',
			label: 'anthropic-recover',
		}),
	});
	globalThis.fetch = originalFetch;

	const projectRes = await createTestProject(db, teamId, {
		name: 'Recover Project',
		description: 'Agent-error recovery project.',
	});
	const projectData = (await projectRes.json()).data;
	projectId = projectData.id;
	projectSlug = projectData.slug;

	const agentsRes = await app.request(`/api/projects/${projectSlug}/agents`, {
		headers: authHeader(adminToken),
	});
	const agentRow = (await agentsRes.json()).data[0];
	agentId = agentRow.id;
	agentSlug = agentRow.slug;
});

afterAll(async () => {
	await safeClose(db);
});

describe('runAgent clears the agent-error notice on recovery', () => {
	it('resolves the pending notice and broadcasts it, leaving a real proposal alone', async () => {
		const notice = await insertAgentErrorNotice(
			agentId,
			'The model provider has been refusing this agent runs for over 120 minutes.',
		);
		// A genuine strategy proposal from the same agent - the payload the card
		// renders with Approve/Deny - must survive its author's next success.
		const proposal = await db.query<{ id: string }>(
			`INSERT INTO approvals (team_id, type, requested_by_member_id, payload)
			 VALUES ($1, $2::approval_type, $3, $4::jsonb) RETURNING id`,
			[teamId, ApprovalType.Strategy, agentId, JSON.stringify({ plan: 'Ship the launch plan' })],
		);
		const broadcast = vi.fn();
		const wsManager = { broadcast } as unknown as WebSocketManager;

		const task = await makeTask('Recovers');
		const result = await runAgent(deps({ wsManager }), agent(), task, project());
		expect(result.success).toBe(true);

		const closed = await approvalRow(notice);
		expect(closed.status).toBe(ApprovalStatus.Approved);
		expect(closed.resolution_note).toBe(`Agent recovered on run ${result.heartbeatRunId}.`);
		expect(closed.resolved_at).not.toBeNull();

		const kept = await approvalRow(proposal.rows[0].id);
		expect(kept.status).toBe(ApprovalStatus.Pending);
		expect(kept.resolved_at).toBeNull();

		// The Inbox learns about it the way it learns about a human resolve.
		const approvalUpdates = broadcast.mock.calls.filter(
			([, event]) =>
				event.type === WsMessageType.RowChange &&
				event.table === 'approvals' &&
				event.action === 'UPDATE',
		);
		expect(approvalUpdates).toHaveLength(1);
		expect(approvalUpdates[0][1].row.id).toBe(notice);
	});

	it('writes nothing when no notice is pending', async () => {
		// A notice already closed by hand - the row that must not be rewritten.
		const notice = await insertAgentErrorNotice(agentId, 'Agent has failed 3 consecutive times.');
		await db.query(
			`UPDATE approvals SET status = $1::approval_status, resolution_note = 'closed by hand',
			   resolved_at = now() - interval '1 hour' WHERE id = $2`,
			[ApprovalStatus.Approved, notice],
		);
		const before = await approvalRow(notice);

		const task = await makeTask('Recovers again');
		const result = await runAgent(deps(), agent(), task, project());
		expect(result.success).toBe(true);

		const after = await approvalRow(notice);
		expect(after).toEqual(before);
	});
});

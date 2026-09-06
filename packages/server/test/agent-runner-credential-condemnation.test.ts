// What a run does to the stored credential when the provider refuses it.
//
// A run classified `auth` used to leave the config `verified`, so the next
// dispatch selected the same dead credential and spent another container proving
// the same thing - indefinitely, under a green badge. It is now taken out of
// service, but only on the provider's own answer to a second, server-side
// question.
//
// That second question is what these tests are really about. `auth` is matched on
// the runtime's error text and that match includes a bare `401`, which an agent's
// own failed `curl` produces as readily as a refused model call - and the
// credential is instance-wide, so condemning on the text alone would let one
// agent disable every team. The pair below pins both directions.
//
// Harness cribbed from `agent-runner-provider-refusal.test.ts`.

import { AiProviderStatus, ContainerStatus } from '@hezo/shared';
import type { Hono } from 'hono';
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import type { MasterKeyManager } from '../src/crypto/master-key';
import type { Db } from '../src/db/database';
import type { Env } from '../src/lib/types';
import { type RunnerDeps, runAgent } from '../src/services/agent-runner';
import { LogStreamBroker } from '../src/services/log-stream-broker';
import type { ContainerEngine } from '../src/services/sandbox/types';
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

/** Captured before any test swaps it, so teardown restores the real one. */
const REAL_FETCH = globalThis.fetch;

/**
 * A container whose agent CLI writes `events` to stdout and exits `exitCode`.
 *
 * The stream is the whole input to this feature, so it is fed through the same
 * `onChunk` path production uses rather than by poking the parser directly.
 */
function authFailureDocker(events: unknown[], exitCode = 1): ContainerEngine {
	const stream = `${events.map((e) => JSON.stringify(e)).join('\n')}\n`;
	const base = createStubDocker({
		createContainer: vi.fn(async () => ({ Id: `authfail-cid-${seq++}`, Warnings: [] })),
		startContainer: vi.fn(async () => {}),
		execCreate: vi.fn(async () => 'exec-authfail'),
		execStart: vi.fn(
			async (
				_id: string,
				opts?: { onChunk?: (c: { stream: string; text: string }) => Promise<void> },
			) => {
				// Honour the streaming contract: supplying `onChunk` means the exec
				// retains nothing, so a stub that also returned the transcript would let
				// this pass against a contract production does not offer.
				await opts?.onChunk?.({ stream: 'stdout', text: stream });
				return { stdout: '', stderr: '' };
			},
		),
		execInspect: vi.fn(async () => ({ ExitCode: exitCode, Running: false, Pid: 0 })),
		inspectContainer: vi.fn(async (id: string) => ({
			Id: id,
			State: { Status: 'running', Running: true, Pid: 1, ExitCode: 0 },
			Config: { Image: 'stub' },
		})),
	});
	return base as unknown as ContainerEngine;
}

function deps(docker: ContainerEngine, extra: Partial<RunnerDeps> = {}): RunnerDeps {
	return {
		db,
		docker,
		masterKeyManager,
		serverPort: 3000,
		dataDir,
		logs: new LogStreamBroker(),
		...extra,
	};
}

function agent() {
	return { id: agentId, title: 'Auth Fail Runner', slug: agentSlug, team_id: teamId };
}

function project() {
	return {
		id: projectId,
		slug: projectSlug,
		team_id: teamId,
		team_slug: 'auth-fail-co',
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
		description: 'Auth fail description',
		status: 'backlog',
		priority: 'medium',
		project_id: projectId,
		rules: null,
		progress_summary: null,
		runtime_type: 'codex' as const,
	};
}

async function runRow(id: string) {
	const r = await db.query<{
		status: string;
		error: string | null;
		input_tokens: number | null;
		output_tokens: number | null;
	}>('SELECT status, error, input_tokens, output_tokens FROM heartbeat_runs WHERE id = $1', [id]);
	return r.rows[0];
}

/** What a CLI prints when the provider rejects the credential it was handed. */
const AUTH_TURN = {
	type: 'turn.failed',
	error: { message: 'stream error: 401 Unauthorized' },
	usage: {},
};

/**
 * Answer the provider probe with `status`, leaving every other fetch alone.
 *
 * Scoped to the provider host on purpose: a blanket stub would also answer
 * whatever else the run reaches for, and the assertion would stop being about
 * the probe.
 */
function probeAnswers(status: number): typeof fetch {
	return vi.fn(async (input: RequestInfo | URL) => {
		const url = typeof input === 'string' ? input : input.toString();
		if (url.includes('api.openai.com')) {
			return { ok: status >= 200 && status < 300, status } as Response;
		}
		return { ok: true, status: 200 } as Response;
	}) as unknown as typeof fetch;
}

async function providerStatus(): Promise<string> {
	const row = await db.query<{ status: string }>(
		"SELECT status FROM ai_provider_configs WHERE label = 'openai-authfail'",
	);
	return row.rows[0].status;
}

async function pendingCredentialNotices(): Promise<number> {
	const rows = await db.query(
		`SELECT 1 FROM approvals
		 WHERE status = 'pending'::approval_status
		   AND payload->>'type' = 'agent_error'
		   AND payload->>'message' ILIKE '%marked it invalid%'`,
	);
	return rows.rows.length;
}

beforeAll(async () => {
	const ctx = await createTestApp();
	app = ctx.app;
	db = ctx.db;
	adminToken = ctx.token;
	masterKeyManager = ctx.masterKeyManager;
	dataDir = ctx.dataDir;

	const teamRes = await createTestTeam(db, { name: 'Auth Fail Co' });
	teamId = (await teamRes.json()).data.id;

	// Codex runs on the OpenAI credential; without one every run here fails on
	// configuration long before it reaches the stream.
	const originalFetch = globalThis.fetch;
	globalThis.fetch = vi.fn().mockResolvedValue({ ok: true }) as unknown as typeof fetch;
	await app.request('/api/ai-providers', {
		method: 'POST',
		headers: { ...authHeader(adminToken), 'Content-Type': 'application/json' },
		body: JSON.stringify({
			provider: 'openai',
			api_key: 'sk-authfail-key',
			label: 'openai-authfail',
		}),
	});
	globalThis.fetch = originalFetch;

	const projectRes = await createTestProject(db, teamId, {
		name: 'Auth Fail Project',
		description: 'Auth failure project.',
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

describe('runAgent credential condemnation', () => {
	afterEach(async () => {
		globalThis.fetch = REAL_FETCH;
		await db.query('DELETE FROM approvals');
		await db.query("UPDATE ai_provider_configs SET status = $1 WHERE label = 'openai-authfail'", [
			AiProviderStatus.Verified,
		]);
	});

	it('takes the credential out of service when the provider confirms it is refused', async () => {
		const task = await makeTask('Refused credential');
		globalThis.fetch = probeAnswers(401);

		const result = await runAgent(
			deps(authFailureDocker([{ type: 'thread.started', model: 'gpt-5-codex' }, AUTH_TURN])),
			agent(),
			task,
			project(),
		);

		expect(result.success).toBe(false);
		expect(result.heartbeatRunId).toBeDefined();
		const row = await runRow(result.heartbeatRunId as string);
		expect(row.status).toBe('failed');
		expect(row.error).toContain('AI provider authentication failed');

		// The point of the whole change: the badge now follows the provider, so the
		// next dispatch does not select this credential at all.
		expect(await providerStatus()).toBe(AiProviderStatus.Invalid);
		expect(await pendingCredentialNotices()).toBe(1);
	});

	it('leaves the credential alone when the provider does not confirm it', async () => {
		const task = await makeTask('Agent own 401');
		// The same `401` in the run's error, but the provider itself is fine - the
		// shape of an agent whose own tool call was refused by some unrelated API.
		// Condemning here would disable every team on this instance on the strength
		// of one agent's failed request.
		globalThis.fetch = probeAnswers(200);

		const result = await runAgent(
			deps(authFailureDocker([{ type: 'thread.started', model: 'gpt-5-codex' }, AUTH_TURN])),
			agent(),
			task,
			project(),
		);

		expect(result.success).toBe(false);
		expect(await providerStatus()).toBe(AiProviderStatus.Verified);
		expect(await pendingCredentialNotices()).toBe(0);
	});
});

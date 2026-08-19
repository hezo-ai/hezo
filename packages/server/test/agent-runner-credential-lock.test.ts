// The credential wait: what a run does while another run holds the rotating
// provider credential.
//
// Before this, the wait was an unbounded promise chain taken *after* the run had
// already claimed a container. A holder that never returned parked every later
// run on that credential forever, and each waiter pinned a container's memory
// for the whole wait - memory the pool counts as used and cannot reclaim. The
// containers then went idle while their runs waited, the backend stopped them
// underneath, and the runs failed on the first call they made.
//
// So the two properties asserted here are: the wait is bounded and hands the
// work back, and a waiter holds no container while it waits.

import { readFileSync } from 'node:fs';
import {
	AgentRuntime,
	AiAuthMethod,
	AiProvider,
	ContainerStatus,
	setCredentialSerializationRulesForTest,
	WakeupSkipReason,
} from '@hezo/shared';
import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { MasterKeyManager } from '../src/crypto/master-key';
import type { Db } from '../src/db/database';
import { runLogTextSql } from '../src/db/run-log-chunks';
import type { Env } from '../src/lib/types';
import {
	acquireCredentialLock,
	type CredentialLockHolder,
	credentialLockHolder,
	type RunnerDeps,
	runAgent,
} from '../src/services/agent-runner';
import { updateAiProviderCredential } from '../src/services/ai-provider-keys';
import { LogStreamBroker } from '../src/services/log-stream-broker';
import { getHostSubscriptionRoot } from '../src/services/runtime-home';
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
let configId: string;

/** A Codex subscription blob, the one credential shape that rotates. */
const AUTH_JSON = JSON.stringify({
	tokens: {
		id_token: 'header.payload.sig',
		access_token: 'header.payload.sig',
		refresh_token: 'rt-original',
		account_id: 'acct-1',
	},
});

let seq = 0;
let execCount = 0;

/** A run that starts, execs once and produces output; `hooks` observe the exec. */
function stubDocker(
	hooks: { onExecCreate?: (opts: { Env?: string[] }) => void; onExecStart?: () => void } = {},
): ContainerEngine {
	const base = createStubDocker(
		{
			createContainer: vi.fn(async () => ({ Id: `cred-cid-${seq++}`, Warnings: [] })),
			startContainer: vi.fn(async () => {}),
			execCreate: vi.fn(async (_id: string, opts: { Env?: string[] }) => {
				execCount++;
				hooks.onExecCreate?.(opts);
				return 'exec-cred';
			}),
			execStart: vi.fn(async () => {
				hooks.onExecStart?.();
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
		},
		{ db, dataDir },
	);
	return base as unknown as ContainerEngine;
}

function deps(extra: Partial<RunnerDeps> = {}): RunnerDeps {
	return {
		db,
		docker: stubDocker(),
		masterKeyManager,
		serverPort: 3000,
		dataDir,
		logs: new LogStreamBroker(),
		...extra,
	};
}

function agent() {
	return { id: agentId, title: 'Credential Runner', slug: agentSlug, team_id: teamId };
}

function project() {
	return {
		id: projectId,
		slug: projectSlug,
		team_id: teamId,
		team_slug: 'cred-co',
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
		description: 'Credential lock description',
		status: 'backlog',
		priority: 'medium',
		project_id: projectId,
		rules: null,
		progress_summary: null,
		runtime_type: AgentRuntime.Codex,
	};
}

async function runLog(id: string): Promise<string> {
	const r = await db.query<{ log_text: string }>(
		`SELECT ${runLogTextSql('heartbeat_runs.id')} AS log_text FROM heartbeat_runs WHERE id = $1`,
		[id],
	);
	return r.rows[0].log_text;
}

async function runRow(id: string) {
	const r = await db.query<{
		status: string;
		queued_reason: string | null;
		started_at: string | null;
		container_id: string | null;
		error: string | null;
		cancel_reason: string | null;
	}>(
		`SELECT status, queued_reason, started_at, container_id, error, cancel_reason
		   FROM heartbeat_runs WHERE id = $1`,
		[id],
	);
	return r.rows[0];
}

/** The queued row this agent is currently sitting on, once it appears. */
async function waitForQueuedRow(reason: string) {
	return vi.waitFor(
		async () => {
			const rows = await db.query<{ id: string; container_id: string | null }>(
				`SELECT id, container_id FROM heartbeat_runs
				  WHERE member_id = $1 AND status = 'queued' AND queued_reason = $2
				  ORDER BY created_at DESC LIMIT 1`,
				[agentId, reason],
			);
			expect(rows.rows).toHaveLength(1);
			return rows.rows[0];
		},
		{ timeout: 10_000, interval: 20 },
	);
}

beforeAll(async () => {
	const ctx = await createTestApp();
	app = ctx.app;
	db = ctx.db;
	adminToken = ctx.token;
	masterKeyManager = ctx.masterKeyManager;
	dataDir = ctx.dataDir;

	const teamRes = await createTestTeam(db, { name: 'Cred Co' });
	teamId = (await teamRes.json()).data.id;

	const originalFetch = globalThis.fetch;
	globalThis.fetch = vi.fn().mockResolvedValue({ ok: true }) as unknown as typeof fetch;
	await app.request('/api/ai-providers', {
		method: 'POST',
		headers: { ...authHeader(adminToken), 'Content-Type': 'application/json' },
		body: JSON.stringify({
			provider: AiProvider.OpenAI,
			api_key: AUTH_JSON,
			auth_method: AiAuthMethod.Subscription,
			label: 'openai-credential-lock',
		}),
	});
	globalThis.fetch = originalFetch;
	configId = (
		await db.query<{ id: string }>(
			`SELECT id FROM ai_provider_configs WHERE provider = 'openai' LIMIT 1`,
		)
	).rows[0].id;

	const projectRes = await createTestProject(db, teamId, {
		name: 'Cred Project',
		description: 'Credential lock project.',
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

// No credential serialises its runs in production today; the whole mechanism is
// kept wired for a future opt-in. Exercise it by making a Codex subscription
// serialise for the duration of these tests, then restore the empty default.
beforeAll(() => {
	setCredentialSerializationRulesForTest([
		{ runtime: AgentRuntime.Codex, authMethod: AiAuthMethod.Subscription },
	]);
});
afterAll(() => {
	setCredentialSerializationRulesForTest([]);
});

describe('runAgent credential wait', () => {
	it('holds no container while it waits behind another run', async () => {
		const task = await makeTask('Waits without a container');
		const release = await acquireCredentialLock(configId, {
			owner: { label: 'prior-run', link: null },
		});

		const pending = runAgent(deps({ capacityPark: { pollMs: 10, maxMs: 20_000 } }), agent(), task, {
			...project(),
		});

		const queued = await waitForQueuedRow('waiting for prior run on this credential');
		// The whole point of taking the lock first: a waiter has claimed nothing,
		// so its memory is not charged against the instance budget and no container
		// sits idle long enough for the backend to stop it.
		expect(queued.container_id).toBeNull();
		const claimed = await db.query(
			`SELECT 1 FROM container_pool_members WHERE state = 'busy' AND project_id = $1`,
			[projectId],
		);
		expect(claimed.rows).toHaveLength(0);

		release();
		const result = await pending;
		expect(result.success).toBe(true);

		const row = await runRow(result.heartbeatRunId as string);
		expect(row.status).toBe('succeeded');
		// Cleared on the way past, so a terminal row never reads as though the wait
		// were its outcome.
		expect(row.queued_reason).toBeNull();
	});

	it('gives the work back to the queue as cancelled once the wait ceiling passes', async () => {
		const task = await makeTask('Waits then gives up');
		const release = await acquireCredentialLock(configId, {
			owner: { label: 'prior-run', link: null },
		});
		try {
			const result = await runAgent(
				deps({ capacityPark: { pollMs: 10, maxMs: 60 } }),
				agent(),
				task,
				project(),
			);

			// Cancelled and requeued, never failed: a busy credential is the
			// instance being busy, not the agent failing, so no failure ping and no
			// lost-run strike.
			expect(result.requeued).toBe(true);
			// Which wait gave up, named at the source. The seam honours whatever it
			// is handed, so only an assertion here can catch this caller choosing
			// the wrong one - and it used to hand over `instance_at_capacity`
			// regardless, which has the idle pass reclaim the project's container
			// out from under work that is only waiting for a credential.
			expect(result.requeueReason).toBe(WakeupSkipReason.CredentialBusy);

			const row = await runRow(result.heartbeatRunId as string);
			expect(row.status).toBe('cancelled');
			// Names who it was waiting on, in the label alone - the row's `error` is
			// shown as a one-line summary, and the log line already carries the link.
			expect(row.error).toBe(
				'prior-run still holds this provider credential - returning this run to the queue.',
			);
			expect(row.container_id).toBeNull();
			// And no attribution yet: whether the work is actually carried is not
			// known until the caller settles the wakeup, so the row must not claim
			// `handed_back` here. `JobManager.settleWakeupForRun` records it once the
			// answer is in, and records `abandoned` when the handback fails.
			expect(row.cancel_reason).toBeNull();
		} finally {
			release();
		}
	});

	it('leaves nothing the orphan pass would reap after giving up', async () => {
		const task = await makeTask('Leaves nothing stranded');
		const release = await acquireCredentialLock(configId, {
			owner: { label: 'prior-run', link: null },
		});
		try {
			await runAgent(deps({ capacityPark: { pollMs: 10, maxMs: 60 } }), agent(), task, project());
		} finally {
			release();
		}

		const stranded = await db.query(
			`SELECT 1 FROM heartbeat_runs WHERE task_id = $1 AND status IN ('queued', 'running')`,
			[task.id],
		);
		expect(stranded.rows).toHaveLength(0);
	});

	it('finalizes as cancelled without executing when aborted during the wait', async () => {
		const task = await makeTask('Aborted while waiting');
		const release = await acquireCredentialLock(configId, {
			owner: { label: 'prior-run', link: null },
		});
		const ac = new AbortController();
		const before = execCount;

		const pending = runAgent(
			deps({ capacityPark: { pollMs: 10, maxMs: 20_000 } }),
			agent(),
			task,
			project(),
			undefined,
			ac.signal,
		);
		await waitForQueuedRow('waiting for prior run on this credential');

		ac.abort();
		const result = await pending;
		release();

		expect(result.success).toBe(false);
		expect(execCount).toBe(before);
		const row = await runRow(result.heartbeatRunId as string);
		expect(row.status).toBe('cancelled');
	});

	// The token burn: the orphan pass reaps a waiting run's row without touching
	// its abort signal, so nothing downstream of the wait ever learned the run was
	// over. `markHeartbeatRunRunning` is guarded on `queued`, silently did nothing,
	// and the agent executed in full against a row the UI reported as cancelled.
	it('does not execute when its row was ended while it waited', async () => {
		const task = await makeTask('Reaped while waiting');
		const release = await acquireCredentialLock(configId, {
			owner: { label: 'prior-run', link: null },
		});
		const before = execCount;

		const pending = runAgent(
			deps({ capacityPark: { pollMs: 10, maxMs: 20_000 } }),
			agent(),
			task,
			project(),
		);
		const queued = await waitForQueuedRow('waiting for prior run on this credential');

		// Exactly what the orphan pass does, and it never touches the run's signal.
		await db.query(
			`UPDATE heartbeat_runs SET status = 'cancelled', finished_at = now(), exit_code = -1,
			        error = 'Orphaned: nothing was driving this run any more'
			  WHERE id = $1`,
			[queued.id],
		);

		release();
		const result = await pending;

		expect(result.success).toBe(false);
		expect(execCount).toBe(before);
		const row = await runRow(queued.id);
		// The reaper's verdict stands: the run must not overwrite it either.
		expect(row.status).toBe('cancelled');
		expect(row.error).toContain('Orphaned');
		expect(row.started_at).toBeNull();
	});

	it('names the run holding the credential in its log, as a link to that run', async () => {
		const task = await makeTask('Names the holder');
		const release = await acquireCredentialLock(configId, {
			owner: {
				label: 'growth-analyst/HM-336',
				link: { projectSlug: 'hezo-marketing', agentSlug: 'growth-analyst', runId: 'run-hm-336' },
			},
		});
		const pending = runAgent(deps({ capacityPark: { pollMs: 10, maxMs: 20_000 } }), agent(), task, {
			...project(),
		});
		await waitForQueuedRow('waiting for prior run on this credential');
		release();
		const result = await pending;
		expect(result.success).toBe(true);

		const log = await runLog(result.heartbeatRunId as string);
		// The label reads as the holder's name; the href is what the viewer turns
		// into the link to the run's page in its own project.
		expect(log).toContain(
			'Waiting for [growth-analyst/HM-336](/projects/hezo-marketing/agents/growth-analyst/executions/run-hm-336) to finish with this credential.',
		);
		expect(log).toContain('Credential free, starting the run.');
	});

	it('names a holder that is not a run by its label alone', async () => {
		const task = await makeTask('Names the chat');
		const release = await acquireCredentialLock(configId, {
			owner: { label: 'the CEO chat', link: null },
		});
		const pending = runAgent(deps({ capacityPark: { pollMs: 10, maxMs: 20_000 } }), agent(), task, {
			...project(),
		});
		await waitForQueuedRow('waiting for prior run on this credential');
		release();
		const result = await pending;
		expect(await runLog(result.heartbeatRunId as string)).toContain(
			'Waiting for the CEO chat to finish with this credential.',
		);
	});

	it('holds the credential under its own name and run, for later waiters to point at', async () => {
		const task = await makeTask('Is a holder itself');
		let holderDuringExec: CredentialLockHolder | null = null;
		const docker = stubDocker({
			onExecStart: () => {
				holderDuringExec = credentialLockHolder(configId);
			},
		});

		const result = await runAgent(deps({ docker }), agent(), task, project());
		expect(result.success).toBe(true);
		expect(holderDuringExec).toEqual({
			label: `${agentSlug}/${task.identifier}`,
			link: { projectSlug, agentSlug, runId: result.heartbeatRunId },
		});
		expect(credentialLockHolder(configId)).toBeNull();
	});

	it('starts on the credential stored while it waited, not on its pre-wait snapshot', async () => {
		const task = await makeTask('Starts on the current token');
		const rotatedByHolder = JSON.stringify({
			tokens: {
				id_token: 'header.payload.sig2',
				access_token: 'header.payload.sig2',
				refresh_token: 'rt-rotated-by-holder',
				account_id: 'acct-1',
			},
		});
		let mounted: string | null = null;
		const docker = stubDocker({
			onExecCreate: (opts) => {
				const home = (opts.Env ?? []).find((e) => e.startsWith('CODEX_HOME='));
				const runId = home?.slice('CODEX_HOME='.length).split('/').pop() ?? '';
				const root = getHostSubscriptionRoot(
					AiProvider.OpenAI,
					AgentRuntime.Codex,
					dataDir,
					teamId,
					projectId,
					runId,
				);
				mounted = readFileSync(`${root}/auth.json`, 'utf8');
			},
		});

		const release = await acquireCredentialLock(configId, {
			owner: { label: 'prior-run', link: null },
		});
		const pending = runAgent(
			deps({ docker, capacityPark: { pollMs: 10, maxMs: 20_000 } }),
			agent(),
			task,
			project(),
		);
		await waitForQueuedRow('waiting for prior run on this credential');
		// What the holder does on its way out: the single-use token it consumed is
		// replaced in the store. A waiter that mounted its pre-wait snapshot would
		// start on the consumed one.
		await updateAiProviderCredential(db, masterKeyManager, configId, rotatedByHolder);
		release();

		const result = await pending;
		expect(result.success).toBe(true);
		expect(mounted).toBe(rotatedByHolder);

		await updateAiProviderCredential(db, masterKeyManager, configId, AUTH_JSON);
	});
});

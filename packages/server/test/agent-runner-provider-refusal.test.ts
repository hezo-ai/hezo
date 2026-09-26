// What a run does when the model provider refuses it before the agent gets a turn.
//
// The reported case: Codex emits `turn.failed` carrying "Selected model is at
// capacity" with no usage, exits non-zero, and the run was recorded terminally
// failed with the work dropped. Zero tokens in and out means the agent never got
// an attempt, so the work is handed back instead - but only once the run has also
// proved it spent nothing and wrote nothing, which is what the third case here
// pins. The classification reads phrasing; the preconditions are what make a
// false positive unable to discard work.
//
// Cribbed from `agent-runner-capacity-park.test.ts` for the app/team/project
// scaffolding and the stub-docker shape.

import { ContainerStatus, WakeupSkipReason } from '@hezo/shared';
import type { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import type { MasterKeyManager } from '../src/crypto/master-key';
import type { Db } from '../src/db/database';
import type { Env } from '../src/lib/types';
import { type RunnerDeps, runAgent } from '../src/services/agent-runner';
import { recordCredentialAllowance } from '../src/services/ai-provider-keys';
import { LogStreamBroker } from '../src/services/log-stream-broker';
import {
	ALLOWANCE_PACE_RECHECK_MIN,
	USAGE_HOLD_PROBE_MIN,
	usageHoldWait,
} from '../src/services/provider-credential-health';
import type { ContainerEngine } from '../src/services/sandbox/types';
import { settleWakeupForRun } from '../src/services/wakeup';
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

/**
 * A container whose agent CLI writes `events` to stdout and exits `exitCode`.
 *
 * The stream is the whole input to this feature, so it is fed through the same
 * `onChunk` path production uses rather than by poking the parser directly.
 */
function refusalDocker(events: unknown[], exitCode = 1): ContainerEngine {
	const stream = `${events.map((e) => JSON.stringify(e)).join('\n')}\n`;
	const base = createStubDocker({
		createContainer: vi.fn(async () => ({ Id: `refusal-cid-${seq++}`, Warnings: [] })),
		startContainer: vi.fn(async () => {}),
		execCreate: vi.fn(async () => 'exec-refusal'),
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
	return { id: agentId, title: 'Refusal Runner', slug: agentSlug, team_id: teamId };
}

function project() {
	return {
		id: projectId,
		slug: projectSlug,
		team_id: teamId,
		team_slug: 'refusal-co',
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
		description: 'Refusal description',
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

const CAPACITY_TURN = {
	type: 'turn.failed',
	error: { message: 'Selected model is at capacity. Please try a different model.' },
	usage: {},
};

beforeAll(async () => {
	const ctx = await createTestApp();
	app = ctx.app;
	db = ctx.db;
	adminToken = ctx.token;
	masterKeyManager = ctx.masterKeyManager;
	dataDir = ctx.dataDir;

	const teamRes = await createTestTeam(db, { name: 'Refusal Co' });
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
			api_key: 'sk-refusal-key',
			label: 'openai-refusal',
		}),
	});
	globalThis.fetch = originalFetch;

	const projectRes = await createTestProject(db, teamId, {
		name: 'Refusal Project',
		description: 'Provider refusal project.',
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

describe('runAgent provider refusal', () => {
	it('hands the work back as cancelled when the provider refused before a turn', async () => {
		const task = await makeTask('Refused at capacity');
		const result = await runAgent(
			deps(refusalDocker([{ type: 'thread.started', model: 'gpt-5-codex' }, CAPACITY_TURN])),
			agent(),
			task,
			project(),
		);

		expect(result.requeue).toBeDefined();
		expect(result.requeue?.reason).toBe(WakeupSkipReason.ProviderAtCapacity);

		const row = await runRow(result.heartbeatRunId as string);
		// Cancelled, never failed: the provider being full is not the agent failing,
		// and nothing should post a failure ping for a run that burned nothing.
		expect(row.status).toBe('cancelled');
		expect(row.error).toContain('at capacity');
		expect(row.error).toContain('returning this run to the queue');

		// The handback is only real once the wakeup carries the work again, and the
		// reason it carries is what the dispatcher's cooldown reads. Settled here
		// rather than asserted on the thread: `postFailurePing` is the job manager's,
		// and it already returns early for every requeued run - so a "no ping"
		// assertion against `runAgent` alone would pass whatever this path did.
		const wakeup = await db.query<{ id: string }>(
			`INSERT INTO agent_wakeup_requests (member_id, team_id, source, status, payload)
			 VALUES ($1, $2, 'timer', 'claimed', $3::jsonb) RETURNING id`,
			[agentId, teamId, JSON.stringify({ task_id: task.id })],
		);
		if (!result.requeue) throw new Error('expected a handback');
		const settled = await settleWakeupForRun(db, wakeup.rows[0].id, {
			kind: 'handback',
			...result.requeue,
		});
		expect(settled.kind).toBe('requeued');

		const back = await db.query<{ status: string; last_skipped_reason: string | null }>(
			'SELECT status, last_skipped_reason FROM agent_wakeup_requests WHERE id = $1',
			[wakeup.rows[0].id],
		);
		expect(back.rows[0].status).toBe('queued');
		expect(back.rows[0].last_skipped_reason).toBe(WakeupSkipReason.ProviderAtCapacity);
	});

	it('routes a spent subscription allowance to its own, longer cooldown', async () => {
		const task = await makeTask('Refused on usage limit');
		const result = await runAgent(
			deps(
				refusalDocker([
					{ type: 'turn.failed', error: { message: 'usage limit reached' }, usage: {} },
				]),
			),
			agent(),
			task,
			project(),
		);

		expect(result.requeue).toBeDefined();
		// A different clock from capacity: this one resets in hours, not minutes.
		expect(result.requeue?.reason).toBe(WakeupSkipReason.ProviderUsageLimit);
	});

	it('still fails terminally when the failure is not a provider refusal', async () => {
		// The negative case that keeps this from becoming a blanket retry on any
		// failed run.
		const task = await makeTask('Fails for its own reasons');
		const result = await runAgent(
			deps(
				refusalDocker([
					{
						type: 'turn.failed',
						error: { message: 'the sandbox refused this command' },
						usage: {},
					},
				]),
			),
			agent(),
			task,
			project(),
		);

		expect(result.requeue).toBeUndefined();
		const row = await runRow(result.heartbeatRunId as string);
		expect(row.status).toBe('failed');
		expect(row.error).toContain('sandbox refused this command');
	});

	it('fails a run on a credential with no model rather than letting its CLI choose', async () => {
		await db.query(
			`UPDATE ai_provider_configs SET default_model = NULL WHERE label = 'openai-refusal'`,
		);
		try {
			const docker = refusalDocker(WORKED_TURN, 0);
			const result = await runAgent(deps(docker), agent(), await makeTask('No model'), project());
			const row = await runRow(result.heartbeatRunId as string);
			expect(row.status).toBe('failed');
			expect(row.error).toContain('has no default model');
			expect(docker.execStart).not.toHaveBeenCalled();
		} finally {
			await db.query(
				`UPDATE ai_provider_configs SET default_model = 'gpt-5.6-sol' WHERE label = 'openai-refusal'`,
			);
		}
	});

	it('does not hand back a refusal that arrived after the run had already spent tokens', async () => {
		// The precondition carrying the most weight. "Never got a turn" is a fact the
		// run reports about itself; a mid-stream 503 after real work must not
		// discard it, and the classification alone cannot tell the two apart.
		const task = await makeTask('Refused mid-run');
		const result = await runAgent(
			deps(
				refusalDocker([
					{ type: 'thread.started', model: 'gpt-5-codex' },
					{
						type: 'turn.failed',
						error: { message: 'API Error: 529 overloaded' },
						usage: { input_tokens: 1200, output_tokens: 300 },
					},
				]),
			),
			agent(),
			task,
			project(),
		);

		expect(result.requeue).toBeUndefined();
		const row = await runRow(result.heartbeatRunId as string);
		expect(row.status).toBe('failed');
		// The tokens it did spend are still recorded, which is the point of not
		// routing this through a handback that writes no usage.
		expect(row.input_tokens).toBe(1200);
		expect(row.output_tokens).toBe(300);
	});
});

const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

/** A reset time in the format Codex prints in its usage-limit message, in UTC. */
function codexResetText(at: Date): string {
	const day = at.getUTCDate();
	const suffix = day >= 11 && day <= 13 ? 'th' : (['th', 'st', 'nd', 'rd'][day % 10] ?? 'th');
	const hour = at.getUTCHours() % 12 || 12;
	const minute = String(at.getUTCMinutes()).padStart(2, '0');
	const meridiem = at.getUTCHours() < 12 ? 'AM' : 'PM';
	return `${MONTHS[at.getUTCMonth()]} ${day}${suffix}, ${at.getUTCFullYear()} ${hour}:${minute} ${meridiem}`;
}

function usageLimitTurn(resetAt: Date) {
	return {
		type: 'turn.failed',
		error: {
			message: `You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at ${codexResetText(resetAt)}.`,
		},
		usage: {},
	};
}

const WORKED_TURN = [
	{ type: 'thread.started', model: 'gpt-5-codex' },
	{ type: 'item.completed', item: { type: 'agent_message', text: 'Done.' } },
	{ type: 'turn.completed', usage: { input_tokens: 900, output_tokens: 120 } },
];

async function configId(): Promise<string> {
	const r = await db.query<{ id: string }>(
		`SELECT id FROM ai_provider_configs WHERE label = 'openai-refusal'`,
	);
	return r.rows[0].id;
}

async function storedHold(): Promise<Date | null> {
	const r = await db.query<{ usage_limited_until: Date | null }>(
		'SELECT usage_limited_until FROM ai_provider_configs WHERE id = $1',
		[await configId()],
	);
	return r.rows[0].usage_limited_until;
}

async function setHold(offsetMin: number): Promise<Date> {
	const r = await db.query<{ usage_limited_until: Date }>(
		`UPDATE ai_provider_configs
		    SET usage_limited_until = now() + make_interval(mins => $2::int)
		  WHERE id = $1 RETURNING usage_limited_until`,
		[await configId(), offsetMin],
	);
	return r.rows[0].usage_limited_until;
}

async function claimedWakeup(
	taskId: string,
	payload: Record<string, unknown> = {},
): Promise<string> {
	const r = await db.query<{ id: string }>(
		`INSERT INTO agent_wakeup_requests (member_id, team_id, source, status, payload)
		 VALUES ($1, $2, 'heartbeat', 'claimed', $3::jsonb) RETURNING id`,
		[agentId, teamId, JSON.stringify({ task_id: taskId, ...payload })],
	);
	return r.rows[0].id;
}

async function usageLimitNotices(): Promise<string[]> {
	const r = await db.query<{ message: string }>(
		`SELECT payload->>'message' AS message FROM approvals
		  WHERE team_id = $1 AND payload->>'type' = 'agent_error'
		    AND payload->>'message' LIKE '%usage allowance%'`,
		[teamId],
	);
	return r.rows.map((row) => row.message);
}

describe('runAgent usage-limit hold', () => {
	beforeEach(async () => {
		await db.query('UPDATE ai_provider_configs SET usage_limited_until = NULL');
		await db.query(`DELETE FROM approvals WHERE team_id = $1`, [teamId]);
		await db.query(`DELETE FROM agent_wakeup_requests WHERE team_id = $1 AND status = 'queued'`, [
			teamId,
		]);
	});

	it('holds the credential until the reset the provider stated, and tells a person once', async () => {
		const resetAt = new Date(Date.now() + 2 * 24 * 60 * 60_000);
		resetAt.setUTCSeconds(0, 0);
		const expected = new Date(resetAt.getTime() + 60_000);

		const first = await runAgent(
			deps(refusalDocker([usageLimitTurn(resetAt)])),
			agent(),
			await makeTask('Refused on a stated reset'),
			project(),
		);
		expect(first.requeue).toBeDefined();
		expect(first.requeue?.reason).toBe(WakeupSkipReason.ProviderUsageLimit);
		expect(first.requeue?.notBefore?.getTime()).toBe(expected.getTime());
		expect((await storedHold())?.getTime()).toBe(expected.getTime());
		const row = await runRow(first.heartbeatRunId as string);
		expect(row.status).toBe('cancelled');
		expect(row.error).toContain('Every run on this credential waits until');
		expect(await usageLimitNotices()).toHaveLength(1);

		// A second refusal inside the same outage renews nothing and files nothing.
		const second = await runAgent(
			deps(refusalDocker([usageLimitTurn(resetAt)])),
			agent(),
			await makeTask('Refused again inside the outage'),
			project(),
		);
		expect(second.requeue?.notBefore?.getTime()).toBe(expected.getTime());
		expect(await usageLimitNotices()).toHaveLength(1);
	});

	it('holds for a fixed interval when the provider states no reset', async () => {
		const before = Date.now();
		const result = await runAgent(
			deps(refusalDocker([{ type: 'turn.failed', error: { message: 'usage limit reached' } }])),
			agent(),
			await makeTask('Refused with no reset stated'),
			project(),
		);
		const heldMin = ((result.requeue?.notBefore?.getTime() ?? 0) - before) / 60_000;
		expect(heldMin).toBeGreaterThanOrEqual(29.9);
		expect(heldMin).toBeLessThan(31);
	});

	it('holds queued work on a held credential with no run row and no container', async () => {
		const hold = await setHold(120);
		const task = await makeTask('Queued behind a spent allowance');
		const wakeupId = await claimedWakeup(task.id);
		const docker = refusalDocker(WORKED_TURN, 0);

		const result = await runAgent(
			deps(docker),
			agent(),
			task,
			project(),
			{ task_id: task.id },
			undefined,
			undefined,
			wakeupId,
		);

		expect(result.requeue).toBeDefined();
		expect(result.requeue?.reason).toBe(WakeupSkipReason.ProviderUsageLimit);
		expect(result.requeue?.notBefore?.getTime()).toBe(hold.getTime());
		expect(result.heartbeatRunId).toBeUndefined();
		expect(docker.execStart).not.toHaveBeenCalled();
		const runs = await db.query('SELECT 1 FROM heartbeat_runs WHERE wakeup_id = $1', [wakeupId]);
		expect(runs.rows).toHaveLength(0);
	});

	it('lets a run a person asked for through the hold, and lifts the hold once it gets a turn', async () => {
		await setHold(120);
		const held = await db.query<{ id: string }>(
			`INSERT INTO agent_wakeup_requests
			   (member_id, team_id, source, status, payload, last_skipped_reason, last_skipped_at,
			    not_before, held_config_id)
			 VALUES ($1, $2, 'timer', 'queued', '{}'::jsonb, $3, now(), now() + interval '2 hours', $4)
			 RETURNING id`,
			[agentId, teamId, WakeupSkipReason.ProviderUsageLimit, await configId()],
		);
		const task = await makeTask('Run now after adding credits');
		const wakeupId = await claimedWakeup(task.id, {
			triggered_by: { member_id: null, name: 'Admin' },
		});

		const result = await runAgent(
			deps(refusalDocker(WORKED_TURN, 0)),
			agent(),
			task,
			project(),
			{ task_id: task.id, triggered_by: { member_id: null, name: 'Admin' } },
			undefined,
			undefined,
			wakeupId,
		);

		expect(result.requeue).toBeUndefined();
		expect(result.heartbeatRunId).toBeDefined();
		expect(await storedHold()).toBeNull();
		const released = await db.query<{ not_before: Date | null }>(
			'SELECT not_before FROM agent_wakeup_requests WHERE id = $1',
			[held.rows[0].id],
		);
		// Released first in line: claimable now rather than at the stated reset.
		expect(released.rows[0].not_before?.getTime()).toBeLessThanOrEqual(Date.now());
	});

	it('holds the credential when the provider refuses a run that had already spent tokens', async () => {
		// The run is served once, then refused: it fails on its merits, and the
		// credential is held at once rather than after the next zero-token refusal.
		const resetAt = new Date(Date.now() + 3 * 24 * 60 * 60_000);
		resetAt.setUTCSeconds(0, 0);
		const result = await runAgent(
			deps(
				refusalDocker([
					{ type: 'thread.started', model: 'gpt-5-codex' },
					{ type: 'item.completed', item: { type: 'agent_message', text: 'Checking.' } },
					{ ...usageLimitTurn(resetAt), usage: { input_tokens: 5400, output_tokens: 20 } },
				]),
			),
			agent(),
			await makeTask('Refused after one reply'),
			project(),
		);

		expect(result.requeue).toBeUndefined();
		const row = await runRow(result.heartbeatRunId as string);
		expect(row.status).toBe('failed');
		expect(row.error).not.toContain('never got a turn');
		expect((await storedHold())?.getTime()).toBe(resetAt.getTime() + 60_000);
		expect(await usageLimitNotices()).toHaveLength(1);
	});

	it('lifts nothing when a run a person asked for is itself refused for usage', async () => {
		await setHold(120);
		const resetAt = new Date(Date.now() + 2 * 24 * 60 * 60_000);
		resetAt.setUTCSeconds(0, 0);
		const task = await makeTask('Run now into a spent allowance');
		const wakeupId = await claimedWakeup(task.id, {
			triggered_by: { member_id: null, name: 'Admin' },
		});

		await runAgent(
			deps(
				refusalDocker([
					{ type: 'thread.started', model: 'gpt-5-codex' },
					{ ...usageLimitTurn(resetAt), usage: { input_tokens: 800, output_tokens: 5 } },
				]),
			),
			agent(),
			task,
			project(),
			{ task_id: task.id, triggered_by: { member_id: null, name: 'Admin' } },
			undefined,
			undefined,
			wakeupId,
		);

		expect((await storedHold())?.getTime()).toBe(resetAt.getTime() + 60_000);
	});

	it('lets one run test a lapsed hold and holds the others behind it', async () => {
		const id = await configId();
		const lapsed = await setHold(-1);

		expect(await usageHoldWait(db, id, lapsed)).toBeNull();
		const behind = await usageHoldWait(db, id, lapsed);
		const waitMin = ((behind?.getTime() ?? 0) - Date.now()) / 60_000;
		expect(waitMin).toBeGreaterThan(USAGE_HOLD_PROBE_MIN - 1);
		expect(waitMin).toBeLessThanOrEqual(USAGE_HOLD_PROBE_MIN);

		// No hold read with the row costs nothing and holds nothing.
		expect(await usageHoldWait(db, id, null)).toBeNull();
	});
});

/** Where the test credential's week stands: `elapsedDays` into a week, `used` percent spent. */
async function setAllowance(used: number, elapsedDays: number, share: number | null = null) {
	await db.query(
		`UPDATE ai_provider_configs
		    SET allowance_used_percent = $2, allowance_window_minutes = 10080,
		        allowance_resets_at = now() + make_interval(secs => $3::float8),
		        allowance_seen_at = now(), allowance_daily_share_percent = $4
		  WHERE id = $1`,
		[await configId(), used, (7 - elapsedDays) * 86_400, share],
	);
}

async function paceNotices(): Promise<string[]> {
	const r = await db.query<{ message: string }>(
		`SELECT payload->>'message' AS message FROM approvals
		  WHERE team_id = $1 AND payload->>'type' = 'agent_error'
		    AND payload->>'message' LIKE '%is pacing the credential%'`,
		[teamId],
	);
	return r.rows.map((row) => row.message);
}

describe('runAgent allowance pace', () => {
	beforeEach(async () => {
		await db.query('UPDATE ai_provider_configs SET usage_limited_until = NULL');
		await db.query(`DELETE FROM approvals WHERE team_id = $1`, [teamId]);
		await db.query(`DELETE FROM system_meta WHERE key LIKE 'allowance_pace_notice:%'`);
	});

	afterAll(async () => {
		await db.query(
			`UPDATE ai_provider_configs
			    SET allowance_used_percent = NULL, allowance_window_minutes = NULL,
			        allowance_resets_at = NULL, allowance_seen_at = NULL,
			        allowance_daily_share_percent = NULL`,
		);
	});

	it('holds agent work ahead of the pace with no run row and no container, and tells a person once', async () => {
		// Half a day into the week the even line allows 1.5 days' share, about 21%.
		await setAllowance(30, 0.5);
		const task = await makeTask('Ahead of the pace');
		const wakeupId = await claimedWakeup(task.id);
		const docker = refusalDocker(WORKED_TURN, 0);

		const before = Date.now();
		const result = await runAgent(
			deps(docker),
			agent(),
			task,
			project(),
			{ task_id: task.id },
			undefined,
			undefined,
			wakeupId,
		);

		expect(result.requeue?.reason).toBe(WakeupSkipReason.ProviderAllowancePace);
		expect(result.requeue?.heldConfigId).toBe(await configId());
		// The line reaches 30% well past the half-hour recheck, so the recheck wins.
		const waitMin = ((result.requeue?.notBefore?.getTime() ?? 0) - before) / 60_000;
		expect(waitMin).toBeGreaterThan(29);
		expect(waitMin).toBeLessThanOrEqual(ALLOWANCE_PACE_RECHECK_MIN + 0.1);
		expect(result.heartbeatRunId).toBeUndefined();
		expect(docker.execStart).not.toHaveBeenCalled();
		expect(await paceNotices()).toHaveLength(1);

		// The next held run in the same window files nothing more.
		const again = await makeTask('Also ahead of the pace');
		await runAgent(
			deps(refusalDocker(WORKED_TURN, 0)),
			agent(),
			again,
			project(),
			{ task_id: again.id },
			undefined,
			undefined,
			await claimedWakeup(again.id),
		);
		expect(await paceNotices()).toHaveLength(1);
	});

	it('lets work on or under the line run', async () => {
		await setAllowance(15, 0.5);
		const task = await makeTask('On pace');
		const result = await runAgent(
			deps(refusalDocker(WORKED_TURN, 0)),
			agent(),
			task,
			project(),
			{ task_id: task.id },
			undefined,
			undefined,
			await claimedWakeup(task.id),
		);
		expect(result.requeue).toBeUndefined();
		expect(result.heartbeatRunId).toBeDefined();
	});

	it("reads the admin's daily share: a raised share lets the same work through", async () => {
		await setAllowance(30, 0.5, 100);
		const task = await makeTask('Paced by a raised share');
		const result = await runAgent(
			deps(refusalDocker(WORKED_TURN, 0)),
			agent(),
			task,
			project(),
			{ task_id: task.id },
			undefined,
			undefined,
			await claimedWakeup(task.id),
		);
		expect(result.requeue).toBeUndefined();
	});

	it('lets a run a person asked for through the pace', async () => {
		await setAllowance(60, 0.5);
		const task = await makeTask('Run now past the pace');
		const payload = { task_id: task.id, triggered_by: { member_id: null, name: 'Admin' } };
		const result = await runAgent(
			deps(refusalDocker(WORKED_TURN, 0)),
			agent(),
			task,
			project(),
			payload,
			undefined,
			undefined,
			await claimedWakeup(task.id, payload),
		);
		expect(result.requeue).toBeUndefined();
		expect(result.heartbeatRunId).toBeDefined();
	});

	it('stores a reported window only when it moved', async () => {
		const id = await configId();
		const resetsAt = new Date(Date.now() + 3 * 86_400_000);
		resetsAt.setUTCMilliseconds(0);
		const seenAt = async () =>
			(
				await db.query<{ allowance_seen_at: Date; allowance_used_percent: number }>(
					'SELECT allowance_seen_at, allowance_used_percent FROM ai_provider_configs WHERE id = $1',
					[id],
				)
			).rows[0];

		await recordCredentialAllowance(db, id, { usedPercent: 42, windowMinutes: 10_080, resetsAt });
		const first = await seenAt();
		expect(first.allowance_used_percent).toBeCloseTo(42);

		await recordCredentialAllowance(db, id, { usedPercent: 42, windowMinutes: 10_080, resetsAt });
		expect((await seenAt()).allowance_seen_at).toEqual(first.allowance_seen_at);

		await recordCredentialAllowance(db, id, { usedPercent: 43, windowMinutes: 10_080, resetsAt });
		expect((await seenAt()).allowance_used_percent).toBeCloseTo(43);
	});
});

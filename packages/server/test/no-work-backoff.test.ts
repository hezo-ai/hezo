import {
	CommentContentType,
	HeartbeatRunKind,
	HeartbeatRunStatus,
	TaskStatus,
	WakeupSource,
} from '@hezo/shared';
import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../src/db/database';
import type { Env } from '../src/lib/types';
import {
	attemptsExhaustedOnTask,
	dispatchSuppressionExempt,
	HANDOFF_ROUND_LIMIT,
	handoffRoundsExhausted,
	loadTaskUsageSoFar,
	MAX_TASK_ATTEMPT_GIVEUPS,
	noWorkCooldownActive,
	parkedOnAdminAsk,
	retrospectiveHoldActive,
	TASK_ATTEMPT_WINDOW_HOURS,
	TASK_TOKEN_CEILING,
	taskTokenCeilingNotice,
	taskTokenCeilingReached,
} from '../src/services/no-work-backoff';
import { safeClose } from './helpers';
import {
	authHeader,
	createTestApp,
	createTestProject,
	createTestTeam,
	projectSlugFor,
} from './helpers/app';

let app: Hono<Env>;
let db: Db;
let token: string;
let teamId: string;
let projectId: string;
let projectSlug: string;
let taskId: string;
let agentId: string;
let otherAgentId: string;

beforeAll(async () => {
	const ctx = await createTestApp();
	app = ctx.app;
	db = ctx.db;
	token = ctx.token;

	const typesRes = await app.request('/api/team-templates', { headers: authHeader(token) });
	const typeId = (await typesRes.json()).data.find(
		(t: { name: string }) => t.name === 'App Team',
	).id;
	const teamRes = await createTestTeam(db, { name: 'Backoff Co', template_id: typeId });
	teamId = (await teamRes.json()).data.id;

	const projectRes = await createTestProject(db, teamId, {
		name: 'Backoff Project',
		description: 'Test project.',
	});
	const project = (await projectRes.json()).data;
	projectId = project.id;
	projectSlug = project.slug;

	const agentsRes = await app.request(`/api/projects/${await projectSlugFor(db, teamId)}/agents`, {
		headers: authHeader(token),
	});
	const agents = (await agentsRes.json()).data as Array<{ id: string }>;
	agentId = agents[0].id;
	otherAgentId = agents[1].id;
	// The cadence the incident ran at: a daily agent that was still being
	// dispatched every few minutes.
	await db.query('UPDATE member_agents SET heartbeat_interval_min = 1440 WHERE id = $1', [agentId]);

	const taskRes = await app.request(`/api/projects/${projectSlug}/tasks`, {
		method: 'POST',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({ project_id: projectId, title: 'Daily check', assignee_id: agentId }),
	});
	taskId = (await taskRes.json()).data.id;
});

afterAll(async () => {
	await safeClose(db);
});

async function clearRuns(): Promise<void> {
	await db.query('DELETE FROM agent_wakeup_requests WHERE team_id = $1', [teamId]);
	await db.query('DELETE FROM heartbeat_runs WHERE team_id = $1', [teamId]);
	await db.query('DELETE FROM task_comments WHERE task_id = $1', [taskId]);
}

/** A finished run on the shared task, `minutesAgo` in the past. */
async function insertRun(opts: {
	reportedNoWork: boolean;
	minutesAgo: number;
	status?: HeartbeatRunStatus;
}): Promise<string> {
	const r = await db.query<{ id: string }>(
		`INSERT INTO heartbeat_runs
		   (team_id, member_id, task_id, status, started_at, finished_at, reported_no_work)
		 VALUES ($1, $2, $3, $4::heartbeat_run_status,
		         now() - ($5 || ' minutes')::interval - interval '1 minute',
		         now() - ($5 || ' minutes')::interval,
		         $6)
		 RETURNING id`,
		[
			teamId,
			agentId,
			taskId,
			opts.status ?? HeartbeatRunStatus.Succeeded,
			String(opts.minutesAgo),
			opts.reportedNoWork,
		],
	);
	return r.rows[0].id;
}

/**
 * Whether a wakeup from `source` on the shared task skips every suppression. The
 * wakeup is raised by an agent run unless `byAgent` is false.
 */
async function exemptFor(
	source: WakeupSource,
	payload: Record<string, unknown> = {},
	byAgent = true,
): Promise<boolean> {
	const cause = await db.query<{ id: string }>(
		`INSERT INTO heartbeat_runs (team_id, member_id, status, started_at, finished_at)
		 VALUES ($1, $2, 'succeeded'::heartbeat_run_status, now() - interval '1 day', now() - interval '1 day')
		 RETURNING id`,
		[teamId, agentId],
	);
	const w = await db.query<{ id: string }>(
		`INSERT INTO agent_wakeup_requests (member_id, team_id, source, payload, created_by_run_id)
		 VALUES ($1, $2, $3::wakeup_source, $4::jsonb, $5)
		 RETURNING id`,
		[
			agentId,
			teamId,
			source,
			JSON.stringify({ task_id: taskId, ...payload }),
			byAgent ? cause.rows[0].id : null,
		],
	);
	return dispatchSuppressionExempt(db, agentId, taskId, source, payload, w.rows[0].id);
}

async function insertHumanReply(minutesAgo: number): Promise<void> {
	const user = await db.query<{ id: string }>('SELECT id FROM users LIMIT 1');
	await db.query(
		`INSERT INTO task_comments (task_id, author_user_id, content_type, content, created_at)
		 VALUES ($1, $2, 'text'::comment_content_type, $3::jsonb,
		         now() - ($4 || ' minutes')::interval)`,
		[
			taskId,
			user.rows[0].id,
			JSON.stringify({ text: 'Looked at it, carry on.' }),
			String(minutesAgo),
		],
	);
}

async function insertComment(minutesAgo: number, runId: string | null): Promise<void> {
	await db.query(
		`INSERT INTO task_comments (task_id, author_member_id, content_type, content, created_at, created_by_run_id)
		 VALUES ($1, NULL, $2::comment_content_type, $3::jsonb, now() - ($4 || ' minutes')::interval, $5)`,
		[
			taskId,
			CommentContentType.Text,
			JSON.stringify({ text: 'anything' }),
			String(minutesAgo),
			runId,
		],
	);
}

describe('noWorkCooldownActive', () => {
	it('suppresses a re-dispatch after report_no_work within the heartbeat interval', async () => {
		await clearRuns();
		await insertRun({ reportedNoWork: true, minutesAgo: 5 });

		// The incident exactly: a 1440-minute agent, five minutes after it said it
		// had nothing to do, woken by the container_start automation.
		expect(await noWorkCooldownActive(db, agentId, taskId, false)).toBe(true);
	});

	it('lets the dispatch through once the heartbeat interval has elapsed', async () => {
		await clearRuns();
		await insertRun({ reportedNoWork: true, minutesAgo: 1441 });

		// The window is the operator's own cadence, so it expires exactly when a
		// scheduled heartbeat would have come round anyway.
		expect(await noWorkCooldownActive(db, agentId, taskId, false)).toBe(false);
	});

	it('lifts the moment new input lands on the task', async () => {
		await clearRuns();
		await insertRun({ reportedNoWork: true, minutesAgo: 10 });
		await insertComment(2, null);

		expect(await noWorkCooldownActive(db, agentId, taskId, false)).toBe(false);
	});

	it('ignores comments the no-work run itself authored', async () => {
		await clearRuns();
		const runId = await insertRun({ reportedNoWork: true, minutesAgo: 10 });
		// Backdated behind finished_at is the honest case, but a run's own comment
		// landing after it is what the created_by_run_id exclusion is for: the run
		// reporting is not new input.
		await insertComment(2, runId);

		expect(await noWorkCooldownActive(db, agentId, taskId, false)).toBe(true);
	});

	it('does not suppress when the last run actually did work', async () => {
		await clearRuns();
		await insertRun({ reportedNoWork: false, minutesAgo: 5 });

		expect(await noWorkCooldownActive(db, agentId, taskId, false)).toBe(false);
	});

	it('reads the most recent run, not any no-work run in history', async () => {
		await clearRuns();
		await insertRun({ reportedNoWork: true, minutesAgo: 30 });
		await insertRun({ reportedNoWork: false, minutesAgo: 3 });

		// A later run that did work says the task is live again.
		expect(await noWorkCooldownActive(db, agentId, taskId, false)).toBe(false);
	});

	it('never suppresses an exempt wakeup', async () => {
		await clearRuns();
		await insertRun({ reportedNoWork: true, minutesAgo: 1 });

		expect(await noWorkCooldownActive(db, agentId, taskId, true)).toBe(false);
	});

	it('suppresses every system-raised source, not just the automation that caused this', async () => {
		await clearRuns();
		await insertRun({ reportedNoWork: true, minutesAgo: 5 });

		for (const source of [
			WakeupSource.Heartbeat,
			WakeupSource.Assignment,
			WakeupSource.Timer,
			WakeupSource.Automation,
		]) {
			expect(await noWorkCooldownActive(db, agentId, taskId, await exemptFor(source))).toBe(true);
		}
	});

	it('is inert for a task-less wakeup and when the agent has never run the task', async () => {
		await clearRuns();
		expect(await noWorkCooldownActive(db, agentId, null, false)).toBe(false);
		expect(await noWorkCooldownActive(db, agentId, taskId, false)).toBe(false);
	});

	it('ignores an unfinished run so an in-flight one cannot park the task', async () => {
		await clearRuns();
		await insertRun({ reportedNoWork: true, minutesAgo: 5 });
		await db.query(
			`INSERT INTO heartbeat_runs (team_id, member_id, task_id, status, started_at, reported_no_work)
			 VALUES ($1, $2, $3, $4::heartbeat_run_status, now(), false)`,
			[teamId, agentId, taskId, HeartbeatRunStatus.Running],
		);

		// The running row has a null finished_at, so the no-work verdict still stands.
		expect(await noWorkCooldownActive(db, agentId, taskId, false)).toBe(true);
	});

	it('lifts when a choice card is answered, which writes no comment row at all', async () => {
		await clearRuns();
		// The card was posted before the run, so the created_at probe sees nothing
		// new; the admin then answers it. Answering sets `chosen_option` on the row
		// already there rather than inserting one, which is how the single most
		// conclusive "the wait is over" event stayed invisible to this check.
		const cardId = await insertAgentComment({
			minutesAgo: 30,
			contentType: CommentContentType.Action,
		});
		await insertRun({ reportedNoWork: true, minutesAgo: 10 });
		expect(await noWorkCooldownActive(db, agentId, taskId, false)).toBe(true);

		await db.query(
			`UPDATE task_comments SET chosen_option = '{"status":"approved"}'::jsonb WHERE id = $1`,
			[cardId],
		);
		expect(await noWorkCooldownActive(db, agentId, taskId, false)).toBe(false);
	});

	it('lifts on a status change, which reaches it as a system comment', async () => {
		await clearRuns();
		await insertRun({ reportedNoWork: true, minutesAgo: 10 });
		// What `recordStatusChange` writes. Every task mutation that could give the
		// agent something to do goes through task-events.ts and lands here, which is
		// why one comment check covers status, assignee, title and unblock alike.
		await db.query(
			`INSERT INTO task_comments (task_id, author_member_id, content_type, content)
			 VALUES ($1, NULL, $2::comment_content_type, $3::jsonb)`,
			[
				taskId,
				CommentContentType.System,
				JSON.stringify({
					kind: 'status_change',
					from: TaskStatus.Backlog,
					to: TaskStatus.InProgress,
				}),
			],
		);

		expect(await noWorkCooldownActive(db, agentId, taskId, false)).toBe(false);
	});
});

/**
 * An agent-authored comment on the shared task, optionally raising the admin-inbox
 * row that makes it an outstanding ask. Returns the comment id.
 */
async function insertAgentComment(opts: {
	minutesAgo: number;
	raisesAdminMention?: boolean;
	contentType?: CommentContentType;
	chosenOption?: string | null;
}): Promise<string> {
	const c = await db.query<{ id: string }>(
		`INSERT INTO task_comments (task_id, author_member_id, content_type, content, created_at, chosen_option)
		 VALUES ($1, $2, $3::comment_content_type, $4::jsonb, now() - ($5 || ' minutes')::interval, $6::jsonb)
		 RETURNING id`,
		[
			taskId,
			agentId,
			opts.contentType ?? CommentContentType.Text,
			JSON.stringify({ text: 'over to you @admin' }),
			String(opts.minutesAgo),
			opts.chosenOption === undefined || opts.chosenOption === null
				? null
				: JSON.stringify(opts.chosenOption),
		],
	);
	const commentId = c.rows[0].id;
	if (opts.raisesAdminMention) {
		const user = await db.query<{ id: string }>('SELECT id FROM users LIMIT 1');
		await db.query(
			`INSERT INTO admin_mentions (team_id, task_id, comment_id, user_id)
			 VALUES ($1, $2, $3, $4)`,
			[teamId, taskId, commentId, user.rows[0].id],
		);
	}
	return commentId;
}

describe('parkedOnAdminAsk', () => {
	it('parks the task while an @admin ask stands unanswered', async () => {
		await clearRuns();
		await insertAgentComment({ minutesAgo: 10, raisesAdminMention: true });

		// The exact leak: an intake whose last word is a question to a human, woken
		// again every heartbeat to re-read a thread nobody has added to.
		expect(await parkedOnAdminAsk(db, agentId, taskId, false)).toBe(true);
	});

	it('lifts the moment anyone else speaks', async () => {
		await clearRuns();
		await insertAgentComment({ minutesAgo: 10, raisesAdminMention: true });
		await insertComment(2, null);

		expect(await parkedOnAdminAsk(db, agentId, taskId, false)).toBe(false);
	});

	it('stays parked when the agent is the only one who spoke since', async () => {
		await clearRuns();
		await insertAgentComment({ minutesAgo: 10, raisesAdminMention: true });
		await insertAgentComment({ minutesAgo: 2 });

		// Chasing its own question is not an answer to it.
		expect(await parkedOnAdminAsk(db, agentId, taskId, false)).toBe(true);
	});

	it('parks on an unanswered choice card, and lifts once it is answered', async () => {
		await clearRuns();
		const askId = await insertAgentComment({
			minutesAgo: 10,
			contentType: CommentContentType.CredentialRequest,
		});
		expect(await parkedOnAdminAsk(db, agentId, taskId, false)).toBe(true);

		await db.query(`UPDATE task_comments SET chosen_option = '"provided"'::jsonb WHERE id = $1`, [
			askId,
		]);
		expect(await parkedOnAdminAsk(db, agentId, taskId, false)).toBe(false);
	});

	it('does not park a thread carrying no ask at all', async () => {
		await clearRuns();
		await insertAgentComment({ minutesAgo: 10 });

		expect(await parkedOnAdminAsk(db, agentId, taskId, false)).toBe(false);
	});

	it('never suppresses an exempt wakeup, so the answer always gets through', async () => {
		await clearRuns();
		await insertAgentComment({ minutesAgo: 1, raisesAdminMention: true });

		expect(await parkedOnAdminAsk(db, agentId, taskId, true)).toBe(false);
	});

	it('lifts when the admin answers a card, even though answering writes no comment', async () => {
		await clearRuns();
		const cardId = await insertAgentComment({
			minutesAgo: 20,
			contentType: CommentContentType.Action,
		});
		await insertAgentComment({ minutesAgo: 10, raisesAdminMention: true });
		expect(await parkedOnAdminAsk(db, agentId, taskId, false)).toBe(true);

		// The admin acting on the thread is the admin speaking on it, whoever
		// authored the card. `chosen_at` is the only trace it leaves.
		await db.query(
			`UPDATE task_comments SET chosen_option = '{"status":"approved"}'::jsonb WHERE id = $1`,
			[cardId],
		);
		expect(await parkedOnAdminAsk(db, agentId, taskId, false)).toBe(false);
	});

	it('returns false for a task-less wakeup', async () => {
		expect(await parkedOnAdminAsk(db, agentId, null, false)).toBe(false);
	});
});

describe('an approval resolution reaches the agent that filed it', () => {
	it('is exempt from both suppressions, which discarded it on the automation source', async () => {
		await clearRuns();
		// The reported incident. The agent filed its proposals, asked the admin the
		// last thing it needed, and reported no work because the task was now in
		// somebody else's court - which is what SHARED_INSTRUCTIONS tells it to do.
		// Approving in the inbox writes no comment, so both suppressions still read
		// the thread as unchanged and the wake was dropped, not re-queued: nothing
		// retried it, and the next chance was a scheduled heartbeat 12 hours out.
		await insertAgentComment({ minutesAgo: 6, raisesAdminMention: true });
		await insertRun({ reportedNoWork: true, minutesAgo: 5 });

		const automation = await exemptFor(WakeupSource.Automation);
		expect(await noWorkCooldownActive(db, agentId, taskId, automation)).toBe(true);
		expect(await parkedOnAdminAsk(db, agentId, taskId, automation)).toBe(true);

		const resolved = await exemptFor(WakeupSource.ApprovalResolved);
		expect(await noWorkCooldownActive(db, agentId, taskId, resolved)).toBe(false);
		expect(await parkedOnAdminAsk(db, agentId, taskId, resolved)).toBe(false);
	});
});

describe('attemptsExhaustedOnTask', () => {
	/** A finished run on the shared task with an explicit ending. */
	async function insertEnding(
		status: HeartbeatRunStatus,
		minutesAgo: number,
		cancelReason: string | null = null,
	): Promise<void> {
		await db.query(
			`INSERT INTO heartbeat_runs
			   (team_id, member_id, task_id, status, cancel_reason, started_at, finished_at)
			 VALUES ($1, $2, $3, $4::heartbeat_run_status, $5,
			         now() - ($6 || ' minutes')::interval - interval '1 minute',
			         now() - ($6 || ' minutes')::interval)`,
			[teamId, agentId, taskId, status, cancelReason, String(minutesAgo)],
		);
	}

	it('parks the task once the allowance is spent', async () => {
		await clearRuns();
		for (let i = 0; i < MAX_TASK_ATTEMPT_GIVEUPS; i++) {
			await insertEnding(HeartbeatRunStatus.TimedOut, (i + 1) * 10);
		}
		expect(await attemptsExhaustedOnTask(db, agentId, taskId, false)).toBe(true);
	});

	it('counts a mixed streak, which is the shape that defeated a consecutive count', async () => {
		await clearRuns();
		// One task ran 31 times in 17 hours because a `cancelled` give-up between
		// timeouts reset the streak and handed it a fresh allowance every time.
		await insertEnding(HeartbeatRunStatus.TimedOut, 60);
		await insertEnding(HeartbeatRunStatus.TimedOut, 50);
		await insertEnding(HeartbeatRunStatus.Cancelled, 40, 'handed_back');
		await insertEnding(HeartbeatRunStatus.TimedOut, 30);
		await insertEnding(HeartbeatRunStatus.Failed, 20);
		await insertEnding(HeartbeatRunStatus.TimedOut, 10);
		expect(await attemptsExhaustedOnTask(db, agentId, taskId, false)).toBe(true);
	});

	it('stays under the bound one attempt short of it', async () => {
		await clearRuns();
		for (let i = 0; i < MAX_TASK_ATTEMPT_GIVEUPS - 1; i++) {
			await insertEnding(HeartbeatRunStatus.TimedOut, (i + 1) * 10);
		}
		expect(await attemptsExhaustedOnTask(db, agentId, taskId, false)).toBe(false);
	});

	it('resets on a run that finished the work, and only on that', async () => {
		await clearRuns();
		for (let i = 0; i < MAX_TASK_ATTEMPT_GIVEUPS; i++) {
			await insertEnding(HeartbeatRunStatus.TimedOut, 100 + i * 10);
		}
		await insertEnding(HeartbeatRunStatus.Succeeded, 50);
		expect(await attemptsExhaustedOnTask(db, agentId, taskId, false)).toBe(false);
	});

	it('does not count a run a person terminated', async () => {
		await clearRuns();
		for (let i = 0; i < MAX_TASK_ATTEMPT_GIVEUPS; i++) {
			await insertEnding(HeartbeatRunStatus.Cancelled, (i + 1) * 10, 'operator_terminated');
		}
		// Pressing Terminate repeatedly must not park the operator's own task.
		expect(await attemptsExhaustedOnTask(db, agentId, taskId, false)).toBe(false);
	});

	it('ignores attempts older than the window', async () => {
		await clearRuns();
		const outsideWindow = TASK_ATTEMPT_WINDOW_HOURS * 60 + 60;
		for (let i = 0; i < MAX_TASK_ATTEMPT_GIVEUPS; i++) {
			await insertEnding(HeartbeatRunStatus.TimedOut, outsideWindow + i * 10);
		}
		expect(await attemptsExhaustedOnTask(db, agentId, taskId, false)).toBe(false);
	});

	it("lets a person's reply and Run now through, and holds a teammate's mention", async () => {
		await clearRuns();
		for (let i = 0; i < MAX_TASK_ATTEMPT_GIVEUPS; i++) {
			await insertEnding(HeartbeatRunStatus.TimedOut, (i + 1) * 10);
		}
		const mention = await exemptFor(WakeupSource.Mention);
		expect(await attemptsExhaustedOnTask(db, agentId, taskId, mention)).toBe(true);
		const runNow = await exemptFor(WakeupSource.OnDemand, { triggered_by: { name: 'Admin' } });
		expect(await attemptsExhaustedOnTask(db, agentId, taskId, runNow)).toBe(false);

		await insertHumanReply(1);
		const reply = await exemptFor(WakeupSource.Reply);
		expect(await attemptsExhaustedOnTask(db, agentId, taskId, reply)).toBe(false);
	});

	it('is inert for a task-less wakeup', async () => {
		expect(await attemptsExhaustedOnTask(db, agentId, null, false)).toBe(false);
	});
});

describe('retrospectiveHoldActive', () => {
	/** A comment written by a retrospective run, which is what a finding is. */
	async function insertFinding(minutesAgo: number): Promise<string> {
		const run = await db.query<{ id: string }>(
			`INSERT INTO heartbeat_runs (team_id, member_id, status, kind)
			 VALUES ($1, $2, 'succeeded'::heartbeat_run_status, $3::heartbeat_run_kind)
			 RETURNING id`,
			[teamId, agentId, HeartbeatRunKind.Retrospective],
		);
		const c = await db.query<{ id: string }>(
			`INSERT INTO task_comments (task_id, author_member_id, content_type, content,
			                            created_by_run_id, created_at)
			 VALUES ($1, $2, 'text'::comment_content_type, $3::jsonb, $4,
			         now() - ($5 || ' minutes')::interval)
			 RETURNING id`,
			[
				taskId,
				agentId,
				JSON.stringify({ text: 'This task is not converging. @admin' }),
				run.rows[0].id,
				String(minutesAgo),
			],
		);
		return c.rows[0].id;
	}

	it('holds the task while a retrospective finding waits on a person', async () => {
		await clearRuns();
		await insertFinding(30);
		// Reporting a loop without stopping it is what this exists to prevent: an
		// @admin comment alone raises the Inbox row and suppresses no dispatches.
		expect(await retrospectiveHoldActive(db, agentId, taskId, false)).toBe(true);
	});

	it('lifts the moment a person replies', async () => {
		await clearRuns();
		await insertFinding(30);
		await insertHumanReply(5);
		expect(await retrospectiveHoldActive(db, agentId, taskId, false)).toBe(false);
	});

	it('lifts when the person answers a choice card instead of writing a comment', async () => {
		await clearRuns();
		await insertFinding(30);
		// The card is the agent's own row; choosing stamps `chosen_at` on it and writes
		// nothing of the person's own. Read for authorship alone, this answer is
		// invisible and the task stays parked after the admin has already decided.
		await db.query(
			`INSERT INTO task_comments (task_id, author_member_id, content_type, content,
			                            chosen_at, created_at)
			 VALUES ($1, $2, 'text'::comment_content_type, $3::jsonb,
			         now() - interval '5 minutes', now() - interval '20 minutes')`,
			[taskId, agentId, JSON.stringify({ text: 'Which of these should I drop?' })],
		);
		expect(await retrospectiveHoldActive(db, agentId, taskId, false)).toBe(false);
	});

	it('is not lifted by a card the person has not answered', async () => {
		await clearRuns();
		await insertFinding(30);
		await db.query(
			`INSERT INTO task_comments (task_id, author_member_id, content_type, content, created_at)
			 VALUES ($1, $2, 'text'::comment_content_type, $3::jsonb, now() - interval '5 minutes')`,
			[taskId, agentId, JSON.stringify({ text: 'Which of these should I drop?' })],
		);
		expect(await retrospectiveHoldActive(db, agentId, taskId, false)).toBe(true);
	});

	it('is not lifted by an agent talking to itself', async () => {
		await clearRuns();
		await insertFinding(30);
		await db.query(
			`INSERT INTO task_comments (task_id, author_member_id, content_type, content)
			 VALUES ($1, $2, 'text'::comment_content_type, $3::jsonb)`,
			[taskId, agentId, JSON.stringify({ text: 'Acknowledged, continuing.' })],
		);
		// The question was addressed to a human; an agent answering it is the loop
		// arguing with the brake.
		expect(await retrospectiveHoldActive(db, agentId, taskId, false)).toBe(true);
	});

	it("holds a teammate's mention, which bypassed it before", async () => {
		await clearRuns();
		await insertRun({ reportedNoWork: false, minutesAgo: 40 });
		await insertFinding(30);
		// The loop the finding named ran on agent mentions, which skipped every hold.
		const mention = await exemptFor(WakeupSource.Mention);
		expect(mention).toBe(false);
		expect(await retrospectiveHoldActive(db, agentId, taskId, mention)).toBe(true);
	});

	it('never suppresses an exempt wakeup', async () => {
		await clearRuns();
		await insertFinding(30);
		expect(await retrospectiveHoldActive(db, agentId, taskId, true)).toBe(false);
	});

	it('holds nothing when no retrospective has spoken', async () => {
		await clearRuns();
		expect(await retrospectiveHoldActive(db, agentId, taskId, false)).toBe(false);
		expect(await retrospectiveHoldActive(db, agentId, null, false)).toBe(false);
	});
});

describe('dispatchSuppressionExempt', () => {
	it('never exempts a source the system raises', async () => {
		await clearRuns();
		await insertHumanReply(1);
		for (const source of [
			WakeupSource.Heartbeat,
			WakeupSource.Assignment,
			WakeupSource.Timer,
			WakeupSource.Automation,
		]) {
			expect(await exemptFor(source), source).toBe(false);
		}
	});

	it('always exempts a decision a person made, and an operator override on any source', async () => {
		await clearRuns();
		for (const source of [
			WakeupSource.OnDemand,
			WakeupSource.CredentialProvided,
			WakeupSource.AssetDeletionResolved,
			WakeupSource.ApprovalResolved,
		]) {
			expect(await exemptFor(source), source).toBe(true);
		}
		// "Run now" on a queued mention or heartbeat stamps the actor and keeps the source.
		const override = { triggered_by: { member_id: null, name: 'Admin' } };
		expect(await exemptFor(WakeupSource.Heartbeat, override)).toBe(true);
		expect(await exemptFor(WakeupSource.Mention, override)).toBe(true);
	});

	it('exempts a conversational wake only when a person spoke after the agent last ran', async () => {
		await clearRuns();
		await insertRun({ reportedNoWork: false, minutesAgo: 30 });
		for (const source of [WakeupSource.Mention, WakeupSource.Comment, WakeupSource.Reply]) {
			expect(await exemptFor(source), source).toBe(false);
		}

		// A teammate writing is not a person writing.
		await insertAgentComment({ minutesAgo: 10 });
		expect(await exemptFor(WakeupSource.Mention)).toBe(false);

		await insertHumanReply(5);
		expect(await exemptFor(WakeupSource.Mention)).toBe(true);

		// Once the agent has run after the reply, the reply has been served.
		await insertRun({ reportedNoWork: false, minutesAgo: 1 });
		expect(await exemptFor(WakeupSource.Mention)).toBe(false);
	});

	it('counts a person answering a card as speaking', async () => {
		await clearRuns();
		await insertRun({ reportedNoWork: false, minutesAgo: 30 });
		await insertAgentComment({
			minutesAgo: 20,
			contentType: CommentContentType.Action,
			chosenOption: 'approved',
		});
		// The card's `chosen_at` is stamped at insert, after the run started.
		expect(await exemptFor(WakeupSource.Reply)).toBe(true);
	});

	it('exempts a conversational wake no agent run raised', async () => {
		await clearRuns();
		await insertRun({ reportedNoWork: false, minutesAgo: 30 });
		// A person's mention, or an external caller's: nothing was merged into it
		// that an agent run raised, so it is somebody new asking.
		expect(await exemptFor(WakeupSource.Mention, {}, false)).toBe(true);
	});

	it("exempts an agent's first run on a task a person has spoken on", async () => {
		await clearRuns();
		expect(await exemptFor(WakeupSource.Mention)).toBe(false);
		await insertHumanReply(60);
		expect(await exemptFor(WakeupSource.Mention)).toBe(true);
	});
});

describe('handoffRoundsExhausted', () => {
	/**
	 * One round: a wakeup `source` raised (by an agent run unless `byRun` is
	 * false) and the run it started on the shared task, `minutesAgo` back.
	 */
	async function insertRound(opts: {
		memberId: string;
		minutesAgo: number;
		source?: WakeupSource;
		byRun?: boolean;
		payload?: Record<string, unknown>;
		tokens?: number;
		cancelReason?: string | null;
	}): Promise<string> {
		const cause = await db.query<{ id: string }>(
			`INSERT INTO heartbeat_runs (team_id, member_id, task_id, status, started_at, finished_at)
			 VALUES ($1, $2, $3, 'succeeded'::heartbeat_run_status,
			         now() - interval '1 day', now() - interval '1 day')
			 RETURNING id`,
			[teamId, opts.memberId === agentId ? otherAgentId : agentId, null],
		);
		const wakeup = await db.query<{ id: string }>(
			`INSERT INTO agent_wakeup_requests
			   (member_id, team_id, source, payload, status, created_by_run_id)
			 VALUES ($1, $2, $3::wakeup_source, $4::jsonb, 'completed'::wakeup_status, $5)
			 RETURNING id`,
			[
				opts.memberId,
				teamId,
				opts.source ?? WakeupSource.Mention,
				JSON.stringify({ task_id: taskId, ...opts.payload }),
				opts.byRun === false ? null : cause.rows[0].id,
			],
		);
		await db.query(
			`INSERT INTO heartbeat_runs
			   (team_id, member_id, task_id, wakeup_id, status, cancel_reason,
			    started_at, finished_at, input_tokens, output_tokens)
			 VALUES ($1, $2, $3, $4, 'succeeded'::heartbeat_run_status, $5,
			         now() - ($6 || ' minutes')::interval,
			         now() - ($6 || ' minutes')::interval + interval '30 seconds',
			         $7, $8)`,
			[
				teamId,
				opts.memberId,
				taskId,
				wakeup.rows[0].id,
				opts.cancelReason ?? null,
				String(opts.minutesAgo),
				opts.tokens ?? 1_000_000,
				1_000,
			],
		);
		return wakeup.rows[0].id;
	}

	/** Two agents alternating, `count` rounds, the newest one minute ago. */
	async function alternate(count: number, startMinutesAgo = count * 5): Promise<void> {
		for (let i = 0; i < count; i++) {
			await insertRound({
				memberId: i % 2 === 0 ? agentId : otherAgentId,
				minutesAgo: startMinutesAgo - i * 5,
			});
		}
	}

	it('holds a task two agents have handed back and forth up to the limit', async () => {
		await clearRuns();
		await alternate(HANDOFF_ROUND_LIMIT - 1);
		expect(await handoffRoundsExhausted(db, taskId, false)).toBeNull();

		await insertRound({ memberId: otherAgentId, minutesAgo: 1 });
		const held = await handoffRoundsExhausted(db, taskId, false);
		expect(held?.rounds).toBe(HANDOFF_ROUND_LIMIT);
		expect(held?.tokens).toBe(HANDOFF_ROUND_LIMIT * 1_001_000);
		expect(held?.agentSlugs).toHaveLength(2);
		expect(held?.notified).toBe(false);
	});

	it('lifts when a person speaks, and an agent reply does not lift it', async () => {
		await clearRuns();
		await alternate(HANDOFF_ROUND_LIMIT);
		await insertAgentComment({ minutesAgo: 0 });
		expect(await handoffRoundsExhausted(db, taskId, false)).not.toBeNull();

		await insertHumanReply(0);
		expect(await handoffRoundsExhausted(db, taskId, false)).toBeNull();
	});

	it('restarts the count at a run something else started', async () => {
		await clearRuns();
		await alternate(HANDOFF_ROUND_LIMIT - 2, 100);
		await insertRound({
			memberId: agentId,
			minutesAgo: 60,
			source: WakeupSource.Heartbeat,
			byRun: false,
		});
		await alternate(HANDOFF_ROUND_LIMIT - 2, 50);
		expect(await handoffRoundsExhausted(db, taskId, false)).toBeNull();
	});

	it('restarts the count at a run a person started with Run now', async () => {
		await clearRuns();
		await alternate(HANDOFF_ROUND_LIMIT - 2, 100);
		await insertRound({
			memberId: agentId,
			minutesAgo: 60,
			payload: { triggered_by: { name: 'Admin' } },
		});
		await alternate(HANDOFF_ROUND_LIMIT - 2, 50);
		expect(await handoffRoundsExhausted(db, taskId, false)).toBeNull();
	});

	it('counts wakeups, not runs, and skips a run handed back unworked', async () => {
		await clearRuns();
		await alternate(HANDOFF_ROUND_LIMIT - 1, 100);
		await insertRound({ memberId: agentId, minutesAgo: 2, cancelReason: 'handed_back' });
		expect(await handoffRoundsExhausted(db, taskId, false)).toBeNull();
	});

	it('does not count a mention a person raised', async () => {
		await clearRuns();
		for (let i = 0; i < HANDOFF_ROUND_LIMIT; i++) {
			await insertRound({ memberId: agentId, minutesAgo: 50 - i * 5, byRun: false });
		}
		expect(await handoffRoundsExhausted(db, taskId, false)).toBeNull();
	});

	it('reports a notice already posted for this hold', async () => {
		await clearRuns();
		await alternate(HANDOFF_ROUND_LIMIT);
		await db.query(
			`INSERT INTO task_comments (task_id, content_type, content)
			 VALUES ($1, 'system'::comment_content_type, $2::jsonb)`,
			[taskId, JSON.stringify({ kind: 'handoff_limit', text: 'held' })],
		);
		expect((await handoffRoundsExhausted(db, taskId, false))?.notified).toBe(true);
	});

	it('never holds an exempt wakeup or a task-less one', async () => {
		await clearRuns();
		await alternate(HANDOFF_ROUND_LIMIT);
		expect(await handoffRoundsExhausted(db, taskId, true)).toBeNull();
		expect(await handoffRoundsExhausted(db, null, false)).toBeNull();
	});

	it('reports the task usage an agent sees, with the handoff count the limit reads', async () => {
		await clearRuns();
		await insertRound({
			memberId: agentId,
			minutesAgo: 60,
			source: WakeupSource.Heartbeat,
			byRun: false,
		});
		await alternate(3, 30);

		// Every started run and its tokens count; only the chain since the heartbeat
		// run counts as handoffs.
		expect(await loadTaskUsageSoFar(db, taskId)).toEqual({
			runs: 4,
			tokens: 4 * 1_001_000,
			sinceAdminReply: null,
			handoffRounds: 3,
		});
	});

	it('splits out the use since the admin last replied, which is what an agent weighs', async () => {
		await clearRuns();
		await alternate(3, 60);
		await insertHumanReply(40);
		await alternate(2, 30);

		expect(await loadTaskUsageSoFar(db, taskId)).toEqual({
			runs: 5,
			tokens: 5 * 1_001_000,
			sinceAdminReply: { runs: 2, tokens: 2 * 1_001_000 },
			handoffRounds: 2,
		});
	});

	it('does not reset the weighed use on a reply from someone who is not an admin', async () => {
		await clearRuns();
		await alternate(2, 60);
		const member = await db.query<{ id: string }>(
			`INSERT INTO users (display_name, is_superuser) VALUES ('Teammate', false) RETURNING id`,
		);
		await db.query(
			`INSERT INTO task_comments (task_id, author_user_id, content_type, content, created_at)
			 VALUES ($1, $2, 'text'::comment_content_type, '{"text":"keep going"}'::jsonb,
			         now() - interval '40 minutes')`,
			[taskId, member.rows[0].id],
		);
		await alternate(1, 30);

		expect((await loadTaskUsageSoFar(db, taskId)).sinceAdminReply).toBeNull();
		await db.query('DELETE FROM task_comments WHERE author_user_id = $1', [member.rows[0].id]);
		await db.query('DELETE FROM users WHERE id = $1', [member.rows[0].id]);
	});

	it('reports a task with no runs as nothing used', async () => {
		await clearRuns();
		expect(await loadTaskUsageSoFar(db, taskId)).toEqual({
			runs: 0,
			tokens: 0,
			sinceAdminReply: null,
			handoffRounds: 0,
		});
	});
});

describe('taskTokenCeilingReached', () => {
	/** A finished run on the shared task that used `tokens`, `minutesAgo` back. */
	async function insertRunUsing(tokens: number, minutesAgo: number): Promise<void> {
		await db.query(
			`INSERT INTO heartbeat_runs
			   (team_id, member_id, task_id, status, started_at, finished_at, input_tokens, output_tokens)
			 VALUES ($1, $2, $3, 'succeeded'::heartbeat_run_status,
			         now() - ($4 || ' minutes')::interval,
			         now() - ($4 || ' minutes')::interval + interval '30 seconds', $5, $6)`,
			[teamId, agentId, taskId, String(minutesAgo), tokens - 1_000, 1_000],
		);
	}

	it('holds a task once its runs pass the ceiling, counting input and output', async () => {
		await clearRuns();
		await insertRunUsing(TASK_TOKEN_CEILING / 2, 30);
		await insertRunUsing(TASK_TOKEN_CEILING / 2 - 1, 20);
		expect(await taskTokenCeilingReached(db, taskId, false)).toBeNull();

		await insertRunUsing(1, 10);
		expect(await taskTokenCeilingReached(db, taskId, false)).toEqual({
			tokens: TASK_TOKEN_CEILING,
			notified: false,
		});
	});

	it('grants a fresh ceiling when a person speaks, and an agent reply grants none', async () => {
		await clearRuns();
		await insertRunUsing(TASK_TOKEN_CEILING, 30);
		await insertAgentComment({ minutesAgo: 20 });
		expect(await taskTokenCeilingReached(db, taskId, false)).not.toBeNull();

		await insertHumanReply(15);
		expect(await taskTokenCeilingReached(db, taskId, false)).toBeNull();
		// Only runs after the reply count toward the fresh ceiling.
		await insertRunUsing(TASK_TOKEN_CEILING - 1, 10);
		expect(await taskTokenCeilingReached(db, taskId, false)).toBeNull();
		await insertRunUsing(1, 5);
		expect(await taskTokenCeilingReached(db, taskId, false)).not.toBeNull();
	});

	it('reports a notice already posted for this hold, and not one from before a person spoke', async () => {
		await clearRuns();
		await db.query(
			`INSERT INTO task_comments (task_id, content_type, content, created_at)
			 VALUES ($1, 'system'::comment_content_type, $2::jsonb, now() - interval '40 minutes')`,
			[taskId, JSON.stringify({ kind: 'task_token_ceiling', text: 'held' })],
		);
		await insertHumanReply(35);
		await insertRunUsing(TASK_TOKEN_CEILING, 30);
		expect((await taskTokenCeilingReached(db, taskId, false))?.notified).toBe(false);

		await db.query(
			`INSERT INTO task_comments (task_id, content_type, content)
			 VALUES ($1, 'system'::comment_content_type, $2::jsonb)`,
			[taskId, JSON.stringify({ kind: 'task_token_ceiling', text: 'held' })],
		);
		expect((await taskTokenCeilingReached(db, taskId, false))?.notified).toBe(true);
	});

	it('never holds an exempt wakeup or a task-less one', async () => {
		await clearRuns();
		await insertRunUsing(TASK_TOKEN_CEILING, 10);
		expect(await taskTokenCeilingReached(db, taskId, true)).toBeNull();
		expect(await taskTokenCeilingReached(db, null, false)).toBeNull();
	});

	it('states the usage and the ceiling in the notice', () => {
		const notice = taskTokenCeilingNotice({ tokens: 123_456_789, notified: false });
		expect(notice.kind).toBe('task_token_ceiling');
		expect(notice.text).toContain('123,456,789 tokens');
		expect(notice.text).toContain(TASK_TOKEN_CEILING.toLocaleString('en-US'));
	});
});

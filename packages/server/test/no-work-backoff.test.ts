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
	MAX_TASK_ATTEMPT_GIVEUPS,
	noWorkCooldownActive,
	parkedOnAdminAsk,
	retrospectiveHoldActive,
	TASK_ATTEMPT_WINDOW_HOURS,
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
	agentId = (await agentsRes.json()).data[0].id;
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
		expect(await noWorkCooldownActive(db, agentId, taskId, WakeupSource.Automation)).toBe(true);
	});

	it('lets the dispatch through once the heartbeat interval has elapsed', async () => {
		await clearRuns();
		await insertRun({ reportedNoWork: true, minutesAgo: 1441 });

		// The window is the operator's own cadence, so it expires exactly when a
		// scheduled heartbeat would have come round anyway.
		expect(await noWorkCooldownActive(db, agentId, taskId, WakeupSource.Automation)).toBe(false);
	});

	it('lifts the moment new input lands on the task', async () => {
		await clearRuns();
		await insertRun({ reportedNoWork: true, minutesAgo: 10 });
		await insertComment(2, null);

		expect(await noWorkCooldownActive(db, agentId, taskId, WakeupSource.Automation)).toBe(false);
	});

	it('ignores comments the no-work run itself authored', async () => {
		await clearRuns();
		const runId = await insertRun({ reportedNoWork: true, minutesAgo: 10 });
		// Backdated behind finished_at is the honest case, but a run's own comment
		// landing after it is what the created_by_run_id exclusion is for: the run
		// reporting is not new input.
		await insertComment(2, runId);

		expect(await noWorkCooldownActive(db, agentId, taskId, WakeupSource.Automation)).toBe(true);
	});

	it('does not suppress when the last run actually did work', async () => {
		await clearRuns();
		await insertRun({ reportedNoWork: false, minutesAgo: 5 });

		expect(await noWorkCooldownActive(db, agentId, taskId, WakeupSource.Automation)).toBe(false);
	});

	it('reads the most recent run, not any no-work run in history', async () => {
		await clearRuns();
		await insertRun({ reportedNoWork: true, minutesAgo: 30 });
		await insertRun({ reportedNoWork: false, minutesAgo: 3 });

		// A later run that did work says the task is live again.
		expect(await noWorkCooldownActive(db, agentId, taskId, WakeupSource.Automation)).toBe(false);
	});

	it('never suppresses a conversational source', async () => {
		await clearRuns();
		await insertRun({ reportedNoWork: true, minutesAgo: 1 });

		for (const source of [
			WakeupSource.Mention,
			WakeupSource.Comment,
			WakeupSource.Reply,
			WakeupSource.OnDemand,
			WakeupSource.CredentialProvided,
			WakeupSource.AssetDeletionResolved,
			WakeupSource.ApprovalResolved,
		]) {
			expect(await noWorkCooldownActive(db, agentId, taskId, source)).toBe(false);
		}
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
			expect(await noWorkCooldownActive(db, agentId, taskId, source)).toBe(true);
		}
	});

	it('is inert for a task-less wakeup and when the agent has never run the task', async () => {
		await clearRuns();
		expect(await noWorkCooldownActive(db, agentId, null, WakeupSource.Heartbeat)).toBe(false);
		expect(await noWorkCooldownActive(db, agentId, taskId, WakeupSource.Heartbeat)).toBe(false);
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
		expect(await noWorkCooldownActive(db, agentId, taskId, WakeupSource.Automation)).toBe(true);
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
		expect(await noWorkCooldownActive(db, agentId, taskId, WakeupSource.Automation)).toBe(true);

		await db.query(
			`UPDATE task_comments SET chosen_option = '{"status":"approved"}'::jsonb WHERE id = $1`,
			[cardId],
		);
		expect(await noWorkCooldownActive(db, agentId, taskId, WakeupSource.Automation)).toBe(false);
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

		expect(await noWorkCooldownActive(db, agentId, taskId, WakeupSource.Automation)).toBe(false);
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
		expect(await parkedOnAdminAsk(db, agentId, taskId, WakeupSource.Heartbeat)).toBe(true);
	});

	it('lifts the moment anyone else speaks', async () => {
		await clearRuns();
		await insertAgentComment({ minutesAgo: 10, raisesAdminMention: true });
		await insertComment(2, null);

		expect(await parkedOnAdminAsk(db, agentId, taskId, WakeupSource.Heartbeat)).toBe(false);
	});

	it('stays parked when the agent is the only one who spoke since', async () => {
		await clearRuns();
		await insertAgentComment({ minutesAgo: 10, raisesAdminMention: true });
		await insertAgentComment({ minutesAgo: 2 });

		// Chasing its own question is not an answer to it.
		expect(await parkedOnAdminAsk(db, agentId, taskId, WakeupSource.Heartbeat)).toBe(true);
	});

	it('parks on an unanswered choice card, and lifts once it is answered', async () => {
		await clearRuns();
		const askId = await insertAgentComment({
			minutesAgo: 10,
			contentType: CommentContentType.CredentialRequest,
		});
		expect(await parkedOnAdminAsk(db, agentId, taskId, WakeupSource.Heartbeat)).toBe(true);

		await db.query(`UPDATE task_comments SET chosen_option = '"provided"'::jsonb WHERE id = $1`, [
			askId,
		]);
		expect(await parkedOnAdminAsk(db, agentId, taskId, WakeupSource.Heartbeat)).toBe(false);
	});

	it('does not park a thread carrying no ask at all', async () => {
		await clearRuns();
		await insertAgentComment({ minutesAgo: 10 });

		expect(await parkedOnAdminAsk(db, agentId, taskId, WakeupSource.Heartbeat)).toBe(false);
	});

	it('never suppresses a conversational source, so the answer always gets through', async () => {
		await clearRuns();
		await insertAgentComment({ minutesAgo: 1, raisesAdminMention: true });

		for (const source of [
			WakeupSource.Mention,
			WakeupSource.Comment,
			WakeupSource.Reply,
			WakeupSource.OnDemand,
			WakeupSource.CredentialProvided,
			WakeupSource.AssetDeletionResolved,
			WakeupSource.ApprovalResolved,
		]) {
			expect(await parkedOnAdminAsk(db, agentId, taskId, source)).toBe(false);
		}
	});

	it('lifts when the admin answers a card, even though answering writes no comment', async () => {
		await clearRuns();
		const cardId = await insertAgentComment({
			minutesAgo: 20,
			contentType: CommentContentType.Action,
		});
		await insertAgentComment({ minutesAgo: 10, raisesAdminMention: true });
		expect(await parkedOnAdminAsk(db, agentId, taskId, WakeupSource.Heartbeat)).toBe(true);

		// The admin acting on the thread is the admin speaking on it, whoever
		// authored the card. `chosen_at` is the only trace it leaves.
		await db.query(
			`UPDATE task_comments SET chosen_option = '{"status":"approved"}'::jsonb WHERE id = $1`,
			[cardId],
		);
		expect(await parkedOnAdminAsk(db, agentId, taskId, WakeupSource.Heartbeat)).toBe(false);
	});

	it('returns false for a task-less wakeup', async () => {
		expect(await parkedOnAdminAsk(db, agentId, null, WakeupSource.Heartbeat)).toBe(false);
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

		expect(await noWorkCooldownActive(db, agentId, taskId, WakeupSource.Automation)).toBe(true);
		expect(await parkedOnAdminAsk(db, agentId, taskId, WakeupSource.Automation)).toBe(true);

		expect(await noWorkCooldownActive(db, agentId, taskId, WakeupSource.ApprovalResolved)).toBe(
			false,
		);
		expect(await parkedOnAdminAsk(db, agentId, taskId, WakeupSource.ApprovalResolved)).toBe(false);
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
		expect(await attemptsExhaustedOnTask(db, agentId, taskId, WakeupSource.Heartbeat)).toBe(true);
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
		expect(await attemptsExhaustedOnTask(db, agentId, taskId, WakeupSource.Heartbeat)).toBe(true);
	});

	it('stays under the bound one attempt short of it', async () => {
		await clearRuns();
		for (let i = 0; i < MAX_TASK_ATTEMPT_GIVEUPS - 1; i++) {
			await insertEnding(HeartbeatRunStatus.TimedOut, (i + 1) * 10);
		}
		expect(await attemptsExhaustedOnTask(db, agentId, taskId, WakeupSource.Heartbeat)).toBe(false);
	});

	it('resets on a run that finished the work, and only on that', async () => {
		await clearRuns();
		for (let i = 0; i < MAX_TASK_ATTEMPT_GIVEUPS; i++) {
			await insertEnding(HeartbeatRunStatus.TimedOut, 100 + i * 10);
		}
		await insertEnding(HeartbeatRunStatus.Succeeded, 50);
		expect(await attemptsExhaustedOnTask(db, agentId, taskId, WakeupSource.Heartbeat)).toBe(false);
	});

	it('does not count a run a person terminated', async () => {
		await clearRuns();
		for (let i = 0; i < MAX_TASK_ATTEMPT_GIVEUPS; i++) {
			await insertEnding(HeartbeatRunStatus.Cancelled, (i + 1) * 10, 'operator_terminated');
		}
		// Pressing Terminate repeatedly must not park the operator's own task.
		expect(await attemptsExhaustedOnTask(db, agentId, taskId, WakeupSource.Heartbeat)).toBe(false);
	});

	it('ignores attempts older than the window', async () => {
		await clearRuns();
		const outsideWindow = TASK_ATTEMPT_WINDOW_HOURS * 60 + 60;
		for (let i = 0; i < MAX_TASK_ATTEMPT_GIVEUPS; i++) {
			await insertEnding(HeartbeatRunStatus.TimedOut, outsideWindow + i * 10);
		}
		expect(await attemptsExhaustedOnTask(db, agentId, taskId, WakeupSource.Heartbeat)).toBe(false);
	});

	it('never suppresses a source a person raised, so an answer always gets through', async () => {
		await clearRuns();
		for (let i = 0; i < MAX_TASK_ATTEMPT_GIVEUPS; i++) {
			await insertEnding(HeartbeatRunStatus.TimedOut, (i + 1) * 10);
		}
		for (const source of [WakeupSource.Mention, WakeupSource.Reply, WakeupSource.OnDemand]) {
			expect(await attemptsExhaustedOnTask(db, agentId, taskId, source), source).toBe(false);
		}
	});

	it('is inert for a task-less wakeup', async () => {
		expect(await attemptsExhaustedOnTask(db, agentId, null, WakeupSource.Heartbeat)).toBe(false);
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

	it('holds the task while a retrospective finding waits on a person', async () => {
		await clearRuns();
		await insertFinding(30);
		// Reporting a loop without stopping it is what this exists to prevent: an
		// @admin comment alone raises the Inbox row and suppresses no dispatches.
		expect(await retrospectiveHoldActive(db, agentId, taskId, WakeupSource.Heartbeat)).toBe(true);
	});

	it('lifts the moment a person replies', async () => {
		await clearRuns();
		await insertFinding(30);
		await insertHumanReply(5);
		expect(await retrospectiveHoldActive(db, agentId, taskId, WakeupSource.Heartbeat)).toBe(false);
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
		expect(await retrospectiveHoldActive(db, agentId, taskId, WakeupSource.Heartbeat)).toBe(false);
	});

	it('is not lifted by a card the person has not answered', async () => {
		await clearRuns();
		await insertFinding(30);
		await db.query(
			`INSERT INTO task_comments (task_id, author_member_id, content_type, content, created_at)
			 VALUES ($1, $2, 'text'::comment_content_type, $3::jsonb, now() - interval '5 minutes')`,
			[taskId, agentId, JSON.stringify({ text: 'Which of these should I drop?' })],
		);
		expect(await retrospectiveHoldActive(db, agentId, taskId, WakeupSource.Heartbeat)).toBe(true);
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
		expect(await retrospectiveHoldActive(db, agentId, taskId, WakeupSource.Heartbeat)).toBe(true);
	});

	it('never suppresses a source a person raised', async () => {
		await clearRuns();
		await insertFinding(30);
		for (const source of [WakeupSource.Mention, WakeupSource.Reply, WakeupSource.OnDemand]) {
			expect(await retrospectiveHoldActive(db, agentId, taskId, source), source).toBe(false);
		}
	});

	it('holds nothing when no retrospective has spoken', async () => {
		await clearRuns();
		expect(await retrospectiveHoldActive(db, agentId, taskId, WakeupSource.Heartbeat)).toBe(false);
		expect(await retrospectiveHoldActive(db, agentId, null, WakeupSource.Heartbeat)).toBe(false);
	});
});

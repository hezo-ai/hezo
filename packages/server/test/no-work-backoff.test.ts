import { CommentContentType, HeartbeatRunStatus, TaskStatus, WakeupSource } from '@hezo/shared';
import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Db } from '../src/db/database';
import type { Env } from '../src/lib/types';
import { noWorkCooldownActive, parkedOnAdminAsk } from '../src/services/no-work-backoff';
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
		]) {
			expect(await parkedOnAdminAsk(db, agentId, taskId, source)).toBe(false);
		}
	});

	it('returns false for a task-less wakeup', async () => {
		expect(await parkedOnAdminAsk(db, agentId, null, WakeupSource.Heartbeat)).toBe(false);
	});
});

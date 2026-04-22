import type { PGlite } from '@electric-sql/pglite';
import { CommentContentType, IssueStatus, WakeupSource } from '@hezo/shared';
import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Env } from '../../lib/types';
import {
	buildTaskPrompt,
	loadMentionContext,
	loadReplyContext,
	loadSpawnedFromIssue,
} from '../../services/agent-runner';
import { safeClose } from '../helpers';
import { authHeader, createTestApp } from '../helpers/app';

let app: Hono<Env>;
let db: PGlite;
let token: string;

let companyId: string;
let projectId: string;
let ceoMemberId: string;
let architectMemberId: string;

const TRIGGERING_ISSUE: Parameters<typeof buildTaskPrompt>[1] = {
	id: 'filled-below',
	identifier: 'filled-below',
	title: 'CEO PRD ticket',
	description: 'Project definition and roadmap.',
	status: 'in_progress',
	priority: 'high',
	project_id: 'filled-below',
	rules: null,
};

beforeAll(async () => {
	const ctx = await createTestApp();
	app = ctx.app;
	db = ctx.db;
	token = ctx.token;

	const typesRes = await app.request('/api/company-types', { headers: authHeader(token) });
	const typeId = (await typesRes.json()).data.find(
		(t: Record<string, unknown>) => t.name === 'Startup',
	).id;

	const companyRes = await app.request('/api/companies', {
		method: 'POST',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({
			name: 'Mention Handoff Prompt Co',
			template_id: typeId,
			issue_prefix: 'MHP',
		}),
	});
	companyId = (await companyRes.json()).data.id;

	const agentsRes = await app.request(`/api/companies/${companyId}/agents`, {
		headers: authHeader(token),
	});
	const agents = (await agentsRes.json()).data as Array<{ id: string; slug: string }>;
	ceoMemberId = agents.find((a) => a.slug === 'ceo')!.id;
	architectMemberId = agents.find((a) => a.slug === 'architect')!.id;

	const projectRes = await app.request(`/api/companies/${companyId}/projects`, {
		method: 'POST',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({ name: 'Handoff project', description: 'Test' }),
	});
	projectId = (await projectRes.json()).data.id;
});

afterAll(async () => {
	await safeClose(db);
});

async function createTriggeringIssueWithComment(commentText: string): Promise<{
	triggeringIssueId: string;
	triggeringIdentifier: string;
	commentId: string;
}> {
	const issueRes = await app.request(`/api/companies/${companyId}/issues`, {
		method: 'POST',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({
			project_id: projectId,
			title: "CEO's PRD ticket",
			assignee_id: ceoMemberId,
		}),
	});
	const issue = (await issueRes.json()).data as { id: string; identifier: string };

	const commentInsert = await db.query<{ id: string }>(
		`INSERT INTO issue_comments (issue_id, author_member_id, content_type, content)
		 VALUES ($1, $2, $3::comment_content_type, $4::jsonb)
		 RETURNING id`,
		[issue.id, ceoMemberId, CommentContentType.Text, JSON.stringify({ text: commentText })],
	);

	return {
		triggeringIssueId: issue.id,
		triggeringIdentifier: issue.identifier,
		commentId: commentInsert.rows[0].id,
	};
}

async function createArchitectTicket(
	title: string,
	status: IssueStatus = IssueStatus.Open,
): Promise<{ id: string; identifier: string }> {
	const res = await app.request(`/api/companies/${companyId}/issues`, {
		method: 'POST',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({
			project_id: projectId,
			title,
			assignee_id: architectMemberId,
		}),
	});
	const data = (await res.json()).data as { id: string; identifier: string };

	if (status !== IssueStatus.Backlog) {
		await app.request(`/api/companies/${companyId}/issues/${data.id}`, {
			method: 'PATCH',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ status }),
		});
	}
	return data;
}

describe('mention handoff prompt (integration)', () => {
	it('renders the handoff block with triggering ticket + author + open tickets', async () => {
		const { triggeringIssueId, triggeringIdentifier, commentId } =
			await createTriggeringIssueWithComment('@architect please bring the spec up to date');

		const specTicket = await createArchitectTicket('Spec draft', IssueStatus.InProgress);
		const prdTicket = await createArchitectTicket('Review PRD');

		const wakeupPayload = {
			source: WakeupSource.Mention,
			issue_id: triggeringIssueId,
			comment_id: commentId,
		};

		const ctx = await loadMentionContext(db, architectMemberId, companyId, wakeupPayload);
		expect(ctx).not.toBeNull();
		expect(ctx?.authorName).toBeTruthy();
		expect(ctx?.excerpt).toContain('bring the spec up to date');
		expect(ctx?.openTickets.map((t) => t.identifier).sort()).toEqual(
			[specTicket.identifier, prdTicket.identifier].sort(),
		);

		const prompt = buildTaskPrompt(
			'System prompt',
			{
				...TRIGGERING_ISSUE,
				id: triggeringIssueId,
				identifier: triggeringIdentifier,
				project_id: projectId,
			},
			wakeupPayload,
			{ mentionContext: ctx },
		);

		expect(prompt).toContain('## Mention Handoff');
		expect(prompt).toContain(triggeringIdentifier);
		expect(prompt).toContain(specTicket.identifier);
		expect(prompt).toContain(prdTicket.identifier);
		expect(prompt).toContain('> @architect please bring the spec up to date');
		expect(prompt).toContain('create_issue');
		expect(prompt).toContain('brief, meaningful acknowledgement');
	});

	it('renders "none" when the mentioned agent has no open tickets', async () => {
		// Fresh company to isolate state — the architect in this company has no tickets.
		const typesRes = await app.request('/api/company-types', { headers: authHeader(token) });
		const typeId = (await typesRes.json()).data.find(
			(t: Record<string, unknown>) => t.name === 'Startup',
		).id;
		const companyRes = await app.request('/api/companies', {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				name: 'No Tickets Co',
				template_id: typeId,
				issue_prefix: 'NTC',
			}),
		});
		const soloCompanyId = (await companyRes.json()).data.id;
		const agentsRes = await app.request(`/api/companies/${soloCompanyId}/agents`, {
			headers: authHeader(token),
		});
		const agents = (await agentsRes.json()).data as Array<{ id: string; slug: string }>;
		const ceo = agents.find((a) => a.slug === 'ceo')!;
		const architect = agents.find((a) => a.slug === 'architect')!;
		const projRes = await app.request(`/api/companies/${soloCompanyId}/projects`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ name: 'No tickets', description: 'x' }),
		});
		const soloProjectId = (await projRes.json()).data.id;
		const issueRes = await app.request(`/api/companies/${soloCompanyId}/issues`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				project_id: soloProjectId,
				title: 'CEO ticket only',
				assignee_id: ceo.id,
			}),
		});
		const triggering = (await issueRes.json()).data as { id: string; identifier: string };

		const commentInsert = await db.query<{ id: string }>(
			`INSERT INTO issue_comments (issue_id, author_member_id, content_type, content)
			 VALUES ($1, $2, $3::comment_content_type, $4::jsonb)
			 RETURNING id`,
			[
				triggering.id,
				ceo.id,
				CommentContentType.Text,
				JSON.stringify({ text: '@architect weigh in' }),
			],
		);

		const payload = {
			source: WakeupSource.Mention,
			issue_id: triggering.id,
			comment_id: commentInsert.rows[0].id,
		};
		const ctx = await loadMentionContext(db, architect.id, soloCompanyId, payload);
		expect(ctx?.openTickets.length).toBe(0);

		const prompt = buildTaskPrompt(
			'System',
			{
				id: triggering.id,
				identifier: triggering.identifier,
				title: 'CEO ticket only',
				description: 'x',
				status: 'open',
				priority: 'medium',
				project_id: soloProjectId,
				rules: null,
			},
			payload,
			{ mentionContext: ctx },
		);
		expect(prompt).toContain('### Your open tickets\nnone');
	});

	it('drops the mandated "Tracking this on" phrase but keeps the sub-issue/peer/top-level guidance', async () => {
		const { triggeringIssueId, triggeringIdentifier, commentId } =
			await createTriggeringIssueWithComment('@architect review please');
		const wakeupPayload = {
			source: WakeupSource.Mention,
			issue_id: triggeringIssueId,
			comment_id: commentId,
		};
		const ctx = await loadMentionContext(db, architectMemberId, companyId, wakeupPayload);
		const prompt = buildTaskPrompt(
			'System',
			{
				...TRIGGERING_ISSUE,
				id: triggeringIssueId,
				identifier: triggeringIdentifier,
				project_id: projectId,
			},
			wakeupPayload,
			{ mentionContext: ctx },
		);
		expect(prompt).not.toContain('"Tracking this on {your_ticket_identifier}."');
		expect(prompt).toContain('sub-issue');
		expect(prompt).toContain('peer-level');
		expect(prompt).toContain('top-level');
	});

	it('truncates long comment excerpts and strips fenced code', async () => {
		const longBody = `Here is a proposal:\n\`\`\`\n${'payload'.repeat(100)}\n\`\`\`\nand ${'x'.repeat(700)} tail`;
		const { triggeringIssueId, commentId } = await createTriggeringIssueWithComment(longBody);

		const ctx = await loadMentionContext(db, architectMemberId, companyId, {
			source: WakeupSource.Mention,
			issue_id: triggeringIssueId,
			comment_id: commentId,
		});
		expect(ctx).not.toBeNull();
		const excerpt = ctx?.excerpt ?? '';
		expect(excerpt.length).toBeLessThanOrEqual(501);
		expect(excerpt).toContain('[code omitted]');
		expect(excerpt).not.toContain('payload'.repeat(10));
		expect(excerpt.endsWith('…')).toBe(true);
	});
});

describe('reply handoff prompt (integration)', () => {
	async function seedReplyScenario(): Promise<{
		triggeringIssueId: string;
		triggeringIdentifier: string;
		triggeringCommentId: string;
		replyCommentId: string;
		newTicket: { id: string; identifier: string; title: string };
	}> {
		const { triggeringIssueId, triggeringIdentifier, commentId } =
			await createTriggeringIssueWithComment('@architect please take point on this');

		const newTicketRes = await app.request(`/api/companies/${companyId}/issues`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				project_id: projectId,
				title: 'Follow-up work on architecture',
				assignee_id: architectMemberId,
			}),
		});
		const newTicket = (await newTicketRes.json()).data as {
			id: string;
			identifier: string;
			title: string;
		};

		const replyInsert = await db.query<{ id: string }>(
			`INSERT INTO issue_comments (issue_id, author_member_id, content_type, content)
			 VALUES ($1, $2, $3::comment_content_type, $4::jsonb)
			 RETURNING id`,
			[
				triggeringIssueId,
				architectMemberId,
				CommentContentType.Text,
				JSON.stringify({ text: `Got it — carrying this forward on ${newTicket.identifier}.` }),
			],
		);

		return {
			triggeringIssueId,
			triggeringIdentifier,
			triggeringCommentId: commentId,
			replyCommentId: replyInsert.rows[0].id,
			newTicket,
		};
	}

	it('loads the reply excerpt, original excerpt, and referenced new ticket', async () => {
		const { triggeringCommentId, replyCommentId, newTicket } = await seedReplyScenario();
		const ctx = await loadReplyContext(db, {
			source: WakeupSource.Reply,
			issue_id: 'ignored-by-loader',
			comment_id: replyCommentId,
			triggering_comment_id: triggeringCommentId,
		});
		expect(ctx).not.toBeNull();
		expect(ctx?.replyExcerpt).toContain(newTicket.identifier);
		expect(ctx?.originalExcerpt).toContain('please take point');
		expect(ctx?.referencedIssues.map((i) => i.identifier)).toContain(newTicket.identifier);
		expect(ctx?.responderName).toBeTruthy();
		expect(ctx?.responderSlug).toBe('architect');
	});

	it('renders a Reply Handoff block when the wakeup source is Reply', async () => {
		const { triggeringIssueId, triggeringIdentifier, triggeringCommentId, replyCommentId } =
			await seedReplyScenario();
		const payload = {
			source: WakeupSource.Reply,
			issue_id: triggeringIssueId,
			comment_id: replyCommentId,
			triggering_comment_id: triggeringCommentId,
		};
		const ctx = await loadReplyContext(db, payload);
		const prompt = buildTaskPrompt(
			'System',
			{
				...TRIGGERING_ISSUE,
				id: triggeringIssueId,
				identifier: triggeringIdentifier,
				project_id: projectId,
			},
			payload,
			{ replyContext: ctx },
		);
		expect(prompt).toContain('## Reply Received');
		expect(prompt).toContain('replied on');
		expect(prompt).toContain('### Their reply');
		expect(prompt).toContain('### Tickets referenced by the reply');
		expect(prompt).toContain('may choose to wait');
	});

	it('returns null when the wakeup payload is missing reply ids', async () => {
		const ctx = await loadReplyContext(db, {
			source: WakeupSource.Reply,
			issue_id: 'x',
		});
		expect(ctx).toBeNull();
	});
});

describe('spawned-from prompt line', () => {
	it('renders "Parent ticket" when parent_issue_id matches the spawning run', async () => {
		const issueRes = await app.request(`/api/companies/${companyId}/issues`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				project_id: projectId,
				title: 'Parent CEO work',
				assignee_id: ceoMemberId,
			}),
		});
		const parent = (await issueRes.json()).data as { id: string; identifier: string };

		const run = await db.query<{ id: string }>(
			`INSERT INTO heartbeat_runs (member_id, company_id, issue_id, status, started_at)
			 VALUES ($1, $2, $3, 'running'::heartbeat_run_status, now())
			 RETURNING id`,
			[ceoMemberId, companyId, parent.id],
		);

		const subRes = await db.query<{ id: string; identifier: string }>(
			`INSERT INTO issues (company_id, project_id, assignee_id, parent_issue_id, created_by_run_id, number, identifier, title, description, status, priority, labels)
			 VALUES ($1, $2, $3, $4, $5, next_issue_number($1), 'MHP-sub', 'Sub work', '', 'backlog'::issue_status, 'medium'::issue_priority, '[]'::jsonb)
			 RETURNING id, identifier`,
			[companyId, projectId, architectMemberId, parent.id, run.rows[0].id],
		);
		const sub = subRes.rows[0];

		const spawn = await loadSpawnedFromIssue(db, {
			id: sub.id,
			identifier: sub.identifier,
			title: 'Sub work',
			description: '',
			status: 'backlog',
			priority: 'medium',
			project_id: projectId,
			rules: null,
			parent_issue_id: parent.id,
			created_by_run_id: run.rows[0].id,
		});
		expect(spawn?.parentLine).toContain(parent.identifier);
		expect(spawn?.spawnLine).toBeNull();

		const prompt = buildTaskPrompt(
			'System',
			{
				id: sub.id,
				identifier: sub.identifier,
				title: 'Sub work',
				description: '',
				status: 'backlog',
				priority: 'medium',
				project_id: projectId,
				rules: null,
				parent_issue_id: parent.id,
				created_by_run_id: run.rows[0].id,
			},
			undefined,
			{ spawnedFrom: spawn },
		);
		expect(prompt).toContain(`**Parent ticket:** ${parent.identifier}`);
		expect(prompt).not.toContain('**Spawned from:**');
	});

	it('renders "Spawned from" when a sibling/top-level ticket has no structural parent', async () => {
		const issueRes = await app.request(`/api/companies/${companyId}/issues`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				project_id: projectId,
				title: 'Spawning CEO work',
				assignee_id: ceoMemberId,
			}),
		});
		const spawning = (await issueRes.json()).data as { id: string; identifier: string };

		const run = await db.query<{ id: string }>(
			`INSERT INTO heartbeat_runs (member_id, company_id, issue_id, status, started_at)
			 VALUES ($1, $2, $3, 'running'::heartbeat_run_status, now())
			 RETURNING id`,
			[ceoMemberId, companyId, spawning.id],
		);

		const topRes = await db.query<{ id: string; identifier: string }>(
			`INSERT INTO issues (company_id, project_id, assignee_id, created_by_run_id, number, identifier, title, description, status, priority, labels)
			 VALUES ($1, $2, $3, $4, next_issue_number($1), 'MHP-top', 'Top-level follow-up', '', 'backlog'::issue_status, 'medium'::issue_priority, '[]'::jsonb)
			 RETURNING id, identifier`,
			[companyId, projectId, architectMemberId, run.rows[0].id],
		);
		const top = topRes.rows[0];

		const spawn = await loadSpawnedFromIssue(db, {
			id: top.id,
			identifier: top.identifier,
			title: 'Top-level follow-up',
			description: '',
			status: 'backlog',
			priority: 'medium',
			project_id: projectId,
			rules: null,
			parent_issue_id: null,
			created_by_run_id: run.rows[0].id,
		});
		expect(spawn?.parentLine).toBeNull();
		expect(spawn?.spawnLine).toContain(spawning.identifier);

		const prompt = buildTaskPrompt(
			'System',
			{
				id: top.id,
				identifier: top.identifier,
				title: 'Top-level follow-up',
				description: '',
				status: 'backlog',
				priority: 'medium',
				project_id: projectId,
				rules: null,
				parent_issue_id: null,
				created_by_run_id: run.rows[0].id,
			},
			undefined,
			{ spawnedFrom: spawn },
		);
		expect(prompt).toContain(`**Spawned from:** ${spawning.identifier}`);
		expect(prompt).not.toContain('**Parent ticket:**');
	});

	it('returns null for an orphan ticket (no parent, no created_by_run_id)', async () => {
		const spawn = await loadSpawnedFromIssue(db, {
			id: '00000000-0000-0000-0000-000000000000',
			identifier: 'MHP-orphan',
			title: 'Orphan',
			description: '',
			status: 'backlog',
			priority: 'medium',
			project_id: projectId,
			rules: null,
			parent_issue_id: null,
			created_by_run_id: null,
		});
		expect(spawn).toBeNull();
	});
});

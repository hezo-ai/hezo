import type { PGlite } from '@electric-sql/pglite';
import { CommentContentType, IssueStatus, WakeupSource } from '@hezo/shared';
import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Env } from '../../lib/types';
import { buildTaskPrompt, loadMentionContext } from '../../services/agent-runner';
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
			ctx,
		);

		expect(prompt).toContain('## Mention Handoff');
		expect(prompt).toContain(triggeringIdentifier);
		expect(prompt).toContain(specTicket.identifier);
		expect(prompt).toContain(prdTicket.identifier);
		expect(prompt).toContain('> @architect please bring the spec up to date');
		// Routing directive present
		expect(prompt).toContain('create_issue');
		expect(prompt).toContain('Tracking this on');
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
			ctx,
		);
		expect(prompt).toContain('### Your open tickets\nnone');
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

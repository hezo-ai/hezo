import type { PGlite } from '@electric-sql/pglite';
import { CommentContentType, IssueStatus } from '@hezo/shared';
import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MasterKeyManager } from '../../crypto/master-key';
import type { Env } from '../../lib/types';
import { extractIssueIdentifiers } from '../../services/issue-events';
import { safeClose } from '../helpers';
import { authHeader, createTestApp, mintAgentToken } from '../helpers/app';

let app: Hono<Env>;
let db: PGlite;
let token: string;
let masterKeyManager: MasterKeyManager;
let companyId: string;
let projectId: string;
let agentId: string;

interface CommentRow {
	id: string;
	issue_id: string;
	content_type: string;
	content: {
		text?: string;
		kind?: string;
		from?: string;
		to?: string;
		actor_id?: string | null;
		source_issue_id?: string;
		source_identifier?: string;
	};
	author_member_id: string | null;
	created_at: string;
}

async function createIssue(
	title: string,
	description = '',
): Promise<{ id: string; identifier: string }> {
	const res = await app.request(`/api/companies/${companyId}/issues`, {
		method: 'POST',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({ project_id: projectId, title, description, assignee_id: agentId }),
	});
	const body = await res.json();
	return { id: body.data.id, identifier: body.data.identifier };
}

async function listComments(issueId: string): Promise<CommentRow[]> {
	const res = await app.request(`/api/companies/${companyId}/issues/${issueId}/comments`, {
		headers: authHeader(token),
	});
	return (await res.json()).data;
}

async function systemComments(issueId: string, kind: string): Promise<CommentRow[]> {
	const all = await listComments(issueId);
	return all.filter(
		(c) => c.content_type === CommentContentType.System && c.content?.kind === kind,
	);
}

beforeAll(async () => {
	const ctx = await createTestApp();
	app = ctx.app;
	db = ctx.db;
	token = ctx.token;
	masterKeyManager = ctx.masterKeyManager;

	const companyRes = await app.request('/api/companies', {
		method: 'POST',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({ name: 'Events Co' }),
	});
	companyId = (await companyRes.json()).data.id;

	const projectRes = await app.request(`/api/companies/${companyId}/projects`, {
		method: 'POST',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({ name: 'Widget', description: 'Widget project.' }),
	});
	projectId = (await projectRes.json()).data.id;

	const agentRes = await app.request(`/api/companies/${companyId}/agents`, {
		method: 'POST',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({ title: 'Status Bot' }),
	});
	agentId = (await agentRes.json()).data.id;
});

afterAll(async () => {
	await safeClose(db);
});

describe('extractIssueIdentifiers', () => {
	it('returns identifiers from plain prose', () => {
		expect(extractIssueIdentifiers('see OP-42 for the rest')).toEqual(['OP-42']);
	});

	it('finds multiple unique identifiers', () => {
		expect(extractIssueIdentifiers('see OP-1 and OP-2 — also OP-1 again').sort()).toEqual([
			'OP-1',
			'OP-2',
		]);
	});

	it('skips identifiers in fenced code blocks', () => {
		expect(extractIssueIdentifiers('text\n```\nOP-9\n```\nmore')).toEqual([]);
	});

	it('skips identifiers in inline code', () => {
		expect(extractIssueIdentifiers('inline `OP-9` here')).toEqual([]);
	});

	it('skips lowercase identifiers', () => {
		expect(extractIssueIdentifiers('check op-9 sometime')).toEqual([]);
	});

	it('returns [] for null/undefined/empty', () => {
		expect(extractIssueIdentifiers(null)).toEqual([]);
		expect(extractIssueIdentifiers(undefined)).toEqual([]);
		expect(extractIssueIdentifiers('')).toEqual([]);
	});
});

describe('status change system events', () => {
	it('records a board-authored PATCH status change with from/to and "Board" actor', async () => {
		const issue = await createIssue('PATCH by board');
		const before = (await systemComments(issue.id, 'status_change')).length;

		const res = await app.request(`/api/companies/${companyId}/issues/${issue.id}`, {
			method: 'PATCH',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ status: IssueStatus.InProgress }),
		});
		expect(res.status).toBe(200);

		const after = await systemComments(issue.id, 'status_change');
		expect(after.length).toBe(before + 1);
		const ev = after[after.length - 1];
		expect(ev.content.from).toBe(IssueStatus.Backlog);
		expect(ev.content.to).toBe(IssueStatus.InProgress);
		expect(ev.content.text).toContain('Test Admin');
		expect(ev.content.text).toContain(IssueStatus.Backlog);
		expect(ev.content.text).toContain(IssueStatus.InProgress);
		expect(ev.author_member_id).not.toBeNull();
	});

	it('records an agent-authored PATCH status change attributed to the agent', async () => {
		const issue = await createIssue('PATCH by agent');
		const { token: agentToken } = await mintAgentToken(db, masterKeyManager, agentId, companyId);

		const res = await app.request(`/api/companies/${companyId}/issues/${issue.id}`, {
			method: 'PATCH',
			headers: { ...authHeader(agentToken), 'Content-Type': 'application/json' },
			body: JSON.stringify({ status: IssueStatus.InProgress }),
		});
		expect(res.status).toBe(200);

		const events = await systemComments(issue.id, 'status_change');
		const ev = events[events.length - 1];
		expect(ev.content.text).toContain('Status Bot');
		expect(ev.content.actor_id).toBe(agentId);
		expect(ev.author_member_id).toBe(agentId);
	});

	it('does not record an event when the status is unchanged', async () => {
		const issue = await createIssue('Unchanged status');
		const before = (await systemComments(issue.id, 'status_change')).length;

		const res = await app.request(`/api/companies/${companyId}/issues/${issue.id}`, {
			method: 'PATCH',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ status: IssueStatus.Backlog }),
		});
		expect(res.status).toBe(200);

		const after = await systemComments(issue.id, 'status_change');
		expect(after.length).toBe(before);
	});
});

describe('issue link system events', () => {
	it('creates a link comment on the target the first time another issue mentions it', async () => {
		const target = await createIssue('Target ticket');
		const source = await createIssue('Source ticket');

		const res = await app.request(`/api/companies/${companyId}/issues/${source.id}/comments`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				content_type: 'text',
				content: { text: `see ${target.identifier} for context` },
			}),
		});
		expect(res.status).toBe(201);

		const links = await systemComments(target.id, 'issue_link');
		expect(links).toHaveLength(1);
		expect(links[0].content.source_issue_id).toBe(source.id);
		expect(links[0].content.source_identifier).toBe(source.identifier);
		expect(links[0].content.text).toContain(`Linked from ${source.identifier}`);
	});

	it('does not create a second link comment for repeat mentions from the same source', async () => {
		const target = await createIssue('Target repeat');
		const source = await createIssue('Source repeat');

		for (const text of [`first mention ${target.identifier}`, `another ${target.identifier}`]) {
			await app.request(`/api/companies/${companyId}/issues/${source.id}/comments`, {
				method: 'POST',
				headers: { ...authHeader(token), 'Content-Type': 'application/json' },
				body: JSON.stringify({ content_type: 'text', content: { text } }),
			});
		}

		const links = await systemComments(target.id, 'issue_link');
		expect(links).toHaveLength(1);
	});

	it('records a link from issue creation when the description mentions another issue', async () => {
		const target = await createIssue('Target via desc');
		const source = await createIssue(
			'Source via desc',
			`pre-existing link to ${target.identifier}`,
		);

		const links = await systemComments(target.id, 'issue_link');
		const fromSource = links.find((l) => l.content.source_issue_id === source.id);
		expect(fromSource).toBeTruthy();
	});

	it('ignores self-references', async () => {
		const issue = await createIssue('Self ref');
		await app.request(`/api/companies/${companyId}/issues/${issue.id}/comments`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				content_type: 'text',
				content: { text: `this is ${issue.identifier} talking about itself` },
			}),
		});
		const links = await systemComments(issue.id, 'issue_link');
		expect(links).toHaveLength(0);
	});

	it('ignores identifiers inside fenced code blocks', async () => {
		const target = await createIssue('Target codeblock');
		const source = await createIssue('Source codeblock');
		await app.request(`/api/companies/${companyId}/issues/${source.id}/comments`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				content_type: 'text',
				content: { text: `inert\n\`\`\`\n${target.identifier}\n\`\`\`\n` },
			}),
		});
		const links = await systemComments(target.id, 'issue_link');
		expect(links).toHaveLength(0);
	});

	it('ignores unknown identifiers', async () => {
		const source = await createIssue('Source unknown');
		const before = await db.query<{ count: string }>(
			"SELECT count(*)::text AS count FROM issue_comments WHERE content_type = 'system' AND content->>'kind' = 'issue_link'",
		);
		await app.request(`/api/companies/${companyId}/issues/${source.id}/comments`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ content_type: 'text', content: { text: 'see XX-99 for nothing' } }),
		});
		const after = await db.query<{ count: string }>(
			"SELECT count(*)::text AS count FROM issue_comments WHERE content_type = 'system' AND content->>'kind' = 'issue_link'",
		);
		expect(after.rows[0].count).toBe(before.rows[0].count);
	});

	it('does not cross company boundaries', async () => {
		const targetA = await createIssue('Cross-company target');

		const otherCompanyRes = await app.request('/api/companies', {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ name: 'Other Co' }),
		});
		const otherCompanyId = (await otherCompanyRes.json()).data.id;
		const otherProjectRes = await app.request(`/api/companies/${otherCompanyId}/projects`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ name: 'Foreign', description: 'Other.' }),
		});
		const otherProjectId = (await otherProjectRes.json()).data.id;
		const otherAgentRes = await app.request(`/api/companies/${otherCompanyId}/agents`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ title: 'Other Bot' }),
		});
		const otherAgentId = (await otherAgentRes.json()).data.id;

		const otherIssueRes = await app.request(`/api/companies/${otherCompanyId}/issues`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				project_id: otherProjectId,
				title: 'Foreign source',
				assignee_id: otherAgentId,
			}),
		});
		const otherIssue = (await otherIssueRes.json()).data;

		await app.request(`/api/companies/${otherCompanyId}/issues/${otherIssue.id}/comments`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				content_type: 'text',
				content: { text: `mentions ${targetA.identifier} from another company` },
			}),
		});

		const links = await systemComments(targetA.id, 'issue_link');
		expect(links).toHaveLength(0);
	});

	it('records links for multiple targets in a single comment', async () => {
		const target1 = await createIssue('Multi target 1');
		const target2 = await createIssue('Multi target 2');
		const source = await createIssue('Multi source');

		await app.request(`/api/companies/${companyId}/issues/${source.id}/comments`, {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				content_type: 'text',
				content: { text: `${target1.identifier} and ${target2.identifier}` },
			}),
		});

		const links1 = await systemComments(target1.id, 'issue_link');
		const links2 = await systemComments(target2.id, 'issue_link');
		expect(links1.some((l) => l.content.source_issue_id === source.id)).toBe(true);
		expect(links2.some((l) => l.content.source_issue_id === source.id)).toBe(true);
	});
});

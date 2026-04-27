import type { PGlite } from '@electric-sql/pglite';
import { CEO_AGENT_SLUG } from '@hezo/shared';
import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MasterKeyManager } from '../../crypto/master-key';
import {
	assertSubordinateAssignee,
	assignmentHierarchyError,
} from '../../lib/assignment-hierarchy';
import type { Env } from '../../lib/types';
import { safeClose } from '../helpers';
import { authHeader, createTestApp, mintAgentToken } from '../helpers/app';

let app: Hono<Env>;
let db: PGlite;
let token: string;
let masterKeyManager: MasterKeyManager;
let companyId: string;
let projectId: string;

let ceoId: string;
let architectId: string;
let productLeadId: string;
let engineerId: string;
let qaEngineerId: string;
let coachId: string;

async function callTool(
	bearer: string,
	name: string,
	args: Record<string, unknown>,
): Promise<Record<string, unknown>> {
	const res = await app.request('/mcp', {
		method: 'POST',
		headers: { ...authHeader(bearer), 'Content-Type': 'application/json' },
		body: JSON.stringify({
			jsonrpc: '2.0',
			method: 'tools/call',
			params: { name, arguments: args },
			id: 1,
		}),
	});
	const body = (await res.json()) as {
		result: { content: Array<{ type: string; text: string }> };
	};
	return JSON.parse(body.result.content[0].text);
}

beforeAll(async () => {
	const ctx = await createTestApp();
	app = ctx.app;
	db = ctx.db;
	token = ctx.token;
	masterKeyManager = ctx.masterKeyManager;

	const typesRes = await app.request('/api/company-types', { headers: authHeader(token) });
	const typeId = (await typesRes.json()).data.find(
		(t: Record<string, unknown>) => t.name === 'Startup',
	).id;

	const companyRes = await app.request('/api/companies', {
		method: 'POST',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({ name: 'Hierarchy Test Co', template_id: typeId }),
	});
	companyId = (await companyRes.json()).data.id;

	const agentsRes = await app.request(`/api/companies/${companyId}/agents`, {
		headers: authHeader(token),
	});
	const agents = (await agentsRes.json()).data as Array<{ id: string; slug: string }>;
	const bySlug = (slug: string) => agents.find((a) => a.slug === slug);
	ceoId = bySlug(CEO_AGENT_SLUG)!.id;
	architectId = bySlug('architect')!.id;
	productLeadId = bySlug('product-lead')!.id;
	engineerId = bySlug('engineer')!.id;
	qaEngineerId = bySlug('qa-engineer')!.id;
	coachId = bySlug('coach')!.id;

	const projectRes = await app.request(`/api/companies/${companyId}/projects`, {
		method: 'POST',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({
			name: 'Hierarchy Project',
			description: 'Project for assignment hierarchy tests.',
		}),
	});
	projectId = (await projectRes.json()).data.id;
});

afterAll(async () => {
	await safeClose(db);
});

describe('assertSubordinateAssignee (unit)', () => {
	it('allows self-assignment', async () => {
		const result = await assertSubordinateAssignee(db, architectId, architectId);
		expect(result.ok).toBe(true);
	});

	it('allows direct subordinate (architect → engineer)', async () => {
		const result = await assertSubordinateAssignee(db, architectId, engineerId);
		expect(result.ok).toBe(true);
	});

	it('rejects peer (architect → product-lead)', async () => {
		const result = await assertSubordinateAssignee(db, architectId, productLeadId);
		expect(result.ok).toBe(false);
		if (result.ok) throw new Error('expected rejection');
		expect(result.message).toContain('@product-lead');
		expect(result.message).toContain('create_comment');
	});

	it('rejects manager (architect → ceo)', async () => {
		const result = await assertSubordinateAssignee(db, architectId, ceoId);
		expect(result.ok).toBe(false);
		if (result.ok) throw new Error('expected rejection');
		expect(result.message).toContain('@ceo');
	});

	it('rejects grand-subordinate (ceo → engineer, transitive only)', async () => {
		const result = await assertSubordinateAssignee(db, ceoId, engineerId);
		expect(result.ok).toBe(false);
		if (result.ok) throw new Error('expected rejection');
		expect(result.message).toContain('@engineer');
	});

	it('rejects siblings (engineer → qa-engineer)', async () => {
		const result = await assertSubordinateAssignee(db, engineerId, qaEngineerId);
		expect(result.ok).toBe(false);
		if (result.ok) throw new Error('expected rejection');
		expect(result.message).toContain('@qa-engineer');
	});

	it('rejects rootless agent (architect → coach, no reports_to)', async () => {
		const result = await assertSubordinateAssignee(db, architectId, coachId);
		expect(result.ok).toBe(false);
	});

	it('allows assignment to a non-agent member (rule applies only to agents)', async () => {
		const memberRes = await db.query<{ id: string }>(
			`INSERT INTO members (company_id, member_type, display_name)
			 VALUES ($1, 'user'::member_type, 'Test User') RETURNING id`,
			[companyId],
		);
		const userMemberId = memberRes.rows[0].id;
		const result = await assertSubordinateAssignee(db, architectId, userMemberId);
		expect(result.ok).toBe(true);
	});

	it('error message includes both target slug and create_comment guidance', () => {
		expect(assignmentHierarchyError('engineer')).toContain('@engineer');
		expect(assignmentHierarchyError('engineer')).toContain('create_comment');
		expect(assignmentHierarchyError('engineer')).toContain('direct subordinate');
	});
});

describe('MCP create_issue: agent assignment hierarchy', () => {
	it('agent can create_issue assigned to a direct subordinate', async () => {
		const { token: archToken } = await mintAgentToken(db, masterKeyManager, architectId, companyId);
		const result = await callTool(archToken, 'create_issue', {
			company_id: companyId,
			project_id: projectId,
			title: 'Architect → Engineer (subordinate)',
			assignee_id: engineerId,
		});
		expect(result.error).toBeUndefined();
		expect(result.assignee_id).toBe(engineerId);
	});

	it('agent can create_issue assigned to themselves', async () => {
		const { token: engToken } = await mintAgentToken(db, masterKeyManager, engineerId, companyId);
		const result = await callTool(engToken, 'create_issue', {
			company_id: companyId,
			project_id: projectId,
			title: 'Engineer self-assigning',
			assignee_id: engineerId,
		});
		expect(result.error).toBeUndefined();
		expect(result.assignee_id).toBe(engineerId);
	});

	it('agent cannot create_issue assigned to a peer', async () => {
		const { token: engToken } = await mintAgentToken(db, masterKeyManager, engineerId, companyId);
		const result = await callTool(engToken, 'create_issue', {
			company_id: companyId,
			project_id: projectId,
			title: 'Engineer → QA (peer, should fail)',
			assignee_id: qaEngineerId,
		});
		expect(result.error).toContain('@qa-engineer');
		expect(result.error).toContain('create_comment');
	});

	it('agent cannot create_issue assigned to their manager', async () => {
		const { token: archToken } = await mintAgentToken(db, masterKeyManager, architectId, companyId);
		const result = await callTool(archToken, 'create_issue', {
			company_id: companyId,
			project_id: projectId,
			title: 'Architect → CEO (manager, should fail)',
			assignee_id: ceoId,
		});
		expect(result.error).toContain('@ceo');
	});

	it('agent cannot create_issue assigned to a grand-subordinate', async () => {
		const { token: ceoToken } = await mintAgentToken(db, masterKeyManager, ceoId, companyId);
		const result = await callTool(ceoToken, 'create_issue', {
			company_id: companyId,
			project_id: projectId,
			title: 'CEO → Engineer (transitive subordinate, should fail)',
			assignee_id: engineerId,
		});
		expect(result.error).toContain('@engineer');
	});

	it('board user can create_issue assigned to anyone (rule does not apply to humans)', async () => {
		const result = await callTool(token, 'create_issue', {
			company_id: companyId,
			project_id: projectId,
			title: 'Board → Engineer (cross-hierarchy, allowed for humans)',
			assignee_id: engineerId,
		});
		expect(result.error).toBeUndefined();
		expect(result.assignee_id).toBe(engineerId);
	});

	it('agent fallback: comment with @-mention to request work from a peer', async () => {
		// Engineer creates a self-assigned ticket, then comments with @qa-engineer
		// to flag work for QA — this is the documented escape hatch.
		const { token: engToken } = await mintAgentToken(db, masterKeyManager, engineerId, companyId);
		const ticket = await callTool(engToken, 'create_issue', {
			company_id: companyId,
			project_id: projectId,
			title: 'Engineer ticket needing QA review',
			assignee_id: engineerId,
		});
		expect(ticket.error).toBeUndefined();

		const comment = await callTool(engToken, 'create_comment', {
			company_id: companyId,
			issue_id: ticket.id,
			content: 'Ready for review @qa-engineer — please pick this up when you have a slot.',
		});
		expect(comment.error).toBeUndefined();
		expect(comment.id).toBeDefined();
	});
});

describe('MCP update_issue: agent assignment hierarchy', () => {
	it('agent can reassign their own issue to a direct subordinate', async () => {
		const { token: archToken } = await mintAgentToken(db, masterKeyManager, architectId, companyId);
		const issue = await callTool(archToken, 'create_issue', {
			company_id: companyId,
			project_id: projectId,
			title: 'Architect drafts then hands off to engineer',
			assignee_id: architectId,
		});

		const result = await callTool(archToken, 'update_issue', {
			company_id: companyId,
			issue_id: issue.id,
			assignee_id: engineerId,
		});
		expect(result.error).toBeUndefined();
		expect(result.assignee_id).toBe(engineerId);
	});

	it('agent cannot reassign to a non-subordinate', async () => {
		const { token: engToken } = await mintAgentToken(db, masterKeyManager, engineerId, companyId);
		const issue = await callTool(engToken, 'create_issue', {
			company_id: companyId,
			project_id: projectId,
			title: 'Engineer self-assigned, will try to dump on QA',
			assignee_id: engineerId,
		});

		const result = await callTool(engToken, 'update_issue', {
			company_id: companyId,
			issue_id: issue.id,
			assignee_id: qaEngineerId,
		});
		expect(result.error).toContain('@qa-engineer');
		expect(result.error).toContain('create_comment');
	});

	it('agent passing the same assignee_id (no-op) is not blocked', async () => {
		const { token: engToken } = await mintAgentToken(db, masterKeyManager, engineerId, companyId);
		const issue = await callTool(engToken, 'create_issue', {
			company_id: companyId,
			project_id: projectId,
			title: 'Engineer no-op reassign',
			assignee_id: engineerId,
		});

		const result = await callTool(engToken, 'update_issue', {
			company_id: companyId,
			issue_id: issue.id,
			assignee_id: engineerId,
			progress_summary: 'still working',
		});
		expect(result.error).toBeUndefined();
	});

	it('board user can reassign across the hierarchy', async () => {
		// Board mints the ticket assigned to engineer, then reassigns it to
		// product-lead even though engineer→product-lead is not a hierarchy edge.
		const issue = await callTool(token, 'create_issue', {
			company_id: companyId,
			project_id: projectId,
			title: 'Board reassign across hierarchy',
			assignee_id: engineerId,
		});
		const result = await callTool(token, 'update_issue', {
			company_id: companyId,
			issue_id: issue.id,
			assignee_id: productLeadId,
		});
		expect(result.error).toBeUndefined();
		expect(result.assignee_id).toBe(productLeadId);
	});
});

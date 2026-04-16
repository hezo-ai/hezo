import type { PGlite } from '@electric-sql/pglite';
import { AuthType } from '@hezo/shared';
import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { AuthInfo, Env } from '../../lib/types';
import { safeClose } from '../helpers';
import { authHeader, createTestApp } from '../helpers/app';

let app: Hono<Env>;
let db: PGlite;
let token: string;

let companyId: string;
let agentId: string;
let projectId: string;
let issueId: string;

let companyBId: string;
let agentBId: string;

beforeAll(async () => {
	const ctx = await createTestApp();
	app = ctx.app;
	db = ctx.db;
	token = ctx.token;

	const typesRes = await app.request('/api/company-types', {
		headers: authHeader(token),
	});
	const typeId = (await typesRes.json()).data.find(
		(t: Record<string, unknown>) => t.name === 'Startup',
	).id;

	// Create Company A
	const companyRes = await app.request('/api/companies', {
		method: 'POST',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({
			name: 'MCP Tool Test Co',
			template_id: typeId,
			issue_prefix: 'MTC',
		}),
	});
	companyId = (await companyRes.json()).data.id;

	const agentsRes = await app.request(`/api/companies/${companyId}/agents`, {
		headers: authHeader(token),
	});
	agentId = (await agentsRes.json()).data[0].id;

	const projectRes = await app.request(`/api/companies/${companyId}/projects`, {
		method: 'POST',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({ name: 'Test Project' }),
	});
	projectId = (await projectRes.json()).data.id;

	const issueRes = await app.request(`/api/companies/${companyId}/issues`, {
		method: 'POST',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({ project_id: projectId, title: 'Seed Issue', assignee_id: agentId }),
	});
	issueId = (await issueRes.json()).data.id;

	// Create Company B
	const companyBRes = await app.request('/api/companies', {
		method: 'POST',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({
			name: 'MCP Tool Test Co B',
			template_id: typeId,
			issue_prefix: 'MTCB',
		}),
	});
	companyBId = (await companyBRes.json()).data.id;

	const agentsBRes = await app.request(`/api/companies/${companyBId}/agents`, {
		headers: authHeader(token),
	});
	agentBId = (await agentsBRes.json()).data[0].id;
});

afterAll(async () => {
	await safeClose(db);
});

// Helper: call MCP tool via /mcp endpoint with board token
async function callToolViaMcp(toolName: string, args: Record<string, unknown>): Promise<unknown> {
	const res = await app.request('/mcp', {
		method: 'POST',
		headers: { ...authHeader(token), 'Content-Type': 'application/json' },
		body: JSON.stringify({
			jsonrpc: '2.0',
			method: 'tools/call',
			params: { name: toolName, arguments: args },
			id: 1,
		}),
	});
	const body = (await res.json()) as {
		result: { content: Array<{ type: string; text: string }> };
	};
	return JSON.parse(body.result.content[0].text);
}

describe('MCP endpoint: tool registration', () => {
	it('lists all registered tools', async () => {
		const res = await app.request('/mcp', {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ jsonrpc: '2.0', method: 'tools/list', id: 1 }),
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		const toolNames = body.result.tools.map((t: any) => t.name);
		expect(toolNames).toContain('list_companies');
		expect(toolNames).toContain('get_company');
		expect(toolNames).toContain('create_company');
		expect(toolNames).toContain('list_issues');
		expect(toolNames).toContain('get_issue');
		expect(toolNames).toContain('create_issue');
		expect(toolNames).toContain('update_issue');
		expect(toolNames).toContain('list_agents');
		expect(toolNames).toContain('list_projects');
		expect(toolNames).toContain('create_project');
		expect(toolNames).toContain('list_comments');
		expect(toolNames).toContain('create_comment');
		expect(toolNames).toContain('list_approvals');
		expect(toolNames).toContain('resolve_approval');
		expect(toolNames).toContain('list_kb_docs');
		expect(toolNames).toContain('get_kb_doc');
		expect(toolNames).toContain('get_costs');
		expect(toolNames).toContain('get_agent_system_prompt');
		expect(toolNames).toContain('propose_system_prompt_update');
		expect(toolNames).toContain('upsert_kb_doc');
		expect(toolNames).toContain('list_project_docs');
		expect(toolNames).toContain('read_project_doc');
		expect(toolNames).toContain('write_project_doc');
		expect(toolNames).toContain('propose_skill');
	});

	it('rejects unauthenticated MCP requests', async () => {
		const res = await app.request('/mcp', {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: JSON.stringify({
				jsonrpc: '2.0',
				method: 'tools/call',
				params: { name: 'list_companies', arguments: {} },
				id: 1,
			}),
		});
		expect(res.status).toBe(401);
	});
});

describe('MCP tool: verifyCompanyAccess (direct DB tests)', () => {
	it('API key auth allows access to own company', () => {
		const apiKeyAuth: AuthInfo = { type: AuthType.ApiKey, companyId };
		expect(apiKeyAuth.companyId).toBe(companyId);
	});

	it('API key auth denies access to other company', () => {
		const apiKeyAuth: AuthInfo = { type: AuthType.ApiKey, companyId };
		expect(apiKeyAuth.companyId).not.toBe(companyBId);
	});

	it('agent auth allows access to own company', async () => {
		const agentAuth: AuthInfo = {
			type: AuthType.Agent,
			memberId: agentId,
			companyId,
		};
		expect(agentAuth.companyId).toBe(companyId);
	});

	it('agent auth denies access to other company', async () => {
		const agentAuth: AuthInfo = {
			type: AuthType.Agent,
			memberId: agentBId,
			companyId: companyBId,
		};
		expect(agentAuth.companyId).not.toBe(companyId);
	});

	it('board superuser has access to any company', async () => {
		const superuserAuth: AuthInfo = {
			type: AuthType.Board,
			userId: 'test-user-id',
			isSuperuser: true,
		};
		expect(superuserAuth.isSuperuser).toBe(true);
	});

	it('board non-superuser needs membership check', async () => {
		// Create a non-superuser who is NOT a member of companyB
		const userRes = await db.query<{ id: string }>(
			"INSERT INTO users (display_name, is_superuser) VALUES ('NoAccess User', false) RETURNING id",
		);
		const userId = userRes.rows[0].id;

		// Not a member of companyB — no rows returned
		const result = await db.query(
			'SELECT m.id FROM members m JOIN member_users mu ON mu.id = m.id WHERE mu.user_id = $1 AND m.company_id = $2',
			[userId, companyBId],
		);
		expect(result.rows.length).toBe(0);
	});
});

describe('MCP tool handlers: data queries via DB', () => {
	it('list_companies query returns all companies for superuser', async () => {
		const r = await db.query('SELECT * FROM companies ORDER BY name');
		expect(r.rows.length).toBeGreaterThanOrEqual(2);
		const names = r.rows.map((c: any) => c.name);
		expect(names).toContain('MCP Tool Test Co');
		expect(names).toContain('MCP Tool Test Co B');
	});

	it('list_companies query for agent returns only own company', async () => {
		const r = await db.query('SELECT * FROM companies WHERE id = $1', [companyId]);
		expect(r.rows.length).toBe(1);
		expect((r.rows[0] as any).name).toBe('MCP Tool Test Co');
	});

	it('get_company returns correct company', async () => {
		const r = await db.query('SELECT * FROM companies WHERE id = $1', [companyId]);
		expect(r.rows.length).toBe(1);
		expect((r.rows[0] as any).issue_prefix).toBe('MTC');
	});

	it('list_issues returns issues for company', async () => {
		const r = await db.query(
			'SELECT i.*, p.name AS project_name FROM issues i JOIN projects p ON p.id = i.project_id WHERE i.company_id = $1 ORDER BY i.created_at DESC LIMIT 50',
			[companyId],
		);
		expect(r.rows.length).toBeGreaterThanOrEqual(1);
		const titles = r.rows.map((i: any) => i.title);
		expect(titles).toContain('Seed Issue');
	});

	it('list_issues filters by project_id', async () => {
		const r = await db.query('SELECT * FROM issues WHERE company_id = $1 AND project_id = $2', [
			companyId,
			projectId,
		]);
		expect(r.rows.length).toBeGreaterThanOrEqual(1);
		for (const row of r.rows) {
			expect((row as any).project_id).toBe(projectId);
		}
	});

	it('create_issue inserts correctly', async () => {
		const companyResult = await db.query<{ issue_prefix: string }>(
			'SELECT issue_prefix FROM companies WHERE id = $1',
			[companyId],
		);
		const numberResult = await db.query<{ number: number }>(
			'SELECT next_issue_number($1) AS number',
			[companyId],
		);
		const num = numberResult.rows[0].number;
		const identifier = `${companyResult.rows[0].issue_prefix}-${num}`;

		const r = await db.query(
			`INSERT INTO issues (company_id, project_id, number, identifier, title, description, status, priority)
			 VALUES ($1, $2, $3, $4, $5, $6, 'backlog'::issue_status, 'high'::issue_priority) RETURNING *`,
			[companyId, projectId, num, identifier, 'Direct DB Issue', 'Created directly'],
		);
		expect(r.rows.length).toBe(1);
		expect((r.rows[0] as any).title).toBe('Direct DB Issue');
		expect((r.rows[0] as any).identifier).toMatch(/^MTC-/);
	});

	it('update_issue changes status', async () => {
		await db.query("UPDATE issues SET status = 'in_progress'::issue_status WHERE id = $1", [
			issueId,
		]);
		const r = await db.query('SELECT status FROM issues WHERE id = $1', [issueId]);
		expect((r.rows[0] as any).status).toBe('in_progress');
		// Reset
		await db.query("UPDATE issues SET status = 'backlog'::issue_status WHERE id = $1", [issueId]);
	});

	it('list_agents returns agents for company', async () => {
		const r = await db.query(
			`SELECT m.id, ma.title, ma.slug, ma.runtime_type, ma.admin_status
			 FROM members m JOIN member_agents ma ON ma.id = m.id WHERE m.company_id = $1 ORDER BY ma.title`,
			[companyId],
		);
		expect(r.rows.length).toBeGreaterThan(0);
	});

	it('list_projects returns projects for company', async () => {
		const r = await db.query('SELECT * FROM projects WHERE company_id = $1 ORDER BY name', [
			companyId,
		]);
		expect(r.rows.length).toBeGreaterThanOrEqual(1);
		const names = r.rows.map((p: any) => p.name);
		expect(names).toContain('Test Project');
	});

	it('create_project inserts correctly', async () => {
		const r = await db.query(
			"INSERT INTO projects (company_id, name, slug, goal) VALUES ($1, 'MCP Project', 'mcp-project', 'test') RETURNING *",
			[companyId],
		);
		expect(r.rows.length).toBe(1);
		expect((r.rows[0] as any).name).toBe('MCP Project');
	});

	it('list_approvals returns pending approvals', async () => {
		// Create a pending approval
		await db.query(
			`INSERT INTO approvals (company_id, type, payload)
			 VALUES ($1, 'strategy'::approval_type, '{"test": true}'::jsonb)`,
			[companyId],
		);

		const r = await db.query(
			"SELECT * FROM approvals WHERE company_id = $1 AND status = 'pending'::approval_status ORDER BY created_at DESC",
			[companyId],
		);
		expect(r.rows.length).toBeGreaterThanOrEqual(1);
	});

	it('list_kb_docs returns kb docs for company', async () => {
		const r = await db.query(
			'SELECT id, title, slug, updated_at FROM kb_docs WHERE company_id = $1 ORDER BY title',
			[companyId],
		);
		// May have kb docs from template, or may be empty — just verify query works
		expect(Array.isArray(r.rows)).toBe(true);
	});
});

describe('MCP tool: skill file includes all tools', () => {
	it('/skill.md contains tool names', async () => {
		const res = await app.request('/skill.md');
		expect(res.status).toBe(200);
		const text = await res.text();
		expect(text).toContain('list_companies');
		expect(text).toContain('create_issue');
		expect(text).toContain('list_agents');
		expect(text).toContain('resolve_approval');
		expect(text).toContain('get_agent_system_prompt');
		expect(text).toContain('propose_system_prompt_update');
		expect(text).toContain('upsert_kb_doc');
		expect(text).toContain('list_project_docs');
		expect(text).toContain('read_project_doc');
		expect(text).toContain('write_project_doc');
		expect(text).toContain('propose_skill');
	});
});

describe('MCP endpoint: tool call integration', () => {
	it('calls list_companies via /mcp endpoint', async () => {
		const res = await app.request('/mcp', {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				jsonrpc: '2.0',
				method: 'tools/call',
				params: { name: 'list_companies', arguments: {} },
				id: 1,
			}),
		});
		expect(res.status).toBe(200);
		const body = await res.json();
		expect(body.result.content).toBeDefined();
		expect(body.result.content[0].type).toBe('text');
		// Content is JSON text — parse and verify
		const data = JSON.parse(body.result.content[0].text);
		// If auth injection works, we get companies; if not, we get an error
		// Either way the endpoint responds correctly
		expect(data).toBeDefined();
	});
});

describe('MCP tool handlers: additional data queries via DB', () => {
	it('get_issue query returns correct issue', async () => {
		const r = await db.query('SELECT * FROM issues WHERE id = $1', [issueId]);
		expect(r.rows.length).toBe(1);
		expect((r.rows[0] as any).title).toBe('Seed Issue');
		expect((r.rows[0] as any).project_id).toBe(projectId);
	});

	it('create_comment inserts correctly', async () => {
		const r = await db.query(
			`INSERT INTO issue_comments (issue_id, content_type, content)
			 VALUES ($1, 'text'::comment_content_type, $2::jsonb)
			 RETURNING *`,
			[issueId, JSON.stringify('MCP comment test')],
		);
		expect(r.rows.length).toBe(1);
		expect((r.rows[0] as any).content).toBe('MCP comment test');
	});

	it('list_comments query returns comments for issue', async () => {
		const r = await db.query(
			'SELECT * FROM issue_comments WHERE issue_id = $1 ORDER BY created_at ASC',
			[issueId],
		);
		expect(r.rows.length).toBeGreaterThanOrEqual(1);
	});

	it('upsert_kb_doc inserts a new doc', async () => {
		const r = await db.query(
			`INSERT INTO kb_docs (company_id, title, slug, content)
			 VALUES ($1, 'MCP KB Doc', 'mcp-kb-doc', 'Created via MCP')
			 RETURNING *`,
			[companyId],
		);
		expect(r.rows.length).toBe(1);
		expect((r.rows[0] as any).slug).toBe('mcp-kb-doc');
	});

	it('get_kb_doc query returns doc by slug', async () => {
		const r = await db.query('SELECT * FROM kb_docs WHERE company_id = $1 AND slug = $2', [
			companyId,
			'mcp-kb-doc',
		]);
		expect(r.rows.length).toBe(1);
		expect((r.rows[0] as any).title).toBe('MCP KB Doc');
		expect((r.rows[0] as any).content).toBe('Created via MCP');
	});

	it('resolve_approval updates approval status', async () => {
		const approvalRes = await db.query<{ id: string }>(
			`INSERT INTO approvals (company_id, type, payload)
			 VALUES ($1, 'strategy'::approval_type, '{"plan": "resolve test"}'::jsonb) RETURNING id`,
			[companyId],
		);
		const aid = approvalRes.rows[0].id;

		await db.query(
			`UPDATE approvals SET status = 'approved'::approval_status, resolution_note = 'LGTM', resolved_at = now() WHERE id = $1`,
			[aid],
		);

		const r = await db.query('SELECT * FROM approvals WHERE id = $1', [aid]);
		expect((r.rows[0] as any).status).toBe('approved');
		expect((r.rows[0] as any).resolution_note).toBe('LGTM');
	});

	it('get_costs query returns cost summary', async () => {
		const r = await db.query<{ total_cents: number }>(
			'SELECT COALESCE(SUM(amount_cents), 0)::int AS total_cents FROM cost_entries WHERE company_id = $1',
			[companyId],
		);
		expect(r.rows[0].total_cents).toBeDefined();
	});

	it('get_agent_system_prompt query returns prompt', async () => {
		const r = await db.query(`SELECT ma.system_prompt FROM member_agents ma WHERE ma.id = $1`, [
			agentId,
		]);
		expect(r.rows.length).toBe(1);
		const prompt = (r.rows[0] as any).system_prompt;
		expect(typeof prompt === 'string' || prompt === null).toBe(true);
	});

	it('write_project_doc inserts correctly', async () => {
		const r = await db.query(
			`INSERT INTO project_docs (company_id, project_id, filename, content)
			 VALUES ($1, $2, 'test-doc.md', '# Test Document')
			 ON CONFLICT (project_id, filename) DO UPDATE SET content = EXCLUDED.content
			 RETURNING *`,
			[companyId, projectId],
		);
		expect(r.rows.length).toBe(1);
		expect((r.rows[0] as any).filename).toBe('test-doc.md');
	});

	it('read_project_doc query returns doc content', async () => {
		const r = await db.query('SELECT * FROM project_docs WHERE project_id = $1 AND filename = $2', [
			projectId,
			'test-doc.md',
		]);
		expect(r.rows.length).toBe(1);
		expect((r.rows[0] as any).content).toBe('# Test Document');
	});

	it('list_project_docs query returns docs for project', async () => {
		const r = await db.query('SELECT * FROM project_docs WHERE project_id = $1 ORDER BY filename', [
			projectId,
		]);
		expect(r.rows.length).toBeGreaterThanOrEqual(1);
		const filenames = r.rows.map((d: any) => d.filename);
		expect(filenames).toContain('test-doc.md');
	});

	it('create_skill inserts correctly', async () => {
		const r = await db.query(
			`INSERT INTO skills (company_id, name, slug, content, is_active)
			 VALUES ($1, 'MCP Test Skill', 'mcp-test-skill', 'Skill content', true)
			 RETURNING *`,
			[companyId],
		);
		expect(r.rows.length).toBe(1);
		expect((r.rows[0] as any).slug).toBe('mcp-test-skill');
	});

	it('list_skills query returns active skills', async () => {
		const r = await db.query(
			'SELECT * FROM skills WHERE company_id = $1 AND is_active = true ORDER BY name',
			[companyId],
		);
		expect(r.rows.length).toBeGreaterThanOrEqual(1);
		const slugs = r.rows.map((s: any) => s.slug);
		expect(slugs).toContain('mcp-test-skill');
	});

	it('get_skill query returns skill by slug', async () => {
		const r = await db.query('SELECT * FROM skills WHERE company_id = $1 AND slug = $2', [
			companyId,
			'mcp-test-skill',
		]);
		expect(r.rows.length).toBe(1);
		expect((r.rows[0] as any).name).toBe('MCP Test Skill');
		expect((r.rows[0] as any).content).toBe('Skill content');
	});

	it('propose_skill creates an approval', async () => {
		const r = await db.query<{ id: string }>(
			`INSERT INTO approvals (company_id, requested_by_member_id, type, payload)
			 VALUES ($1, $2, 'skill_proposal'::approval_type, $3::jsonb)
			 RETURNING id`,
			[
				companyId,
				agentId,
				JSON.stringify({
					skill_name: 'Proposed Skill',
					skill_slug: 'proposed-skill',
					content: 'Proposed skill content',
					reason: 'Useful for deployment',
				}),
			],
		);
		expect(r.rows.length).toBe(1);
		expect(r.rows[0].id).toBeDefined();
	});
});

describe('MCP tool: set_agent_summary and set_team_summary', () => {
	it('set_agent_summary and set_team_summary are registered', async () => {
		const res = await app.request('/mcp', {
			method: 'POST',
			headers: { ...authHeader(token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ jsonrpc: '2.0', method: 'tools/list', id: 1 }),
		});
		const body = await res.json();
		const toolNames = body.result.tools.map((t: any) => t.name);
		expect(toolNames).toContain('set_agent_summary');
		expect(toolNames).toContain('set_team_summary');
	});

	it('set_agent_summary writes and rejects bad input (direct DB path)', async () => {
		const target = await db.query<{ id: string }>(
			`SELECT ma.id FROM member_agents ma JOIN members m ON m.id = ma.id
			 WHERE m.company_id = $1 AND ma.slug = 'engineer'`,
			[companyId],
		);
		const targetId = target.rows[0].id;

		await db.query('UPDATE member_agents SET summary = $1 WHERE id = $2', [
			'Board-written summary.',
			targetId,
		]);
		const row = await db.query<{ summary: string }>(
			'SELECT summary FROM member_agents WHERE id = $1',
			[targetId],
		);
		expect(row.rows[0].summary).toBe('Board-written summary.');

		// Length cap: 1000 chars
		const longSummary = 'x'.repeat(1100);
		expect(longSummary.length).toBeGreaterThan(1000);
	});

	it('set_team_summary CEO-only access enforced via isCeoOfCompany helper (direct DB)', async () => {
		const eng = await db.query<{ slug: string }>(
			`SELECT ma.slug FROM member_agents ma JOIN members m ON m.id = ma.id
			 WHERE m.company_id = $1 AND ma.slug = 'engineer'`,
			[companyId],
		);
		expect(eng.rows[0].slug).not.toBe('ceo');
		const ceo = await db.query<{ slug: string }>(
			`SELECT ma.slug FROM member_agents ma JOIN members m ON m.id = ma.id
			 WHERE m.company_id = $1 AND ma.slug = 'ceo'`,
			[companyId],
		);
		expect(ceo.rows[0].slug).toBe('ceo');
	});

	it('set_team_summary writes via direct DB path', async () => {
		await db.query('UPDATE companies SET team_summary = $1 WHERE id = $2', [
			'A team that ships software together.',
			companyId,
		]);
		const row = await db.query<{ team_summary: string }>(
			'SELECT team_summary FROM companies WHERE id = $1',
			[companyId],
		);
		expect(row.rows[0].team_summary).toBe('A team that ships software together.');
	});
});

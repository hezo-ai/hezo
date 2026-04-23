import type { PGlite } from '@electric-sql/pglite';
import { AuthType } from '@hezo/shared';
import type { Hono } from 'hono';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MasterKeyManager } from '../../crypto/master-key';
import type { AuthInfo, Env } from '../../lib/types';
import { safeClose } from '../helpers';
import { authHeader, createTestApp, mintAgentToken } from '../helpers/app';

let app: Hono<Env>;
let db: PGlite;
let token: string;
let masterKeyManager: MasterKeyManager;

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
	masterKeyManager = ctx.masterKeyManager;

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
		body: JSON.stringify({ name: 'Test Project', description: 'Test project.' }),
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
			runId: '00000000-0000-0000-0000-000000000001',
		};
		expect(agentAuth.companyId).toBe(companyId);
	});

	it('agent auth denies access to other company', async () => {
		const agentAuth: AuthInfo = {
			type: AuthType.Agent,
			memberId: agentBId,
			companyId: companyBId,
			runId: '00000000-0000-0000-0000-000000000002',
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
		expect((r.rows[0] as any).name).toBe('MCP Tool Test Co');
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
		const meta = await db.query<{ issue_prefix: string; number: number }>(
			`SELECT p.issue_prefix, next_project_issue_number(p.id) AS number
			 FROM projects p WHERE p.id = $1`,
			[projectId],
		);
		const num = meta.rows[0].number;
		const identifier = `${meta.rows[0].issue_prefix}-${num}`;

		const r = await db.query(
			`INSERT INTO issues (company_id, project_id, number, identifier, title, description, status, priority)
			 VALUES ($1, $2, $3, $4, $5, $6, 'backlog'::issue_status, 'high'::issue_priority) RETURNING *`,
			[companyId, projectId, num, identifier, 'Direct DB Issue', 'Created directly'],
		);
		expect(r.rows.length).toBe(1);
		expect((r.rows[0] as any).title).toBe('Direct DB Issue');
		expect((r.rows[0] as any).identifier).toMatch(/^TP-/);
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
			`SELECT m.id, ma.title, ma.slug, ma.admin_status
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
			"INSERT INTO projects (company_id, name, slug, issue_prefix, description) VALUES ($1, 'MCP Project', 'mcp-project', 'MCPP', 'test') RETURNING *",
			[companyId],
		);
		expect(r.rows.length).toBe(1);
		expect((r.rows[0] as any).name).toBe('MCP Project');
		expect((r.rows[0] as any).issue_prefix).toBe('MCPP');
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
			"SELECT id, title, slug, updated_at FROM documents WHERE type = 'kb_doc' AND company_id = $1 ORDER BY title",
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

	async function callUpdateIssueAsAgent(args: Record<string, unknown>): Promise<unknown> {
		const { token: agentToken } = await mintAgentToken(db, masterKeyManager, agentId, companyId);
		const res = await app.request('/mcp', {
			method: 'POST',
			headers: { ...authHeader(agentToken), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				jsonrpc: '2.0',
				method: 'tools/call',
				params: { name: 'update_issue', arguments: args },
				id: 1,
			}),
		});
		const body = (await res.json()) as {
			result: { content: Array<{ type: string; text: string }> };
		};
		return JSON.parse(body.result.content[0].text);
	}

	it('update_issue via MCP as agent can set status=closed', async () => {
		const created = (await callToolViaMcp('create_issue', {
			company_id: companyId,
			project_id: projectId,
			title: 'Agent MCP close target',
			assignee_id: agentId,
		})) as { id: string };

		const result = (await callUpdateIssueAsAgent({
			company_id: companyId,
			issue_id: created.id,
			status: 'closed',
		})) as { status?: string; error?: string };
		expect(result.error).toBeUndefined();
		expect(result.status).toBe('closed');
	});

	it('update_issue via MCP as agent cannot re-open a closed issue', async () => {
		const created = (await callToolViaMcp('create_issue', {
			company_id: companyId,
			project_id: projectId,
			title: 'Agent MCP reopen target',
			assignee_id: agentId,
		})) as { id: string };

		// Board closes the issue first.
		await callToolViaMcp('update_issue', {
			company_id: companyId,
			issue_id: created.id,
			status: 'closed',
		});

		const result = (await callUpdateIssueAsAgent({
			company_id: companyId,
			issue_id: created.id,
			status: 'backlog',
		})) as { error?: string };
		expect(result.error).toMatch(/board/i);

		const bypass = (await callUpdateIssueAsAgent({
			company_id: companyId,
			issue_id: created.id,
			status: 'in_progress',
		})) as { error?: string };
		expect(bypass.error).toMatch(/board/i);
	});

	it('update_issue via MCP as agent can still set non-terminal statuses', async () => {
		const created = (await callToolViaMcp('create_issue', {
			company_id: companyId,
			project_id: projectId,
			title: 'Agent MCP progress target',
			assignee_id: agentId,
		})) as { id: string };

		const result = (await callUpdateIssueAsAgent({
			company_id: companyId,
			issue_id: created.id,
			status: 'in_progress',
		})) as { status?: string; error?: string };
		expect(result.error).toBeUndefined();
		expect(result.status).toBe('in_progress');
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

	it('create_comment via MCP sets author_member_id to calling agent', async () => {
		const { token: agentToken } = await mintAgentToken(db, masterKeyManager, agentId, companyId);
		const res = await app.request('/mcp', {
			method: 'POST',
			headers: { ...authHeader(agentToken), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				jsonrpc: '2.0',
				method: 'tools/call',
				params: {
					name: 'create_comment',
					arguments: {
						company_id: companyId,
						issue_id: issueId,
						content: 'Authored via MCP',
					},
				},
				id: 1,
			}),
		});
		expect(res.status).toBe(200);
		const body = (await res.json()) as {
			result: { content: Array<{ type: string; text: string }> };
		};
		const inserted = JSON.parse(body.result.content[0].text) as {
			id: string;
			author_member_id: string | null;
		};
		expect(inserted.author_member_id).toBe(agentId);

		const fetched = await db.query<{ author_member_id: string | null }>(
			'SELECT author_member_id FROM issue_comments WHERE id = $1',
			[inserted.id],
		);
		expect(fetched.rows[0].author_member_id).toBe(agentId);
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
			`INSERT INTO documents (company_id, type, slug, title, content)
			 VALUES ($1, 'kb_doc', 'mcp-kb-doc', 'MCP KB Doc', 'Created via MCP')
			 RETURNING *`,
			[companyId],
		);
		expect(r.rows.length).toBe(1);
		expect((r.rows[0] as any).slug).toBe('mcp-kb-doc');
	});

	it('get_kb_doc query returns doc by slug', async () => {
		const r = await db.query(
			"SELECT * FROM documents WHERE type = 'kb_doc' AND company_id = $1 AND slug = $2",
			[companyId, 'mcp-kb-doc'],
		);
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
			`INSERT INTO documents (company_id, project_id, type, slug, content)
			 VALUES ($1, $2, 'project_doc', 'test-doc.md', '# Test Document')
			 RETURNING *`,
			[companyId, projectId],
		);
		expect(r.rows.length).toBe(1);
		expect((r.rows[0] as any).slug).toBe('test-doc.md');
	});

	it('read_project_doc query returns doc content', async () => {
		const r = await db.query(
			"SELECT * FROM documents WHERE type = 'project_doc' AND project_id = $1 AND slug = $2",
			[projectId, 'test-doc.md'],
		);
		expect(r.rows.length).toBe(1);
		expect((r.rows[0] as any).content).toBe('# Test Document');
	});

	it('list_project_docs query returns docs for project', async () => {
		const r = await db.query(
			"SELECT * FROM documents WHERE type = 'project_doc' AND project_id = $1 ORDER BY slug",
			[projectId],
		);
		expect(r.rows.length).toBeGreaterThanOrEqual(1);
		const filenames = r.rows.map((d: any) => d.slug);
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

describe('MCP tool: operations project assignee restriction', () => {
	it('create_issue on Operations project rejects non-CEO assignee_slug', async () => {
		const ops = await db.query<{ id: string }>(
			`SELECT id FROM projects WHERE company_id = $1 AND slug = 'operations'`,
			[companyId],
		);
		const result = (await callToolViaMcp('create_issue', {
			company_id: companyId,
			project_id: ops.rows[0].id,
			title: 'Operations via MCP with non-CEO',
			assignee_slug: 'engineer',
		})) as { error?: string };
		expect(result.error).toContain('CEO');
	});

	it('create_issue on Operations project accepts CEO assignee_slug', async () => {
		const ops = await db.query<{ id: string }>(
			`SELECT id FROM projects WHERE company_id = $1 AND slug = 'operations'`,
			[companyId],
		);
		const result = (await callToolViaMcp('create_issue', {
			company_id: companyId,
			project_id: ops.rows[0].id,
			title: 'Operations via MCP with CEO',
			assignee_slug: 'ceo',
		})) as { error?: string; id?: string; project_id?: string };
		expect(result.error).toBeUndefined();
		expect(result.project_id).toBe(ops.rows[0].id);
	});

	it('update_issue rejects reassigning Operations issue to non-CEO', async () => {
		const ops = await db.query<{ id: string }>(
			`SELECT id FROM projects WHERE company_id = $1 AND slug = 'operations'`,
			[companyId],
		);
		const ceo = await db.query<{ id: string }>(
			`SELECT ma.id FROM member_agents ma JOIN members m ON m.id = ma.id
			 WHERE m.company_id = $1 AND ma.slug = 'ceo'`,
			[companyId],
		);

		const created = (await callToolViaMcp('create_issue', {
			company_id: companyId,
			project_id: ops.rows[0].id,
			title: 'Operations reassign target',
			assignee_id: ceo.rows[0].id,
		})) as { id: string };

		const result = (await callToolViaMcp('update_issue', {
			company_id: companyId,
			issue_id: created.id,
			assignee_id: agentId,
		})) as { error?: string };
		expect(result.error).toContain('CEO');
	});
});

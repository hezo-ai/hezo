import type { PGlite } from '@electric-sql/pglite';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

export interface ToolDef {
	name: string;
	description: string;
	schema: Record<string, unknown>;
}

const registeredTools: ToolDef[] = [];

function tool(
	server: McpServer,
	name: string,
	description: string,
	schema: Record<string, z.ZodType>,
	handler: (args: Record<string, unknown>, db: PGlite) => Promise<unknown>,
	db: PGlite,
) {
	registeredTools.push({
		name,
		description,
		schema: Object.fromEntries(Object.entries(schema).map(([k, v]) => [k, v.description ?? k])),
	});
	server.tool(name, description, schema, async (args: Record<string, unknown>) => {
		const result = await handler(args, db);
		return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
	});
}

export function registerTools(server: McpServer, db: PGlite): ToolDef[] {
	registeredTools.length = 0;

	// Companies
	tool(
		server,
		'list_companies',
		'List all companies',
		{},
		async (_args, db) => {
			const r = await db.query('SELECT * FROM companies ORDER BY name');
			return r.rows;
		},
		db,
	);

	tool(
		server,
		'get_company',
		'Get a company by ID',
		{
			company_id: z.string().describe('Company ID'),
		},
		async (args, db) => {
			const r = await db.query('SELECT * FROM companies WHERE id = $1', [args.company_id]);
			return r.rows[0] ?? null;
		},
		db,
	);

	tool(
		server,
		'create_company',
		'Create a new company',
		{
			name: z.string().describe('Company name'),
			issue_prefix: z.string().describe('Issue prefix (e.g. ACME)'),
			description: z.string().optional().describe('Company description'),
		},
		async (args, db) => {
			const slug = (args.name as string)
				.toLowerCase()
				.replace(/[^a-z0-9]+/g, '-')
				.replace(/^-|-$/g, '');
			const r = await db.query(
				`INSERT INTO companies (name, slug, issue_prefix, description) VALUES ($1, $2, $3, $4) RETURNING *`,
				[args.name, slug, args.issue_prefix, args.description ?? ''],
			);
			return r.rows[0];
		},
		db,
	);

	// Issues
	tool(
		server,
		'list_issues',
		'List issues for a company',
		{
			company_id: z.string().describe('Company ID'),
			project_id: z.string().optional().describe('Filter by project ID'),
			status: z.string().optional().describe('Filter by status (comma-separated)'),
		},
		async (args, db) => {
			const conditions = ['i.company_id = $1'];
			const params: unknown[] = [args.company_id];
			let idx = 2;
			if (args.project_id) {
				conditions.push(`i.project_id = $${idx}`);
				params.push(args.project_id);
				idx++;
			}
			if (args.status) {
				const statuses = (args.status as string).split(',');
				const ph = statuses.map((_, i) => `$${idx + i}::issue_status`).join(', ');
				conditions.push(`i.status IN (${ph})`);
				params.push(...statuses);
			}
			const r = await db.query(
				`SELECT i.*, p.name AS project_name FROM issues i JOIN projects p ON p.id = i.project_id WHERE ${conditions.join(' AND ')} ORDER BY i.created_at DESC LIMIT 50`,
				params,
			);
			return r.rows;
		},
		db,
	);

	tool(
		server,
		'get_issue',
		'Get issue details',
		{
			company_id: z.string().describe('Company ID'),
			issue_id: z.string().describe('Issue ID'),
		},
		async (args, db) => {
			const r = await db.query('SELECT * FROM issues WHERE id = $1 AND company_id = $2', [
				args.issue_id,
				args.company_id,
			]);
			return r.rows[0] ?? null;
		},
		db,
	);

	tool(
		server,
		'create_issue',
		'Create a new issue',
		{
			company_id: z.string().describe('Company ID'),
			project_id: z.string().describe('Project ID'),
			title: z.string().describe('Issue title'),
			description: z.string().optional().describe('Issue description'),
			priority: z.string().optional().describe('Priority: low, medium, high, urgent'),
			assignee_id: z.string().optional().describe('Assignee member ID'),
		},
		async (args, db) => {
			const companyResult = await db.query<{ issue_prefix: string }>(
				'SELECT issue_prefix FROM companies WHERE id = $1',
				[args.company_id],
			);
			if (companyResult.rows.length === 0) throw new Error('Company not found');
			const numberResult = await db.query<{ number: number }>(
				'SELECT next_issue_number($1) AS number',
				[args.company_id],
			);
			const num = numberResult.rows[0].number;
			const identifier = `${companyResult.rows[0].issue_prefix}-${num}`;
			const r = await db.query(
				`INSERT INTO issues (company_id, project_id, assignee_id, number, identifier, title, description, status, priority)
			 VALUES ($1, $2, $3, $4, $5, $6, $7, 'backlog', $8::issue_priority) RETURNING *`,
				[
					args.company_id,
					args.project_id,
					args.assignee_id ?? null,
					num,
					identifier,
					args.title,
					args.description ?? '',
					args.priority ?? 'medium',
				],
			);
			return r.rows[0];
		},
		db,
	);

	tool(
		server,
		'update_issue',
		'Update an issue',
		{
			company_id: z.string().describe('Company ID'),
			issue_id: z.string().describe('Issue ID'),
			title: z.string().optional().describe('New title'),
			description: z.string().optional().describe('New description'),
			status: z.string().optional().describe('New status'),
			priority: z.string().optional().describe('New priority'),
			assignee_id: z.string().optional().describe('New assignee ID (null to unassign)'),
		},
		async (args, db) => {
			const sets: string[] = [];
			const params: unknown[] = [];
			let idx = 1;
			for (const [key, val] of Object.entries(args)) {
				if (['company_id', 'issue_id'].includes(key) || val === undefined) continue;
				const col =
					key === 'status'
						? `status = $${idx}::issue_status`
						: key === 'priority'
							? `priority = $${idx}::issue_priority`
							: `${key} = $${idx}`;
				sets.push(col);
				params.push(val);
				idx++;
			}
			if (sets.length === 0) return { unchanged: true };
			params.push(args.issue_id, args.company_id);
			const r = await db.query(
				`UPDATE issues SET ${sets.join(', ')} WHERE id = $${idx} AND company_id = $${idx + 1} RETURNING *`,
				params,
			);
			return r.rows[0] ?? null;
		},
		db,
	);

	// Agents
	tool(
		server,
		'list_agents',
		'List agents for a company',
		{
			company_id: z.string().describe('Company ID'),
		},
		async (args, db) => {
			const r = await db.query(
				`SELECT m.id, ma.title, ma.slug, ma.status, ma.runtime_type, ma.monthly_budget_cents, ma.budget_used_cents
			 FROM members m JOIN member_agents ma ON ma.id = m.id WHERE m.company_id = $1 ORDER BY ma.title`,
				[args.company_id],
			);
			return r.rows;
		},
		db,
	);

	// Projects
	tool(
		server,
		'list_projects',
		'List projects for a company',
		{
			company_id: z.string().describe('Company ID'),
		},
		async (args, db) => {
			const r = await db.query('SELECT * FROM projects WHERE company_id = $1 ORDER BY name', [
				args.company_id,
			]);
			return r.rows;
		},
		db,
	);

	tool(
		server,
		'create_project',
		'Create a new project',
		{
			company_id: z.string().describe('Company ID'),
			name: z.string().describe('Project name'),
			goal: z.string().optional().describe('Project goal'),
		},
		async (args, db) => {
			const slug = (args.name as string)
				.toLowerCase()
				.replace(/[^a-z0-9]+/g, '-')
				.replace(/^-|-$/g, '');
			const r = await db.query(
				`INSERT INTO projects (company_id, name, slug, goal) VALUES ($1, $2, $3, $4) RETURNING *`,
				[args.company_id, args.name, slug, args.goal ?? ''],
			);
			return r.rows[0];
		},
		db,
	);

	// Comments
	tool(
		server,
		'list_comments',
		'List comments for an issue',
		{
			company_id: z.string().describe('Company ID'),
			issue_id: z.string().describe('Issue ID'),
		},
		async (args, db) => {
			const r = await db.query(
				`SELECT ic.*, COALESCE(ma.title, m.display_name) AS author_name
			 FROM issue_comments ic LEFT JOIN members m ON m.id = ic.author_member_id LEFT JOIN member_agents ma ON ma.id = ic.author_member_id
			 WHERE ic.issue_id = $1 ORDER BY ic.created_at ASC`,
				[args.issue_id],
			);
			return r.rows;
		},
		db,
	);

	tool(
		server,
		'create_comment',
		'Add a comment to an issue',
		{
			issue_id: z.string().describe('Issue ID'),
			content: z.string().describe('Comment text'),
		},
		async (args, db) => {
			const r = await db.query(
				`INSERT INTO issue_comments (issue_id, content_type, content) VALUES ($1, 'text'::comment_content_type, $2::jsonb) RETURNING *`,
				[args.issue_id, JSON.stringify({ text: args.content })],
			);
			return r.rows[0];
		},
		db,
	);

	// Approvals
	tool(
		server,
		'list_approvals',
		'List pending approvals',
		{
			company_id: z.string().describe('Company ID'),
		},
		async (args, db) => {
			const r = await db.query(
				`SELECT * FROM approvals WHERE company_id = $1 AND status = 'pending' ORDER BY created_at DESC`,
				[args.company_id],
			);
			return r.rows;
		},
		db,
	);

	tool(
		server,
		'resolve_approval',
		'Approve or deny an approval',
		{
			approval_id: z.string().describe('Approval ID'),
			status: z.enum(['approved', 'denied']).describe('Resolution status'),
			resolution_note: z.string().optional().describe('Note'),
		},
		async (args, db) => {
			const r = await db.query(
				`UPDATE approvals SET status = $1::approval_status, resolution_note = $2, resolved_at = now() WHERE id = $3 RETURNING *`,
				[args.status, args.resolution_note ?? null, args.approval_id],
			);
			return r.rows[0] ?? null;
		},
		db,
	);

	// KB Docs
	tool(
		server,
		'list_kb_docs',
		'List knowledge base documents',
		{
			company_id: z.string().describe('Company ID'),
		},
		async (args, db) => {
			const r = await db.query(
				'SELECT id, title, slug, updated_at FROM kb_docs WHERE company_id = $1 ORDER BY title',
				[args.company_id],
			);
			return r.rows;
		},
		db,
	);

	tool(
		server,
		'get_kb_doc',
		'Get a KB document by slug',
		{
			company_id: z.string().describe('Company ID'),
			slug: z.string().describe('Document slug'),
		},
		async (args, db) => {
			const r = await db.query('SELECT * FROM kb_docs WHERE company_id = $1 AND slug = $2', [
				args.company_id,
				args.slug,
			]);
			return r.rows[0] ?? null;
		},
		db,
	);

	// Costs
	tool(
		server,
		'get_costs',
		'Get cost summary for a company',
		{
			company_id: z.string().describe('Company ID'),
			group_by: z.enum(['agent', 'project', 'day']).optional().describe('Group costs by'),
		},
		async (args, db) => {
			if (args.group_by === 'agent') {
				const r = await db.query(
					`SELECT ce.member_id, COALESCE(ma.title, m.display_name) AS agent_title, sum(ce.amount_cents)::int AS total_cents
				 FROM cost_entries ce LEFT JOIN members m ON m.id = ce.member_id LEFT JOIN member_agents ma ON ma.id = ce.member_id
				 WHERE ce.company_id = $1 GROUP BY ce.member_id, ma.title, m.display_name`,
					[args.company_id],
				);
				return r.rows;
			}
			const r = await db.query(
				`SELECT sum(amount_cents)::int AS total_cents, count(*)::int AS entry_count FROM cost_entries WHERE company_id = $1`,
				[args.company_id],
			);
			return r.rows[0];
		},
		db,
	);

	return [...registeredTools];
}

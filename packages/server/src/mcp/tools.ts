import type { PGlite } from '@electric-sql/pglite';
import {
	ApprovalStatus,
	ApprovalType,
	AuthType,
	CommentContentType,
	IssuePriority,
	IssueStatus,
} from '@hezo/shared';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { AuthInfo } from '../lib/types';

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
	handler: (args: Record<string, unknown>, db: PGlite, auth: AuthInfo) => Promise<unknown>,
	db: PGlite,
) {
	registeredTools.push({
		name,
		description,
		schema: Object.fromEntries(Object.entries(schema).map(([k, v]) => [k, v.description ?? k])),
	});
	server.tool(name, description, schema, async (args: Record<string, unknown>) => {
		const auth = args.__auth as AuthInfo | undefined;
		if (!auth) {
			return {
				content: [
					{
						type: 'text' as const,
						text: JSON.stringify({ error: 'Unauthorized: missing auth context' }),
					},
				],
			};
		}
		// Remove internal auth from args before passing to handler
		const cleanArgs = { ...args };
		delete cleanArgs.__auth;
		const result = await handler(cleanArgs, db, auth);
		return { content: [{ type: 'text' as const, text: JSON.stringify(result, null, 2) }] };
	});
}

/**
 * Verify the caller has access to the given company_id.
 * Returns an error string if access denied, null if allowed.
 */
async function verifyCompanyAccess(
	db: PGlite,
	auth: AuthInfo,
	companyId: string,
): Promise<string | null> {
	if (auth.type === AuthType.ApiKey || auth.type === AuthType.Agent) {
		if (auth.companyId !== companyId) return 'Access denied: company mismatch';
		return null;
	}
	if (auth.type === AuthType.Board) {
		if (auth.isSuperuser) return null;
		const result = await db.query(
			'SELECT m.id FROM members m JOIN member_users mu ON mu.id = m.id WHERE mu.user_id = $1 AND m.company_id = $2',
			[auth.userId, companyId],
		);
		if (result.rows.length === 0) return 'Access denied: not a member of this company';
		return null;
	}
	return 'Access denied';
}

export function registerTools(server: McpServer, db: PGlite): ToolDef[] {
	registeredTools.length = 0;

	// Companies
	tool(
		server,
		'list_companies',
		'List companies accessible to the caller',
		{},
		async (_args, db, auth) => {
			if (auth.type === AuthType.ApiKey || auth.type === AuthType.Agent) {
				const r = await db.query('SELECT * FROM companies WHERE id = $1', [auth.companyId]);
				return r.rows;
			}
			if (auth.type === AuthType.Board) {
				if (auth.isSuperuser) {
					const r = await db.query('SELECT * FROM companies ORDER BY name');
					return r.rows;
				}
				const r = await db.query(
					`SELECT c.* FROM companies c
					 JOIN members m ON m.company_id = c.id
					 JOIN member_users mu ON mu.id = m.id
					 WHERE mu.user_id = $1
					 ORDER BY c.name`,
					[auth.userId],
				);
				return r.rows;
			}
			return [];
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
		async (args, db, auth) => {
			const denied = await verifyCompanyAccess(db, auth, args.company_id as string);
			if (denied) return { error: denied };
			const r = await db.query('SELECT * FROM companies WHERE id = $1', [args.company_id]);
			return r.rows[0] ?? null;
		},
		db,
	);

	tool(
		server,
		'create_company',
		'Create a new company (superuser only)',
		{
			name: z.string().describe('Company name'),
			issue_prefix: z.string().describe('Issue prefix (e.g. ACME)'),
			description: z.string().optional().describe('Company description'),
		},
		async (args, db, auth) => {
			if (auth.type !== AuthType.Board || !auth.isSuperuser) {
				return { error: 'Access denied: superuser required' };
			}
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
		async (args, db, auth) => {
			const denied = await verifyCompanyAccess(db, auth, args.company_id as string);
			if (denied) return { error: denied };
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
		async (args, db, auth) => {
			const denied = await verifyCompanyAccess(db, auth, args.company_id as string);
			if (denied) return { error: denied };
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
			assignee_id: z.string().describe('Assignee member ID (required)'),
		},
		async (args, db, auth) => {
			const denied = await verifyCompanyAccess(db, auth, args.company_id as string);
			if (denied) return { error: denied };
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
			 VALUES ($1, $2, $3, $4, $5, $6, $7, $8::issue_status, $9::issue_priority) RETURNING *`,
				[
					args.company_id,
					args.project_id,
					args.assignee_id,
					num,
					identifier,
					args.title,
					args.description ?? '',
					IssueStatus.Backlog,
					args.priority ?? IssuePriority.Medium,
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
			assignee_id: z.string().optional().describe('New assignee ID'),
		},
		async (args, db, auth) => {
			const denied = await verifyCompanyAccess(db, auth, args.company_id as string);
			if (denied) return { error: denied };
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
		async (args, db, auth) => {
			const denied = await verifyCompanyAccess(db, auth, args.company_id as string);
			if (denied) return { error: denied };
			const r = await db.query(
				`SELECT m.id, ma.agent_type_id, ma.title, ma.slug, ma.runtime_type,
				        ma.monthly_budget_cents, ma.budget_used_cents, ma.runtime_status, ma.admin_status
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
		async (args, db, auth) => {
			const denied = await verifyCompanyAccess(db, auth, args.company_id as string);
			if (denied) return { error: denied };
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
		async (args, db, auth) => {
			const denied = await verifyCompanyAccess(db, auth, args.company_id as string);
			if (denied) return { error: denied };
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
		async (args, db, auth) => {
			const denied = await verifyCompanyAccess(db, auth, args.company_id as string);
			if (denied) return { error: denied };
			// Verify issue belongs to company
			const issueCheck = await db.query('SELECT id FROM issues WHERE id = $1 AND company_id = $2', [
				args.issue_id,
				args.company_id,
			]);
			if (issueCheck.rows.length === 0) return { error: 'Issue not found in this company' };
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
			company_id: z.string().describe('Company ID'),
			issue_id: z.string().describe('Issue ID'),
			content: z.string().describe('Comment text'),
		},
		async (args, db, auth) => {
			const denied = await verifyCompanyAccess(db, auth, args.company_id as string);
			if (denied) return { error: denied };
			// Verify issue belongs to company
			const issueCheck = await db.query('SELECT id FROM issues WHERE id = $1 AND company_id = $2', [
				args.issue_id,
				args.company_id,
			]);
			if (issueCheck.rows.length === 0) return { error: 'Issue not found in this company' };
			const r = await db.query(
				`INSERT INTO issue_comments (issue_id, content_type, content) VALUES ($1, $2::comment_content_type, $3::jsonb) RETURNING *`,
				[args.issue_id, CommentContentType.Text, JSON.stringify({ text: args.content })],
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
		async (args, db, auth) => {
			const denied = await verifyCompanyAccess(db, auth, args.company_id as string);
			if (denied) return { error: denied };
			const r = await db.query(
				`SELECT * FROM approvals WHERE company_id = $1 AND status = $2::approval_status ORDER BY created_at DESC`,
				[args.company_id, ApprovalStatus.Pending],
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
			status: z
				.enum([ApprovalStatus.Approved, ApprovalStatus.Denied])
				.describe('Resolution status'),
			resolution_note: z.string().optional().describe('Note'),
		},
		async (args, db, auth) => {
			// Look up the approval's company and verify access
			const existing = await db.query<{ company_id: string }>(
				'SELECT company_id FROM approvals WHERE id = $1',
				[args.approval_id],
			);
			if (existing.rows.length === 0) return { error: 'Approval not found' };
			const denied = await verifyCompanyAccess(db, auth, existing.rows[0].company_id);
			if (denied) return { error: denied };
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
		async (args, db, auth) => {
			const denied = await verifyCompanyAccess(db, auth, args.company_id as string);
			if (denied) return { error: denied };
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
		async (args, db, auth) => {
			const denied = await verifyCompanyAccess(db, auth, args.company_id as string);
			if (denied) return { error: denied };
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
		async (args, db, auth) => {
			const denied = await verifyCompanyAccess(db, auth, args.company_id as string);
			if (denied) return { error: denied };
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

	// System Prompt Management (Coach + self only)
	tool(
		server,
		'get_agent_system_prompt',
		"Read an agent's system prompt. Only accessible by the Coach agent, the agent itself, or board users.",
		{
			company_id: z.string().describe('Company ID'),
			agent_id: z.string().describe('Target agent member ID'),
		},
		async (args, db, auth) => {
			const denied = await verifyCompanyAccess(db, auth, args.company_id as string);
			if (denied) return { error: denied };

			if (!(await isCoachOrSelf(db, auth, args.agent_id as string))) {
				return {
					error: 'Access denied: only the Coach or the agent itself can read system prompts',
				};
			}

			const r = await db.query<{ title: string; slug: string; system_prompt: string }>(
				`SELECT ma.title, ma.slug, ma.system_prompt
				 FROM member_agents ma JOIN members m ON m.id = ma.id
				 WHERE ma.id = $1 AND m.company_id = $2`,
				[args.agent_id, args.company_id],
			);
			if (r.rows.length === 0) return { error: 'Agent not found in this company' };
			return r.rows[0];
		},
		db,
	);

	tool(
		server,
		'propose_system_prompt_update',
		'Propose or apply a system prompt change for an agent. Only accessible by the Coach agent or the agent itself.',
		{
			company_id: z.string().describe('Company ID'),
			agent_id: z.string().describe('Target agent member ID'),
			new_system_prompt: z.string().describe('The full updated system prompt'),
			change_summary: z.string().describe('Summary of what changed and why'),
		},
		async (args, db, auth) => {
			const denied = await verifyCompanyAccess(db, auth, args.company_id as string);
			if (denied) return { error: denied };

			if (!(await isCoachOrSelf(db, auth, args.agent_id as string))) {
				return {
					error: 'Access denied: only the Coach or the agent itself can update system prompts',
				};
			}

			// Verify agent exists in company
			const agentCheck = await db.query<{ system_prompt: string }>(
				`SELECT ma.system_prompt FROM member_agents ma JOIN members m ON m.id = ma.id
				 WHERE ma.id = $1 AND m.company_id = $2`,
				[args.agent_id, args.company_id],
			);
			if (agentCheck.rows.length === 0) return { error: 'Agent not found in this company' };

			const company = await db.query<{ settings: Record<string, unknown> }>(
				'SELECT settings FROM companies WHERE id = $1',
				[args.company_id],
			);
			const autoApply = (company.rows[0]?.settings?.coach_auto_apply as boolean) ?? false;

			const callerMemberId = auth.type === AuthType.Agent ? auth.memberId : null;

			if (autoApply) {
				// Direct apply + record revision
				const oldPrompt = agentCheck.rows[0].system_prompt;
				const revNum = await db.query<{ n: number }>(
					'SELECT COALESCE(MAX(revision_number), 0) + 1 AS n FROM system_prompt_revisions WHERE member_agent_id = $1',
					[args.agent_id],
				);
				await db.query('UPDATE member_agents SET system_prompt = $1 WHERE id = $2', [
					args.new_system_prompt,
					args.agent_id,
				]);
				await db.query(
					`INSERT INTO system_prompt_revisions (member_agent_id, company_id, revision_number, old_prompt, new_prompt, change_summary, author_member_id)
					 VALUES ($1, $2, $3, $4, $5, $6, $7)`,
					[
						args.agent_id,
						args.company_id,
						revNum.rows[0].n,
						oldPrompt,
						args.new_system_prompt,
						args.change_summary,
						callerMemberId,
					],
				);
				return { applied: true, message: 'System prompt updated directly (auto-apply enabled)' };
			}

			// Create approval request
			const result = await db.query<{ id: string; status: string }>(
				`INSERT INTO approvals (company_id, type, requested_by_member_id, payload)
				 VALUES ($1, $2::approval_type, $3, $4::jsonb)
				 RETURNING id, status`,
				[
					args.company_id,
					ApprovalType.SystemPromptUpdate,
					callerMemberId,
					JSON.stringify({
						member_id: args.agent_id,
						new_system_prompt: args.new_system_prompt,
						reason: args.change_summary,
					}),
				],
			);
			return { applied: false, approval_id: result.rows[0].id, status: result.rows[0].status };
		},
		db,
	);

	return [...registeredTools];
}

async function isCoachOrSelf(db: PGlite, auth: AuthInfo, targetAgentId: string): Promise<boolean> {
	if (auth.type === AuthType.Board) return true;
	if (auth.type === AuthType.Agent) {
		if (auth.memberId === targetAgentId) return true;
		const coach = await db.query<{ slug: string }>('SELECT slug FROM member_agents WHERE id = $1', [
			auth.memberId,
		]);
		return coach.rows[0]?.slug === 'coach';
	}
	return false;
}

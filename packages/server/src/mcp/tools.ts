import { AsyncLocalStorage } from 'node:async_hooks';
import type { PGlite } from '@electric-sql/pglite';
import {
	ApprovalStatus,
	ApprovalType,
	AuthType,
	CommentContentType,
	IssuePriority,
	IssueStatus,
	WakeupSource,
} from '@hezo/shared';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { AuthInfo } from '../lib/types';
import { logger } from '../logger';
import { triggerStatusAutomations } from '../services/issue-automation';
import { createWakeup } from '../services/wakeup';

const log = logger.child('mcp');

export const authContext = new AsyncLocalStorage<AuthInfo>();

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
		const auth = authContext.getStore();
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
		const result = await handler(args, db, auth);
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

export function registerTools(server: McpServer, db: PGlite, dataDir: string): ToolDef[] {
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
		'Create a new issue. Use parent_issue_id for sub-issues. Use assignee_slug as alternative to assignee_id.',
		{
			company_id: z.string().describe('Company ID'),
			project_id: z.string().describe('Project ID'),
			title: z.string().describe('Issue title'),
			description: z.string().optional().describe('Issue description'),
			priority: z.string().optional().describe('Priority: low, medium, high, urgent'),
			assignee_id: z.string().optional().describe('Assignee member ID'),
			assignee_slug: z
				.string()
				.optional()
				.describe('Assignee agent slug (alternative to assignee_id)'),
			parent_issue_id: z.string().optional().describe('Parent issue ID (creates a sub-issue)'),
		},
		async (args, db, auth) => {
			const denied = await verifyCompanyAccess(db, auth, args.company_id as string);
			if (denied) return { error: denied };

			// Resolve assignee: prefer assignee_id, fall back to slug lookup
			let assigneeId = args.assignee_id as string | undefined;
			if (!assigneeId && args.assignee_slug) {
				const agent = await db.query<{ id: string }>(
					`SELECT ma.id FROM member_agents ma
					 JOIN members m ON m.id = ma.id
					 WHERE ma.slug = $1 AND m.company_id = $2`,
					[args.assignee_slug, args.company_id],
				);
				if (agent.rows.length === 0)
					return { error: `Agent with slug '${args.assignee_slug}' not found` };
				assigneeId = agent.rows[0].id;
			}
			if (!assigneeId) return { error: 'Either assignee_id or assignee_slug is required' };

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
			const r = await db.query<{ id: string }>(
				`INSERT INTO issues (company_id, project_id, assignee_id, parent_issue_id, number, identifier, title, description, status, priority)
			 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9::issue_status, $10::issue_priority) RETURNING *`,
				[
					args.company_id,
					args.project_id,
					assigneeId,
					args.parent_issue_id ?? null,
					num,
					identifier,
					args.title,
					args.description ?? '',
					IssueStatus.Backlog,
					args.priority ?? IssuePriority.Medium,
				],
			);

			// Wake the assigned agent
			const isAgent = await db.query('SELECT id FROM member_agents WHERE id = $1', [assigneeId]);
			if (isAgent.rows.length > 0) {
				createWakeup(db, assigneeId, args.company_id as string, WakeupSource.Assignment, {
					issue_id: r.rows[0].id,
				}).catch((e) => log.error('Failed to wake agent:', e));
			}

			return r.rows[0];
		},
		db,
	);

	tool(
		server,
		'update_issue',
		'Update an issue. Agents can use this to change status, update progress, set rules, and record branch names.',
		{
			company_id: z.string().describe('Company ID'),
			issue_id: z.string().describe('Issue ID'),
			title: z.string().optional().describe('New title'),
			description: z.string().optional().describe('New description'),
			status: z
				.string()
				.optional()
				.describe(
					'New status (backlog, open, in_progress, review, approved, blocked, done, closed, cancelled)',
				),
			priority: z.string().optional().describe('New priority'),
			assignee_id: z.string().optional().describe('New assignee ID'),
			progress_summary: z.string().optional().describe('Progress summary update'),
			rules: z.string().optional().describe('Rules/constraints for this issue'),
			branch_name: z.string().optional().describe('Git branch name for this issue'),
		},
		async (args, db, auth) => {
			const denied = await verifyCompanyAccess(db, auth, args.company_id as string);
			if (denied) return { error: denied };
			const sets: string[] = [];
			const params: unknown[] = [];
			let idx = 1;
			for (const [key, val] of Object.entries(args)) {
				if (['company_id', 'issue_id'].includes(key) || val === undefined) continue;
				if (key === 'status') {
					sets.push(`status = $${idx}::issue_status`);
				} else if (key === 'priority') {
					sets.push(`priority = $${idx}::issue_priority`);
				} else if (key === 'progress_summary') {
					sets.push(`progress_summary = $${idx}`);
					params.push(val);
					idx++;
					sets.push('progress_summary_updated_at = now()');
					const updatedBy = auth.type === AuthType.Agent ? auth.memberId : null;
					sets.push(`progress_summary_updated_by = $${idx}`);
					params.push(updatedBy);
					idx++;
					continue;
				} else {
					sets.push(`${key} = $${idx}`);
				}
				params.push(val);
				idx++;
			}
			if (sets.length === 0) return { unchanged: true };
			params.push(args.issue_id, args.company_id);
			const r = await db.query(
				`UPDATE issues SET ${sets.join(', ')} WHERE id = $${idx} AND company_id = $${idx + 1} RETURNING *`,
				params,
			);
			if (!r.rows[0]) return null;

			// Trigger status automations (e.g. Coach wakeup on Done)
			if (args.status) {
				triggerStatusAutomations(
					db,
					args.company_id as string,
					args.issue_id as string,
					args.status as string,
				).catch((e) => log.error('Failed to trigger status automations:', e));
			}

			// Wake agent if assignee changed
			if (args.assignee_id) {
				const isAgent = await db.query('SELECT id FROM member_agents WHERE id = $1', [
					args.assignee_id,
				]);
				if (isAgent.rows.length > 0) {
					createWakeup(
						db,
						args.assignee_id as string,
						args.company_id as string,
						WakeupSource.Assignment,
						{
							issue_id: args.issue_id,
						},
					).catch((e) => log.error('Failed to wake agent:', e));
				}
			}

			return r.rows[0];
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
			description: z.string().optional().describe('Project description'),
		},
		async (args, db, auth) => {
			const denied = await verifyCompanyAccess(db, auth, args.company_id as string);
			if (denied) return { error: denied };
			const slug = (args.name as string)
				.toLowerCase()
				.replace(/[^a-z0-9]+/g, '-')
				.replace(/^-|-$/g, '');
			const r = await db.query(
				`INSERT INTO projects (company_id, name, slug, description) VALUES ($1, $2, $3, $4) RETURNING *`,
				[args.company_id, args.name, slug, args.description ?? ''],
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
		"Read an agent's system prompt. Accessible by any agent or board user in the same company.",
		{
			company_id: z.string().describe('Company ID'),
			agent_id: z.string().describe('Target agent member ID'),
		},
		async (args, db, auth) => {
			const denied = await verifyCompanyAccess(db, auth, args.company_id as string);
			if (denied) return { error: denied };

			// Any agent or board user in the same company can read other agents' prompts
			if (auth.type !== AuthType.Agent && auth.type !== AuthType.Board) {
				return { error: 'Access denied' };
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

	// Description maintenance — used by the CEO (and self) to write back
	// auto-generated agent and team summaries.
	tool(
		server,
		'set_agent_summary',
		'Save a short human-readable summary for an agent (≤1000 chars, single paragraph, plain prose). Callable by any agent in the same company or any board user; the CEO is the expected caller, but agents may also self-summarise.',
		{
			company_id: z.string().describe('Company ID'),
			agent_id: z.string().describe('Target agent member ID'),
			summary: z.string().describe('The new summary, ≤1000 chars'),
		},
		async (args, db, auth) => {
			const denied = await verifyCompanyAccess(db, auth, args.company_id as string);
			if (denied) return { error: denied };

			if (auth.type !== AuthType.Agent && auth.type !== AuthType.Board) {
				return { error: 'Access denied' };
			}

			const summary = String(args.summary ?? '').trim();
			if (summary.length === 0) return { error: 'summary must be non-empty' };
			if (summary.length > 1000) {
				return { error: `summary too long (${summary.length} chars; max 1000)` };
			}

			const r = await db.query<{ id: string }>(
				`UPDATE member_agents SET summary = $1, updated_at = now()
				 WHERE id = $2 AND id IN (
				   SELECT m.id FROM members m WHERE m.id = $2 AND m.company_id = $3
				 )
				 RETURNING id`,
				[summary, args.agent_id, args.company_id],
			);
			if (r.rows.length === 0) return { error: 'Agent not found in this company' };

			return { updated: true };
		},
		db,
	);

	tool(
		server,
		'set_team_summary',
		'Save the team-level collaboration summary for a company (≤4000 chars, plain prose, may span paragraphs). Only callable by the CEO of that company.',
		{
			company_id: z.string().describe('Company ID'),
			summary: z.string().describe('The new team summary, ≤4000 chars'),
		},
		async (args, db, auth) => {
			const denied = await verifyCompanyAccess(db, auth, args.company_id as string);
			if (denied) return { error: denied };

			if (!(await isCeoOfCompany(db, auth, args.company_id as string))) {
				return { error: 'Access denied: only the CEO can update the team summary' };
			}

			const summary = String(args.summary ?? '').trim();
			if (summary.length === 0) return { error: 'summary must be non-empty' };
			if (summary.length > 4000) {
				return { error: `summary too long (${summary.length} chars; max 4000)` };
			}

			await db.query('UPDATE companies SET team_summary = $1, updated_at = now() WHERE id = $2', [
				summary,
				args.company_id,
			]);

			return { updated: true };
		},
		db,
	);

	// KB Docs: upsert
	tool(
		server,
		'upsert_kb_doc',
		'Create or update a knowledge base document',
		{
			company_id: z.string().describe('Company ID'),
			title: z.string().describe('Document title'),
			slug: z.string().describe('URL-safe slug (e.g. "coding-standards")'),
			content: z.string().describe('Document content (markdown)'),
		},
		async (args, db, auth) => {
			const denied = await verifyCompanyAccess(db, auth, args.company_id as string);
			if (denied) return { error: denied };
			const callerMemberId = auth.type === AuthType.Agent ? auth.memberId : null;
			const r = await db.query(
				`INSERT INTO kb_docs (company_id, title, slug, content, last_updated_by_member_id)
				 VALUES ($1, $2, $3, $4, $5)
				 ON CONFLICT (company_id, slug) DO UPDATE
				 SET title = EXCLUDED.title, content = EXCLUDED.content,
				     last_updated_by_member_id = EXCLUDED.last_updated_by_member_id, updated_at = now()
				 RETURNING *`,
				[args.company_id, args.title, args.slug, args.content, callerMemberId],
			);
			return r.rows[0];
		},
		db,
	);

	// Project docs
	tool(
		server,
		'list_project_docs',
		'List project documentation files (PRD, spec, implementation plan, etc.)',
		{
			company_id: z.string().describe('Company ID'),
			project_id: z.string().describe('Project ID'),
		},
		async (args, db, auth) => {
			const denied = await verifyCompanyAccess(db, auth, args.company_id as string);
			if (denied) return { error: denied };
			const result = await db.query(
				'SELECT id, filename, updated_at FROM project_docs WHERE project_id = $1 ORDER BY filename',
				[args.project_id],
			);
			return { files: result.rows };
		},
		db,
	);

	tool(
		server,
		'read_project_doc',
		'Read a project documentation file by filename',
		{
			company_id: z.string().describe('Company ID'),
			project_id: z.string().describe('Project ID'),
			filename: z.string().describe('Filename to read (e.g. "spec.md")'),
		},
		async (args, db, auth) => {
			const denied = await verifyCompanyAccess(db, auth, args.company_id as string);
			if (denied) return { error: denied };
			const result = await db.query<{ filename: string; content: string }>(
				'SELECT filename, content FROM project_docs WHERE project_id = $1 AND filename = $2',
				[args.project_id, args.filename],
			);
			if (result.rows.length === 0) return { error: `File '${args.filename}' not found` };
			return result.rows[0];
		},
		db,
	);

	tool(
		server,
		'write_project_doc',
		'Write a project documentation file. For high-level project context: PRD, spec, implementation plan, research.',
		{
			company_id: z.string().describe('Company ID'),
			project_id: z.string().describe('Project ID'),
			filename: z.string().describe('Filename to write (e.g. "spec.md")'),
			content: z.string().describe('File content (markdown)'),
		},
		async (args, db, auth) => {
			const denied = await verifyCompanyAccess(db, auth, args.company_id as string);
			if (denied) return { error: denied };
			const callerMemberId = auth.type === AuthType.Agent ? auth.memberId : null;
			const result = await db.query<{ id: string; filename: string }>(
				`INSERT INTO project_docs (project_id, company_id, filename, content, last_updated_by_member_id)
				 VALUES ($1, $2, $3, $4, $5)
				 ON CONFLICT (project_id, filename) DO UPDATE SET
				   content = EXCLUDED.content,
				   last_updated_by_member_id = EXCLUDED.last_updated_by_member_id,
				   updated_at = now()
				 RETURNING id, filename`,
				[args.project_id, args.company_id, args.filename, args.content, callerMemberId],
			);
			return { written: true, id: result.rows[0].id, filename: result.rows[0].filename };
		},
		db,
	);

	// Skill proposals
	tool(
		server,
		'propose_skill',
		'Propose a new skill. Creates an approval request that, when approved, writes the skill file.',
		{
			company_id: z.string().describe('Company ID'),
			skill_name: z.string().describe('Human-readable skill name'),
			skill_slug: z.string().describe('URL-safe slug for the skill file'),
			content: z.string().describe('Skill content (markdown)'),
			reason: z.string().describe('Why this skill should be added'),
		},
		async (args, db, auth) => {
			const denied = await verifyCompanyAccess(db, auth, args.company_id as string);
			if (denied) return { error: denied };
			const callerMemberId = auth.type === AuthType.Agent ? auth.memberId : null;
			const result = await db.query<{ id: string; status: string }>(
				`INSERT INTO approvals (company_id, type, requested_by_member_id, payload)
				 VALUES ($1, $2::approval_type, $3, $4::jsonb)
				 RETURNING id, status`,
				[
					args.company_id,
					ApprovalType.SkillProposal,
					callerMemberId,
					JSON.stringify({
						skill_name: args.skill_name,
						skill_slug: args.skill_slug,
						content: args.content,
						reason: args.reason,
					}),
				],
			);
			return { approval_id: result.rows[0].id, status: result.rows[0].status };
		},
		db,
	);

	// Semantic search
	tool(
		server,
		'semantic_search',
		'Search across knowledge base docs, issues, and skills using natural language. Returns ranked results by relevance.',
		{
			company_id: z.string().describe('Company ID'),
			query: z.string().describe('Natural language search query'),
			scope: z
				.enum(['all', 'kb_docs', 'issues', 'skills', 'project_docs'])
				.optional()
				.describe('Limit search to specific content type (default: all)'),
			limit: z.number().optional().describe('Max results (default: 10)'),
		},
		async (args, db, auth) => {
			const denied = await verifyCompanyAccess(db, auth, args.company_id as string);
			if (denied) return { error: denied };

			const { isModelReady, semanticSearch } = await import('../services/embeddings');
			if (!isModelReady()) {
				return {
					error:
						'Embedding model not loaded yet. Search will be available shortly after server start.',
				};
			}

			const results = await semanticSearch(db, args.company_id as string, args.query as string, {
				scope: (args.scope as 'all' | 'kb_docs' | 'issues' | 'skills' | 'project_docs') ?? 'all',
				limit: (args.limit as number) ?? 10,
			});

			return { results, count: results.length };
		},
		db,
	);

	// Skills - DB-backed CRUD
	tool(
		server,
		'list_skills',
		'List all active skills for a company. Returns name, slug, description, and tags.',
		{
			company_id: z.string().describe('Company ID'),
			tags: z.string().optional().describe('Filter by tag (comma-separated)'),
		},
		async (args, db, auth) => {
			const denied = await verifyCompanyAccess(db, auth, args.company_id as string);
			if (denied) return { error: denied };

			let query = `SELECT id, name, slug, description, tags, created_at, updated_at
			             FROM skills WHERE company_id = $1 AND is_active = true`;
			const params: unknown[] = [args.company_id];

			if (args.tags) {
				const tagList = (args.tags as string).split(',').map((t) => t.trim());
				query += ` AND tags ?| $2`;
				params.push(tagList);
			}

			query += ' ORDER BY name';
			const result = await db.query(query, params);
			return { skills: result.rows };
		},
		db,
	);

	tool(
		server,
		'get_skill',
		'Get the full content of a skill by slug.',
		{
			company_id: z.string().describe('Company ID'),
			slug: z.string().describe('Skill slug'),
		},
		async (args, db, auth) => {
			const denied = await verifyCompanyAccess(db, auth, args.company_id as string);
			if (denied) return { error: denied };

			const result = await db.query('SELECT * FROM skills WHERE company_id = $1 AND slug = $2', [
				args.company_id,
				args.slug,
			]);
			if (result.rows.length === 0) return { error: 'Skill not found' };
			return result.rows[0];
		},
		db,
	);

	tool(
		server,
		'create_skill',
		'Create a new skill directly (no approval needed). Use propose_skill if approval is required.',
		{
			company_id: z.string().describe('Company ID'),
			name: z.string().describe('Human-readable skill name'),
			slug: z.string().describe('URL-safe slug'),
			content: z.string().describe('Skill content (markdown)'),
			description: z.string().optional().describe('Short description'),
			tags: z.string().optional().describe('Comma-separated tags'),
		},
		async (args, db, auth) => {
			const denied = await verifyCompanyAccess(db, auth, args.company_id as string);
			if (denied) return { error: denied };

			const callerMemberId = auth.type === AuthType.Agent ? auth.memberId : null;
			const { createHash } = await import('node:crypto');
			const contentHash = createHash('sha256')
				.update(args.content as string)
				.digest('hex');
			const tagList = args.tags ? (args.tags as string).split(',').map((t) => t.trim()) : [];

			const result = await db.query<{ id: string; slug: string }>(
				`INSERT INTO skills (company_id, name, slug, description, content, content_hash, created_by_member_id, tags)
				 VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
				 ON CONFLICT (company_id, slug) DO UPDATE SET
				   content = EXCLUDED.content,
				   content_hash = EXCLUDED.content_hash,
				   description = EXCLUDED.description,
				   tags = EXCLUDED.tags,
				   updated_at = now()
				 RETURNING id, slug`,
				[
					args.company_id,
					args.name,
					args.slug,
					(args.description as string) ?? '',
					args.content,
					contentHash,
					callerMemberId,
					JSON.stringify(tagList),
				],
			);

			const skillId = result.rows[0].id;
			await db.query(
				`INSERT INTO skill_revisions (skill_id, revision_number, content, content_hash, change_summary, author_member_id)
				 VALUES ($1, (SELECT COALESCE(MAX(revision_number), 0) + 1 FROM skill_revisions WHERE skill_id = $1), $2, $3, 'Created via MCP', $4)`,
				[skillId, args.content, contentHash, callerMemberId],
			);

			return { skill_id: skillId, slug: result.rows[0].slug, created: true };
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

async function isCeoOfCompany(db: PGlite, auth: AuthInfo, companyId: string): Promise<boolean> {
	if (auth.type !== AuthType.Agent) return false;
	const r = await db.query<{ slug: string }>(
		`SELECT ma.slug FROM member_agents ma
		 JOIN members m ON m.id = ma.id
		 WHERE ma.id = $1 AND m.company_id = $2`,
		[auth.memberId, companyId],
	);
	return r.rows[0]?.slug === 'ceo';
}

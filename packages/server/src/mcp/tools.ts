import { AsyncLocalStorage } from 'node:async_hooks';
import type { PGlite } from '@electric-sql/pglite';
import {
	ApprovalStatus,
	ApprovalType,
	AuthType,
	CEO_AGENT_SLUG,
	COACH_AGENT_SLUG,
	CommentContentType,
	DocumentType,
	IssuePriority,
	IssueStatus,
	WakeupSource,
} from '@hezo/shared';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import { assertNoActiveRun } from '../lib/active-run';
import { assertSubordinateAssignee } from '../lib/assignment-hierarchy';
import { allocateIssueIdentifier } from '../lib/issue-identifier';
import {
	assertChildDepthAllowed,
	assertChildrenAllClosed,
	assertNoOutstandingActivity,
} from '../lib/issue-relationships';
import { assertOperationsAssignee } from '../lib/operations-assignee';
import type { AuthInfo } from '../lib/types';
import { logger } from '../logger';
import { resolveProjectIssuePrefix } from '../routes/projects';
import { fireCommentWakeups } from '../services/comment-wakeups';
import {
	getAgentSystemPrompt,
	getDocument,
	listDocuments,
	upsertDocument,
} from '../services/documents';
import { triggerStatusAutomations } from '../services/issue-automation';
import { recordIssueLinks } from '../services/issue-events';
import { createWakeup } from '../services/wakeup';
import type { WebSocketManager } from '../services/ws';

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

export function registerTools(
	server: McpServer,
	db: PGlite,
	_dataDir: string,
	wsManager?: WebSocketManager,
): ToolDef[] {
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
				`INSERT INTO companies (name, slug, description) VALUES ($1, $2, $3) RETURNING *`,
				[args.name, slug, args.description ?? ''],
			);
			return r.rows[0];
		},
		db,
	);

	// Issues
	tool(
		server,
		'list_issues',
		'List issues for a company. Returns up to 50 issues ordered by creation date (newest first). Filter by project_id to scope to one project (the common case), and optionally by status (comma-separated) or assignee_id/assignee_slug to narrow further. The Project State block in your system prompt already gives you the active tickets in the current project — only call this if you need older or terminal tickets, a different project, or a specific status filter.',
		{
			company_id: z.string().describe('Company ID'),
			project_id: z.string().optional().describe('Filter by project ID'),
			status: z.string().optional().describe('Filter by status (comma-separated)'),
			assignee_id: z.string().optional().describe('Filter by assignee member ID'),
			assignee_slug: z
				.string()
				.optional()
				.describe('Filter by assignee agent slug (alternative to assignee_id)'),
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
				idx += statuses.length;
			}
			let assigneeId = args.assignee_id as string | undefined;
			if (!assigneeId && args.assignee_slug) {
				const agent = await db.query<{ id: string }>(
					`SELECT ma.id FROM member_agents ma
					 JOIN members m ON m.id = ma.id
					 WHERE ma.slug = $1 AND m.company_id = $2`,
					[args.assignee_slug, args.company_id],
				);
				if (agent.rows.length === 0) return [];
				assigneeId = agent.rows[0].id;
			}
			if (assigneeId) {
				conditions.push(`i.assignee_id = $${idx}`);
				params.push(assigneeId);
				idx++;
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
		'Create a new issue. Use parent_issue_id for sub-issues — prefer this over a top-level ticket whenever the new work is part of the ticket you are on. Sub-issues themselves can have sub-issues, but no deeper (depth is capped at 2). Use assignee_slug as alternative to assignee_id. As an agent caller, you may only assign to yourself or to your direct subordinates — to request work from anyone else (peers, your manager, or agents elsewhere in the org), use create_comment with @<agent-slug> on a relevant ticket instead. In title/description, reference teammates with @<agent-slug>. Reference tickets, KB docs, and project docs by their bare identifier/filename (e.g. OP-42, coding-standards.md, spec.md) — no @ prefix. Do not wrap any of these in backticks — that makes them inert.',
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
			parent_issue_id: z
				.string()
				.optional()
				.describe(
					'Parent issue ID (creates a sub-issue). Sub-issues can themselves have sub-issues, but no deeper — depth is capped at 2.',
				),
			runtime_type: z
				.string()
				.optional()
				.describe(
					'Pin this issue to a specific AI runtime (claude_code, codex, gemini). Leave unset to use the instance default.',
				),
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

			const opsCheck = await assertOperationsAssignee(
				db,
				args.company_id as string,
				args.project_id as string,
				assigneeId,
			);
			if (!opsCheck.ok) return { error: opsCheck.message };

			if (auth.type === AuthType.Agent) {
				const hierarchyCheck = await assertSubordinateAssignee(db, auth.memberId, assigneeId);
				if (!hierarchyCheck.ok) return { error: hierarchyCheck.message };
			}

			if (args.parent_issue_id) {
				const depthCheck = await assertChildDepthAllowed(
					db,
					args.company_id as string,
					args.parent_issue_id as string,
				);
				if (!depthCheck.ok) return { error: depthCheck.message };
			}

			const { number: num, identifier } = await allocateIssueIdentifier(
				db,
				args.project_id as string,
			);
			const createdByRunId = auth.type === AuthType.Agent ? auth.runId : null;
			const r = await db.query<{ id: string }>(
				`INSERT INTO issues (company_id, project_id, assignee_id, parent_issue_id, created_by_run_id, number, identifier, title, description, status, priority, runtime_type)
			 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10::issue_status, $11::issue_priority, $12::agent_runtime) RETURNING *`,
				[
					args.company_id,
					args.project_id,
					assigneeId,
					args.parent_issue_id ?? null,
					createdByRunId,
					num,
					identifier,
					args.title,
					args.description ?? '',
					IssueStatus.Backlog,
					args.priority ?? IssuePriority.Medium,
					args.runtime_type ?? null,
				],
			);

			// Wake the assigned agent
			const isAgent = await db.query('SELECT id FROM member_agents WHERE id = $1', [assigneeId]);
			if (isAgent.rows.length > 0) {
				createWakeup(db, assigneeId, args.company_id as string, WakeupSource.Assignment, {
					issue_id: r.rows[0].id,
				}).catch((e) => log.error('Failed to wake agent:', e));
			}

			if (args.description) {
				const actorMemberId = auth.type === AuthType.Agent ? auth.memberId : null;
				recordIssueLinks(
					db,
					args.company_id as string,
					r.rows[0].id,
					args.description as string,
					actorMemberId,
					wsManager,
				).catch((e) => log.error('Failed to record issue links from description:', e));
			}

			return r.rows[0];
		},
		db,
	);

	tool(
		server,
		'update_issue',
		'Update an issue. Agents can use this to change status (including closing), update progress, set rules, and record branch names. Re-opening a closed issue is board-only — once an issue is `closed` only the board can change its status again. As an agent caller, reassigning is limited to yourself or your direct subordinates; to hand work to a peer or manager use create_comment with @<agent-slug> instead. In description, progress_summary, and rules, reference teammates with @<agent-slug>. Reference tickets, KB docs, and project docs by their bare identifier/filename (e.g. OP-42, coding-standards.md, spec.md) — no @ prefix. Do not wrap any of these in backticks — that makes them inert.',
		{
			company_id: z.string().describe('Company ID'),
			issue_id: z.string().describe('Issue ID'),
			title: z.string().optional().describe('New title'),
			description: z.string().optional().describe('New description'),
			status: z
				.string()
				.optional()
				.describe(
					'New status (backlog, in_progress, review, approved, blocked, done, closed, cancelled). Once an issue is `closed`, only board members can change its status again.',
				),
			priority: z.string().optional().describe('New priority'),
			assignee_id: z.string().optional().describe('New assignee ID'),
			progress_summary: z.string().optional().describe('Progress summary update'),
			rules: z
				.string()
				.optional()
				.describe(
					'How-to-work-on guardrails for this ticket — approach constraints that shape execution (e.g. "run tests before committing", "consult the architect before auth changes"). Not a channel for passing project domain knowledge to other agents; put that in description instead.',
				),
			branch_name: z.string().optional().describe('Git branch name for this issue'),
			runtime_type: z
				.string()
				.optional()
				.describe(
					'Override the AI runtime for this issue (claude_code, codex, gemini). Pass an empty string to clear.',
				),
		},
		async (args, db, auth) => {
			const denied = await verifyCompanyAccess(db, auth, args.company_id as string);
			if (denied) return { error: denied };

			const currentStatusResult = await db.query<{ status: string }>(
				'SELECT status FROM issues WHERE id = $1 AND company_id = $2',
				[args.issue_id, args.company_id],
			);
			const currentStatus = currentStatusResult.rows[0]?.status;

			if (
				args.status !== undefined &&
				auth.type === AuthType.Agent &&
				currentStatus === IssueStatus.Closed
			) {
				return { error: 'Only board members can re-open a closed issue' };
			}

			if (args.status === IssueStatus.Done || args.status === IssueStatus.Closed) {
				const childrenCheck = await assertChildrenAllClosed(
					db,
					args.company_id as string,
					args.issue_id as string,
				);
				if (!childrenCheck.ok) return { error: childrenCheck.message };
			}
			if (args.status === IssueStatus.Done) {
				const callerMemberId = auth.type === AuthType.Agent ? auth.memberId : null;
				const activityCheck = await assertNoOutstandingActivity(
					db,
					args.issue_id as string,
					callerMemberId,
				);
				if (!activityCheck.ok) return { error: activityCheck.message };
			}

			if (args.assignee_id) {
				const issueRow = await db.query<{
					project_id: string;
					assignee_id: string | null;
				}>('SELECT project_id, assignee_id FROM issues WHERE id = $1 AND company_id = $2', [
					args.issue_id,
					args.company_id,
				]);
				const row = issueRow.rows[0];
				if (row) {
					if (args.assignee_id !== row.assignee_id) {
						const activeRunCheck = await assertNoActiveRun(db, args.issue_id as string);
						if (!activeRunCheck.ok) return { error: activeRunCheck.message };
					}
					const opsCheck = await assertOperationsAssignee(
						db,
						args.company_id as string,
						row.project_id,
						args.assignee_id as string,
					);
					if (!opsCheck.ok) return { error: opsCheck.message };

					if (auth.type === AuthType.Agent && args.assignee_id !== row.assignee_id) {
						const hierarchyCheck = await assertSubordinateAssignee(
							db,
							auth.memberId,
							args.assignee_id as string,
						);
						if (!hierarchyCheck.ok) return { error: hierarchyCheck.message };
					}
				}
			}

			const sets: string[] = [];
			const params: unknown[] = [];
			let idx = 1;
			for (const [key, val] of Object.entries(args)) {
				if (['company_id', 'issue_id'].includes(key) || val === undefined) continue;
				if (key === 'status') {
					sets.push(`status = $${idx}::issue_status`);
				} else if (key === 'priority') {
					sets.push(`priority = $${idx}::issue_priority`);
				} else if (key === 'runtime_type') {
					sets.push(`runtime_type = $${idx}::agent_runtime`);
					params.push(val === '' ? null : val);
					idx++;
					continue;
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

			const actorMemberId = auth.type === AuthType.Agent ? auth.memberId : null;

			if (args.description !== undefined) {
				recordIssueLinks(
					db,
					args.company_id as string,
					args.issue_id as string,
					args.description as string,
					actorMemberId,
					wsManager,
				).catch((e) => log.error('Failed to record issue links from description:', e));
			}

			// Trigger status automations (e.g. Coach wakeup on Done) and record the change
			if (args.status && currentStatus) {
				triggerStatusAutomations(
					db,
					args.company_id as string,
					args.issue_id as string,
					currentStatus,
					args.status as string,
					actorMemberId,
					wsManager,
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
				`SELECT m.id, ma.agent_type_id, ma.title, ma.slug,
				        ma.monthly_budget_cents, ma.budget_used_cents, ma.runtime_status, ma.admin_status
				 FROM members m JOIN member_agents ma ON ma.id = m.id WHERE m.company_id = $1 ORDER BY ma.title`,
				[args.company_id],
			);
			return r.rows;
		},
		db,
	);

	tool(
		server,
		'update_hire_proposal',
		'Revise the draft of a pending hire approval. CEO-only. Use this to expand or rewrite the system prompt, adjust role description, budget, heartbeat, or touches_code before board review. All fields are optional — pass only what you want to change.',
		{
			approval_id: z.string().describe('Hire approval ID'),
			title: z.string().optional().describe('Updated role title'),
			role_description: z.string().optional().describe('Updated short role description'),
			system_prompt: z.string().optional().describe('Updated system prompt'),
			default_effort: z
				.string()
				.optional()
				.describe('Updated default effort: minimal, low, medium, high, max'),
			heartbeat_interval_min: z.number().optional().describe('Updated heartbeat interval (min)'),
			monthly_budget_cents: z.number().optional().describe('Updated monthly budget in cents'),
			touches_code: z.boolean().optional().describe('Whether this agent reads/writes repo code'),
		},
		async (args, db, auth) => {
			if (auth.type !== AuthType.Agent) {
				return { error: 'update_hire_proposal is only callable by agents' };
			}
			const caller = await db.query<{ slug: string }>(
				'SELECT slug FROM member_agents WHERE id = $1',
				[auth.memberId],
			);
			if (caller.rows[0]?.slug !== CEO_AGENT_SLUG) {
				return { error: 'Only the CEO can revise hire proposals' };
			}

			const approval = await db.query<{
				id: string;
				company_id: string;
				type: string;
				status: string;
				payload: Record<string, unknown>;
			}>('SELECT id, company_id, type, status, payload FROM approvals WHERE id = $1', [
				args.approval_id,
			]);
			if (approval.rows.length === 0) return { error: 'Approval not found' };

			const row = approval.rows[0];
			if (row.company_id !== auth.companyId) {
				return { error: 'Access denied: company mismatch' };
			}
			if (row.type !== ApprovalType.Hire) {
				return { error: 'Approval is not a hire request' };
			}
			if (row.status !== ApprovalStatus.Pending) {
				return { error: 'Hire approval is already resolved' };
			}

			const patch: Record<string, unknown> = {};
			if (args.title !== undefined) patch.title = (args.title as string).trim();
			if (args.role_description !== undefined) patch.role_description = args.role_description;
			if (args.system_prompt !== undefined) patch.system_prompt = args.system_prompt;
			if (args.default_effort !== undefined) patch.default_effort = args.default_effort;
			if (args.heartbeat_interval_min !== undefined)
				patch.heartbeat_interval_min = args.heartbeat_interval_min;
			if (args.monthly_budget_cents !== undefined)
				patch.monthly_budget_cents = args.monthly_budget_cents;
			if (args.touches_code !== undefined) patch.touches_code = args.touches_code;

			if (Object.keys(patch).length === 0) {
				return { error: 'no fields to update' };
			}

			const updated = await db.query<Record<string, unknown>>(
				`UPDATE approvals SET payload = payload || $1::jsonb
				 WHERE id = $2 RETURNING *`,
				[JSON.stringify(patch), args.approval_id],
			);
			return updated.rows[0] ?? null;
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
			issue_prefix: z
				.string()
				.optional()
				.describe('2–4 uppercase alphanumeric chars; derived from name if omitted'),
		},
		async (args, db, auth) => {
			const denied = await verifyCompanyAccess(db, auth, args.company_id as string);
			if (denied) return { error: denied };
			const slug = (args.name as string)
				.toLowerCase()
				.replace(/[^a-z0-9]+/g, '-')
				.replace(/^-|-$/g, '');
			const prefixResult = await resolveProjectIssuePrefix(
				db,
				args.company_id as string,
				args.issue_prefix as string | undefined,
				args.name as string,
			);
			if (!prefixResult.ok) return { error: prefixResult.message };
			const r = await db.query<{ id: string }>(
				`INSERT INTO projects (company_id, name, slug, issue_prefix, description) VALUES ($1, $2, $3, $4, $5) RETURNING *`,
				[args.company_id, args.name, slug, prefixResult.prefix, args.description ?? ''],
			);
			await db.query(
				'INSERT INTO project_issue_counters (project_id, next_number) VALUES ($1, 1)',
				[r.rows[0].id],
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
				`SELECT ic.*, COALESCE(ma.title, m.display_name, 'Board') AS author_name
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
		'Add a comment to an issue. In content, reference teammates with @<agent-slug>. Reference tickets, KB docs, and project docs by their bare identifier/filename (e.g. OP-42, coding-standards.md, spec.md) — no @ prefix. Do not wrap any of these in backticks — that makes them inert.',
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
			const authorMemberId = auth.type === AuthType.Agent ? auth.memberId : null;
			const content = { text: args.content };
			const r = await db.query<{ id: string }>(
				`INSERT INTO issue_comments (issue_id, author_member_id, content_type, content) VALUES ($1, $2, $3::comment_content_type, $4::jsonb) RETURNING *`,
				[args.issue_id, authorMemberId, CommentContentType.Text, JSON.stringify(content)],
			);
			await fireCommentWakeups({
				db,
				issueId: args.issue_id as string,
				companyId: args.company_id as string,
				commentId: r.rows[0].id,
				content,
				contentType: CommentContentType.Text,
				authorMemberId,
				authorRunId: auth.type === AuthType.Agent ? auth.runId : null,
			});
			recordIssueLinks(
				db,
				args.company_id as string,
				args.issue_id as string,
				args.content as string,
				authorMemberId,
				wsManager,
			).catch((e) => log.error('Failed to record issue links from comment:', e));
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
			const docs = await listDocuments(db, {
				type: DocumentType.KbDoc,
				companyId: args.company_id as string,
			});
			return docs.map((d) => ({
				id: d.id,
				title: d.title,
				slug: d.slug,
				updated_at: d.updated_at,
			}));
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
			return await getDocument(db, {
				type: DocumentType.KbDoc,
				companyId: args.company_id as string,
				slug: args.slug as string,
			});
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

	// System Prompt Management — read: any agent/board in same company; write: coach only
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

			if (auth.type !== AuthType.Agent && auth.type !== AuthType.Board) {
				return { error: 'Access denied' };
			}

			const agent = await db.query<{ title: string; slug: string }>(
				`SELECT ma.title, ma.slug
				 FROM member_agents ma JOIN members m ON m.id = ma.id
				 WHERE ma.id = $1 AND m.company_id = $2`,
				[args.agent_id, args.company_id],
			);
			if (agent.rows.length === 0) return { error: 'Agent not found in this company' };

			const system_prompt = await getAgentSystemPrompt(
				db,
				args.company_id as string,
				args.agent_id as string,
			);
			return { ...agent.rows[0], system_prompt };
		},
		db,
	);

	tool(
		server,
		'update_agent_system_prompt',
		'Apply a system prompt change for an agent. Only the Coach agent can call this. The change is applied immediately and a revision snapshot is stored so the board can restore previous versions.',
		{
			company_id: z.string().describe('Company ID'),
			agent_id: z.string().describe('Target agent member ID'),
			new_system_prompt: z.string().describe('The full updated system prompt'),
			change_summary: z.string().describe('Summary of what changed and why'),
		},
		async (args, db, auth) => {
			const denied = await verifyCompanyAccess(db, auth, args.company_id as string);
			if (denied) return { error: denied };

			if (!(await isCoach(db, auth))) {
				return { error: 'Access denied: only the Coach agent can update system prompts' };
			}

			const agentCheck = await db.query<{ id: string }>(
				`SELECT ma.id FROM member_agents ma JOIN members m ON m.id = ma.id
				 WHERE ma.id = $1 AND m.company_id = $2`,
				[args.agent_id, args.company_id],
			);
			if (agentCheck.rows.length === 0) return { error: 'Agent not found in this company' };

			const callerMemberId = auth.type === AuthType.Agent ? auth.memberId : null;

			const doc = await upsertDocument(db, undefined, {
				scope: {
					type: DocumentType.AgentSystemPrompt,
					companyId: args.company_id as string,
					memberAgentId: args.agent_id as string,
				},
				content: args.new_system_prompt as string,
				changeSummary: args.change_summary as string,
				authorMemberId: callerMemberId,
			});
			return { applied: true, document_id: doc.id };
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
		'Create or update a knowledge base document. In content, reference teammates with @<agent-slug>. Reference tickets, KB docs, and project docs by their bare identifier/filename (e.g. OP-42, coding-standards.md, spec.md) — no @ prefix. Do not wrap any of these in backticks — that makes them inert.',
		{
			company_id: z.string().describe('Company ID'),
			title: z.string().describe('Document title'),
			slug: z.string().describe('URL-safe filename ending in .md (e.g. "coding-standards.md")'),
			content: z.string().describe('Document content (markdown)'),
		},
		async (args, db, auth) => {
			const denied = await verifyCompanyAccess(db, auth, args.company_id as string);
			if (denied) return { error: denied };
			const callerMemberId = auth.type === AuthType.Agent ? auth.memberId : null;
			return await upsertDocument(db, wsManager, {
				scope: {
					type: DocumentType.KbDoc,
					companyId: args.company_id as string,
					slug: args.slug as string,
				},
				title: args.title as string,
				content: args.content as string,
				authorMemberId: callerMemberId,
			});
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
			const docs = await listDocuments(db, {
				type: DocumentType.ProjectDoc,
				companyId: args.company_id as string,
				projectId: args.project_id as string,
			});
			return {
				files: docs.map((d) => ({
					id: d.id,
					filename: d.slug,
					updated_at: d.updated_at,
				})),
			};
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
			const doc = await getDocument(db, {
				type: DocumentType.ProjectDoc,
				companyId: args.company_id as string,
				projectId: args.project_id as string,
				slug: args.filename as string,
			});
			if (!doc) return { error: `File '${args.filename}' not found` };
			return { filename: doc.slug, content: doc.content };
		},
		db,
	);

	tool(
		server,
		'write_project_doc',
		'Write a project documentation file. For high-level project context: PRD, spec, implementation plan, research. In content, reference teammates with @<agent-slug>. Reference tickets, KB docs, and project docs by their bare identifier/filename (e.g. OP-42, coding-standards.md, spec.md) — no @ prefix. Do not wrap any of these in backticks — that makes them inert.',
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
			const doc = await upsertDocument(db, wsManager, {
				scope: {
					type: DocumentType.ProjectDoc,
					companyId: args.company_id as string,
					projectId: args.project_id as string,
					slug: args.filename as string,
				},
				content: args.content as string,
				authorMemberId: callerMemberId,
			});
			return { written: true, id: doc.id, filename: doc.slug };
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

async function isCoach(db: PGlite, auth: AuthInfo): Promise<boolean> {
	if (auth.type !== AuthType.Agent) return false;
	const r = await db.query<{ slug: string }>('SELECT slug FROM member_agents WHERE id = $1', [
		auth.memberId,
	]);
	return r.rows[0]?.slug === COACH_AGENT_SLUG;
}

async function isCeoOfCompany(db: PGlite, auth: AuthInfo, companyId: string): Promise<boolean> {
	if (auth.type !== AuthType.Agent) return false;
	const r = await db.query<{ slug: string }>(
		`SELECT ma.slug FROM member_agents ma
		 JOIN members m ON m.id = ma.id
		 WHERE ma.id = $1 AND m.company_id = $2`,
		[auth.memberId, companyId],
	);
	return r.rows[0]?.slug === CEO_AGENT_SLUG;
}

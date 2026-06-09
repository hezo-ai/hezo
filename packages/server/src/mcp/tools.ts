import { AsyncLocalStorage } from 'node:async_hooks';
import type { PGlite } from '@electric-sql/pglite';
import {
	AgentAdminStatus,
	ApprovalStatus,
	ApprovalType,
	ATTACHMENT_EXTENSIONS,
	ATTACHMENT_MAX_BYTES,
	AuditActorType,
	AuthType,
	CAPTAIN_AGENT_SLUG,
	CommentContentType,
	CredentialInputType,
	CredentialKind,
	DocumentType,
	extensionOf,
	isAgentAuthorableAssetMime,
	isMarkdownDocSlug,
	normalizeAssetFilename,
	ReactionKind,
	TaskStatus,
	WakeupSource,
	wsRoom,
} from '@hezo/shared';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';
import type { MasterKeyManager } from '../crypto/master-key';
import type { DomainEventBus } from '../events/bus';
import { assertNoActiveRun } from '../lib/active-run';
import { isCoach, isVirtualHqMemberInTeam } from '../lib/agent-roles';
import { upsertProjectAsset } from '../lib/asset-name';
import { assertSubordinateAssignee } from '../lib/assignment-hierarchy';
import { trackBackground } from '../lib/background';
import { broadcastRowChange } from '../lib/broadcast';
import { credentialPlaceholder, validateSecretName } from '../lib/credential-placeholder';
import {
	coerceTargetStatusForBlockers,
	reconcileBlockedStatus,
	wakeIfReady,
	wouldCreateCycle,
} from '../lib/dependencies';
import { resolveActorMemberId, resolveTaskId } from '../lib/resolve';
import { assertRunTaskScope } from '../lib/run-scope';
import { deriveSkillSummary } from '../lib/skill-summary';
import { assertChildrenAllClosed, assertNoOutstandingActivity } from '../lib/task-relationships';
import type { AuthInfo } from '../lib/types';
import { logger } from '../logger';
import { resolveProjectTaskPrefix } from '../routes/projects';
import { AGENT_ATTACHMENT_DIR, loadAgentAttachmentsForComments } from '../services/agent-runner';
import {
	AgentSystemPromptError,
	fetchAgentSystemPromptForBatch,
	type SystemPromptMode,
} from '../services/agent-system-prompts';
import { broadcastApprovalChange } from '../services/approval-broadcast';
import { resolveApproval } from '../services/approval-resolve';
import { deleteAsset, readAsset, writeAsset } from '../services/asset-storage';
import { fireCommentWakeups } from '../services/comment-wakeups';
import { enqueueTeamCoherenceReviewTask } from '../services/description-tasks';
import {
	getAgentSystemPrompt,
	getDocument,
	listDocuments,
	upsertDocument,
} from '../services/documents';
import { createProjectWithPlanningTask } from '../services/project-create';
import {
	addCommentReaction,
	loadReactionsForTask,
	removeCommentReaction,
} from '../services/reactions';
import { triggerStatusAutomations } from '../services/task-automation';
import { recordTaskLinks } from '../services/task-events';
import {
	type CreateTaskCaller,
	CreateTaskError,
	type CreateTaskInput,
	createTask,
	TASK_COLUMNS_BARE,
} from '../services/tasks';
import { resolveSystemPrompt } from '../services/template-resolver';
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

// Qualified-column variant of services/tasks.ts TASK_COLUMNS_BARE — prefixes
// every column with the `i.` alias for SELECT ... FROM tasks i JOIN ...
// patterns.
const TASK_COLUMNS = TASK_COLUMNS_BARE.replace(/[A-Za-z_][A-Za-z_0-9]*/g, 'i.$&');

const SKILL_COLUMNS = `id, team_id, name, slug, description, content, source_url,
	content_hash, created_by_member_id, tags, is_active, created_at, updated_at`;

const APPROVAL_COLUMNS = `id, team_id, type, status, requested_by_member_id,
	resolution_note, resolved_at, created_at, payload`;

// Cap MCP tool result payloads at 24 000 bytes — comfortably under the
// Claude Code harness's ~25k-token tool-result limit. Oversized results would
// otherwise be persisted to disk by the harness and become unreadable for the
// agent (the persisted file itself trips the same cap).
export const MCP_RESULT_BYTE_LIMIT = 64_000;

export interface Excerpt {
	excerpt: string | null;
	truncated: boolean;
	length: number;
}

/**
 * Excerpt the leading paragraph of `text`, capped at `maxChars` with a
 * word-boundary cut. Returns `null` excerpt for null/empty input.
 */
export function excerpt(text: string | null | undefined, maxChars: number): Excerpt {
	if (text == null) return { excerpt: null, truncated: false, length: 0 };
	const length = text.length;
	if (length === 0) return { excerpt: '', truncated: false, length: 0 };
	const firstPara = text.split(/\n\s*\n/, 1)[0] ?? text;
	if (firstPara.length <= maxChars) {
		return { excerpt: firstPara, truncated: firstPara !== text, length };
	}
	const slice = firstPara.slice(0, maxChars);
	const lastSpace = slice.lastIndexOf(' ');
	const cut = lastSpace > maxChars * 0.5 ? slice.slice(0, lastSpace) : slice;
	return { excerpt: cut, truncated: true, length };
}

/**
 * Spread an Excerpt into a row under `<field>_excerpt`/`_truncated`/`_length`.
 */
function applyExcerpt<T extends Record<string, unknown>>(
	row: T,
	field: string,
	maxChars: number,
): T {
	const value = row[field];
	const ex = excerpt(typeof value === 'string' ? value : null, maxChars);
	const next = { ...row } as Record<string, unknown>;
	delete next[field];
	next[`${field}_excerpt`] = ex.excerpt;
	next[`${field}_truncated`] = ex.truncated;
	next[`${field}_length`] = ex.length;
	return next as T;
}

/**
 * Excerpt long string fields inside an approval payload (most importantly the
 * `content` markdown of a skill_proposal). Leaves short fields and non-string
 * fields untouched.
 */
function excerptApprovalPayload<T extends Record<string, unknown>>(row: T, maxChars: number): T {
	const payload = row.payload;
	if (!payload || typeof payload !== 'object') return row;
	const next: Record<string, unknown> = {};
	for (const [key, value] of Object.entries(payload as Record<string, unknown>)) {
		if (typeof value !== 'string' || value.length <= maxChars) {
			next[key] = value;
			continue;
		}
		const ex = excerpt(value, maxChars);
		next[`${key}_excerpt`] = ex.excerpt;
		next[`${key}_truncated`] = ex.truncated;
		next[`${key}_length`] = ex.length;
	}
	return { ...row, payload: next };
}

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
		// Agents reference tickets by their project-scoped identifier (e.g. "TO-8")
		// as readily as by UUID. Normalize the canonical task argument to a UUID
		// once here so every task-scoped tool handler can query tasks.id directly.
		// resolveTaskId returns a UUID input unchanged (no DB round-trip), so this
		// is a no-op for callers that already pass UUIDs.
		if (
			typeof args.task_id === 'string' &&
			args.task_id.length > 0 &&
			typeof args.team_id === 'string' &&
			args.team_id.length > 0
		) {
			const resolved = await resolveTaskId(db, args.team_id, args.task_id);
			if (!resolved) {
				return {
					content: [
						{
							type: 'text' as const,
							text: JSON.stringify({ error: `Task not found: ${args.task_id}` }),
						},
					],
				};
			}
			args.task_id = resolved;
		}
		const result = await handler(args, db, auth);
		const text = JSON.stringify(result, null, 2);
		const sizeBytes = Buffer.byteLength(text, 'utf8');
		if (sizeBytes > MCP_RESULT_BYTE_LIMIT) {
			const guard = JSON.stringify(
				{
					error: 'result_too_large',
					tool: name,
					size_bytes: sizeBytes,
					limit_bytes: MCP_RESULT_BYTE_LIMIT,
					hint: 'Narrow the query — add filters, fetch a single resource via get_*, paginate with `before` (where supported), or pass `excerpt_chars: 300` to truncate long fields.',
				},
				null,
				2,
			);
			return { content: [{ type: 'text' as const, text: guard }] };
		}
		return { content: [{ type: 'text' as const, text }] };
	});
}

const MAX_BATCH_CREATE_TASKS = 50;
const MAX_BATCH_AGENT_SYSTEM_PROMPTS = 50;

async function buildMcpCreateTaskCaller(
	db: PGlite,
	auth: AuthInfo,
	teamId: string,
): Promise<CreateTaskCaller> {
	const actorMemberId = await resolveActorMemberId(db, auth, teamId);
	const caller: CreateTaskCaller = {
		actorType: auth.type === AuthType.Agent ? AuditActorType.Agent : AuditActorType.Admin,
		actorMemberId,
	};
	if (auth.type === AuthType.Agent) {
		caller.agentMemberId = auth.memberId;
		caller.runId = auth.runId;
	}
	return caller;
}

function mcpArgsToCreateTaskInput(args: Record<string, unknown>): CreateTaskInput {
	return {
		project_id: args.project_id as string,
		title: args.title as string,
		description: args.description as string | undefined,
		assignee_id: args.assignee_id as string | undefined,
		assignee_slug: args.assignee_slug as string | undefined,
		parent_task_id: args.parent_task_id as string | undefined,
		priority: args.priority as string | undefined,
		runtime_type: args.runtime_type as string | undefined,
		blocked_by_task_ids: args.blocked_by_task_ids as string[] | undefined,
	};
}

/**
 * Verify the caller has access to the given team_id.
 * Returns an error string if access denied, null if allowed.
 */
async function verifyTeamAccess(
	db: PGlite,
	auth: AuthInfo,
	teamId: string,
): Promise<string | null> {
	if (auth.type === AuthType.ApiKey || auth.type === AuthType.Agent) {
		if (auth.teamId !== teamId) return 'Access denied: team mismatch';
		return null;
	}
	if (auth.type === AuthType.Admin) {
		if (auth.isSuperuser) return null;
		const result = await db.query(
			'SELECT m.id FROM members m JOIN member_users mu ON mu.id = m.id WHERE mu.user_id = $1 AND m.team_id = $2',
			[auth.userId, teamId],
		);
		if (result.rows.length === 0) return 'Access denied: not a member of this team';
		return null;
	}
	return 'Access denied';
}

/**
 * For Agent auth without cross-project privilege, the run is scoped to a single
 * project. Reject any tool call referencing a different project's data. Admin
 * and ApiKey auth pass through — their team-level checks already cover them.
 */
function assertProjectAccess(auth: AuthInfo, projectId: string): string | null {
	if (auth.type !== AuthType.Agent) return null;
	if (auth.crossProject) return null;
	if (auth.projectId !== projectId) return 'Access denied: run is not scoped to this project';
	return null;
}

/**
 * Resolve the task's project and assert scoped access. Used by tools whose
 * input is a task_id rather than a project_id directly.
 */
async function assertProjectAccessForTask(
	db: PGlite,
	auth: AuthInfo,
	taskId: string,
): Promise<string | null> {
	if (auth.type !== AuthType.Agent || auth.crossProject) return null;
	const r = await db.query<{ project_id: string }>('SELECT project_id FROM tasks WHERE id = $1', [
		taskId,
	]);
	const projectId = r.rows[0]?.project_id;
	if (!projectId) return 'Access denied: task not found';
	if (projectId !== auth.projectId) return 'Access denied: run is not scoped to this project';
	return null;
}

export function registerTools(
	server: McpServer,
	db: PGlite,
	dataDir: string,
	masterKeyManager: MasterKeyManager,
	wsManager?: WebSocketManager,
	events?: DomainEventBus,
): ToolDef[] {
	registeredTools.length = 0;

	// Teams
	tool(
		server,
		'list_teams',
		'List teams accessible to the caller',
		{},
		async (_args, db, auth) => {
			if (auth.type === AuthType.ApiKey || auth.type === AuthType.Agent) {
				const r = await db.query('SELECT * FROM teams WHERE id = $1', [auth.teamId]);
				return r.rows;
			}
			if (auth.type === AuthType.Admin) {
				if (auth.isSuperuser) {
					const r = await db.query('SELECT * FROM teams ORDER BY name');
					return r.rows;
				}
				const r = await db.query(
					`SELECT c.* FROM teams c
					 JOIN members m ON m.team_id = c.id
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
		'get_team',
		'Get a team by ID',
		{
			team_id: z.string().describe('Team ID'),
		},
		async (args, db, auth) => {
			const denied = await verifyTeamAccess(db, auth, args.team_id as string);
			if (denied) return { error: denied };
			const r = await db.query('SELECT * FROM teams WHERE id = $1', [args.team_id]);
			return r.rows[0] ?? null;
		},
		db,
	);

	tool(
		server,
		'create_team',
		'Create a new team (superuser only)',
		{
			name: z.string().describe('Team name'),
			description: z.string().optional().describe('Team description'),
		},
		async (args, db, auth) => {
			if (auth.type !== AuthType.Admin || !auth.isSuperuser) {
				return { error: 'Access denied: superuser required' };
			}
			const slug = (args.name as string)
				.toLowerCase()
				.replace(/[^a-z0-9]+/g, '-')
				.replace(/^-|-$/g, '');
			const r = await db.query(
				`INSERT INTO teams (name, slug, description) VALUES ($1, $2, $3) RETURNING *`,
				[args.name, slug, args.description ?? ''],
			);
			return r.rows[0];
		},
		db,
	);

	// Tasks
	tool(
		server,
		'list_tasks',
		'List tasks for a team. Returns up to 50 tasks ordered by creation date (newest first). Filter by project_id to scope to one project (the common case), and optionally by status (comma-separated) or assignee_id/assignee_slug to narrow further. The Project State block in your system prompt already gives you the active tickets in the current project — only call this if you need older or terminal tickets, a different project, or a specific status filter. Pass excerpt_chars (e.g. 300) to truncate description and rules to triage-sized excerpts; omit for full content.',
		{
			team_id: z.string().describe('Team ID'),
			project_id: z.string().optional().describe('Filter by project ID'),
			status: z.string().optional().describe('Filter by status (comma-separated)'),
			assignee_id: z.string().optional().describe('Filter by assignee member ID'),
			assignee_slug: z
				.string()
				.optional()
				.describe('Filter by assignee agent slug (alternative to assignee_id)'),
			excerpt_chars: z
				.number()
				.int()
				.positive()
				.optional()
				.describe(
					'When set, replaces description and rules with first-paragraph excerpts capped at this many characters, plus _truncated and _length companion fields',
				),
		},
		async (args, db, auth) => {
			const denied = await verifyTeamAccess(db, auth, args.team_id as string);
			if (denied) return { error: denied };
			const conditions = ['i.team_id = $1'];
			const params: unknown[] = [args.team_id];
			let idx = 2;
			if (args.project_id) {
				const pDenied = assertProjectAccess(auth, args.project_id as string);
				if (pDenied) return { error: pDenied };
				conditions.push(`i.project_id = $${idx}`);
				params.push(args.project_id);
				idx++;
			} else if (auth.type === AuthType.Agent && !auth.crossProject) {
				conditions.push(`i.project_id = $${idx}`);
				params.push(auth.projectId);
				idx++;
			}
			if (args.status) {
				const statuses = (args.status as string).split(',');
				const ph = statuses.map((_, i) => `$${idx + i}::task_status`).join(', ');
				conditions.push(`i.status IN (${ph})`);
				params.push(...statuses);
				idx += statuses.length;
			}
			let assigneeId = args.assignee_id as string | undefined;
			if (!assigneeId && args.assignee_slug) {
				const agent = await db.query<{ id: string }>(
					`SELECT ma.id FROM member_agents ma
					 JOIN members m ON m.id = ma.id
					 WHERE ma.slug = $1 AND m.team_id = $2`,
					[args.assignee_slug, args.team_id],
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
				`SELECT ${TASK_COLUMNS}, p.name AS project_name
				 FROM tasks i JOIN projects p ON p.id = i.project_id
				 WHERE ${conditions.join(' AND ')}
				 ORDER BY i.created_at DESC LIMIT 50`,
				params,
			);
			const max = args.excerpt_chars as number | undefined;
			if (max == null) return r.rows;
			return r.rows.map((row) => {
				let next = applyExcerpt(row as Record<string, unknown>, 'description', max);
				next = applyExcerpt(next, 'rules', max);
				return next;
			});
		},
		db,
	);

	tool(
		server,
		'get_task',
		"Get task details, including the ticket's declared blockers (upstream — what this ticket is waiting on) and dependents (downstream — tickets that are blocked on this one). Each entry has identifier, title, and current status. A non-empty blockers list means an automatic agent run on this ticket is paused until every blocker reaches a terminal status (done, closed, cancelled). The dependents list shows which teammates' tickets will be auto-unblocked when this ticket is marked terminal — you do not need to @-mention them, the auto-wake handles it.",
		{
			team_id: z.string().describe('Team ID'),
			task_id: z.string().describe('Task ID'),
		},
		async (args, db, auth) => {
			const denied = await verifyTeamAccess(db, auth, args.team_id as string);
			if (denied) return { error: denied };
			const r = await db.query<Record<string, unknown> & { project_id: string }>(
				`SELECT ${TASK_COLUMNS_BARE} FROM tasks i WHERE i.id = $1 AND i.team_id = $2`,
				[args.task_id, args.team_id],
			);
			const task = r.rows[0];
			if (!task) return null;
			const pDenied = assertProjectAccess(auth, task.project_id);
			if (pDenied) return { error: pDenied };
			const blockers = await db.query(
				`SELECT d.id AS dependency_id, b.id, b.identifier, b.title, b.status::text AS status
				 FROM task_dependencies d
				 JOIN tasks b ON b.id = d.blocked_by_task_id
				 WHERE d.task_id = $1
				 ORDER BY d.created_at ASC`,
				[args.task_id],
			);
			const dependents = await db.query(
				`SELECT d.id AS dependency_id, b.id, b.identifier, b.title, b.status::text AS status
				 FROM task_dependencies d
				 JOIN tasks b ON b.id = d.task_id
				 WHERE d.blocked_by_task_id = $1
				 ORDER BY d.created_at ASC`,
				[args.task_id],
			);
			return {
				...(task as Record<string, unknown>),
				blockers: blockers.rows,
				dependents: dependents.rows,
			};
		},
		db,
	);

	tool(
		server,
		'create_task',
		'Create a new task. Use parent_task_id for sub-tasks — prefer this over a top-level ticket whenever the new work is part of the ticket you are on. Sub-tasks themselves can have sub-tasks, but no deeper (depth is capped at 2). Use assignee_slug as alternative to assignee_id. As an agent caller, you may only assign to yourself or to your direct subordinates — to request work from anyone else (peers, your manager, or agents elsewhere in the org), use create_comment with @<agent-slug> on a relevant ticket instead. Use blocked_by_task_ids to declare prerequisites — the assignee will not be woken on this ticket until every blocker reaches a terminal status (done, closed, cancelled). In title/description, reference teammates with @<agent-slug>. Reference tickets and project docs by their bare identifier/filename (e.g. IN-42, spec.md), and skills by their slug — no @ prefix. Do not wrap any of these in backticks — that makes them inert.',
		{
			team_id: z.string().describe('Team ID'),
			project_id: z.string().describe('Project ID'),
			title: z.string().describe('Task title'),
			description: z.string().optional().describe('Task description'),
			priority: z.string().optional().describe('Priority: low, medium, high, urgent'),
			assignee_id: z.string().optional().describe('Assignee member ID'),
			assignee_slug: z
				.string()
				.optional()
				.describe('Assignee agent slug (alternative to assignee_id)'),
			parent_task_id: z
				.string()
				.optional()
				.describe(
					'Parent task ID (creates a sub-task). Sub-tasks can themselves have sub-tasks, but no deeper — depth is capped at 2.',
				),
			runtime_type: z
				.string()
				.optional()
				.describe(
					'Pin this task to a specific AI runtime (claude_code, codex, gemini). Leave unset to use the instance default.',
				),
			blocked_by_task_ids: z
				.array(z.string())
				.optional()
				.describe(
					'Task identifiers (e.g. ["BE-2", "BE-3"]) or UUIDs that must reach a terminal status before this ticket is started. The assignee will not be woken on this ticket until every blocker is satisfied.',
				),
		},
		async (args, db, auth) => {
			const denied = await verifyTeamAccess(db, auth, args.team_id as string);
			if (denied) return { error: denied };
			const pDenied = assertProjectAccess(auth, args.project_id as string);
			if (pDenied) return { error: pDenied };

			const teamId = args.team_id as string;
			const caller = await buildMcpCreateTaskCaller(db, auth, teamId);
			try {
				return await createTask(
					db,
					teamId,
					mcpArgsToCreateTaskInput(args),
					caller,
					wsManager,
					events,
				);
			} catch (e) {
				if (e instanceof CreateTaskError) return { error: e.message };
				throw e;
			}
		},
		db,
	);

	tool(
		server,
		'create_tasks',
		`Create multiple tasks in one call (max ${MAX_BATCH_CREATE_TASKS}). Each item has the same shape as create_task; per-item errors are returned without aborting the rest. Use this when filing a related set of tickets in one go (planning a feature, splitting a project into sub-tasks). For a single task, use create_task.`,
		{
			team_id: z.string().describe('Team ID'),
			items: z
				.array(
					z.object({
						project_id: z.string().describe('Project ID'),
						title: z.string().describe('Task title'),
						description: z.string().optional().describe('Task description'),
						priority: z.string().optional().describe('Priority: low, medium, high, urgent'),
						assignee_id: z.string().optional().describe('Assignee member ID'),
						assignee_slug: z
							.string()
							.optional()
							.describe('Assignee agent slug (alternative to assignee_id)'),
						parent_task_id: z
							.string()
							.optional()
							.describe(
								'Parent task ID (creates a sub-task). Sub-tasks can themselves have sub-tasks, but no deeper — depth is capped at 2.',
							),
						runtime_type: z
							.string()
							.optional()
							.describe(
								'Pin this task to a specific AI runtime (claude_code, codex, gemini). Leave unset to use the instance default.',
							),
						blocked_by_task_ids: z
							.array(z.string())
							.optional()
							.describe(
								'Task identifiers (e.g. ["BE-2"]) or UUIDs that must reach a terminal status before this ticket is started.',
							),
					}),
				)
				.min(1)
				.max(MAX_BATCH_CREATE_TASKS)
				.describe(`Up to ${MAX_BATCH_CREATE_TASKS} items.`),
		},
		async (args, db, auth) => {
			const teamId = args.team_id as string;
			const denied = await verifyTeamAccess(db, auth, teamId);
			if (denied) return { error: denied };

			const items = args.items as Array<Record<string, unknown>>;
			const caller = await buildMcpCreateTaskCaller(db, auth, teamId);

			const results = await Promise.all(
				items.map(async (item, index) => {
					const pDenied = assertProjectAccess(auth, item.project_id as string);
					if (pDenied) {
						return { index, ok: false as const, error: pDenied, code: 'FORBIDDEN' as const };
					}
					try {
						const task = await createTask(
							db,
							teamId,
							mcpArgsToCreateTaskInput(item),
							caller,
							wsManager,
							events,
						);
						return { index, ok: true as const, task };
					} catch (e) {
						if (e instanceof CreateTaskError) {
							return { index, ok: false as const, error: e.message, code: e.code };
						}
						log.error('Unexpected error in create_tasks batch:', e);
						return {
							index,
							ok: false as const,
							error: e instanceof Error ? e.message : 'internal_error',
							code: 'INTERNAL_ERROR' as const,
						};
					}
				}),
			);
			return results;
		},
		db,
	);

	tool(
		server,
		'update_task',
		'Update an task. Agents can use this to change status, update progress, set rules, and record branch names. To finish a ticket, set status to `done` — that wakes Coach for review, who will set the ticket to `closed` after the review passes. Agents other than Coach cannot set status to `closed` directly. Re-opening a closed task is admin-only. As an agent caller, reassigning is limited to yourself or your direct subordinates; to hand work to a peer or manager use create_comment with @<agent-slug> instead. In description, progress_summary, and rules, reference teammates with @<agent-slug>. Reference tickets and project docs by their bare identifier/filename (e.g. IN-42, spec.md), and skills by their slug — no @ prefix. Do not wrap any of these in backticks — that makes them inert.',
		{
			team_id: z.string().describe('Team ID'),
			task_id: z.string().describe('Task ID'),
			title: z.string().optional().describe('New title'),
			description: z.string().optional().describe('New description'),
			status: z
				.string()
				.optional()
				.describe(
					'New status (backlog, in_progress, review, blocked, done, cancelled). To finish a ticket, set `done` — Coach will review and set it to `closed`. Setting `closed` directly is reserved for Coach. Once a task is `closed`, only the admin can change its status again.',
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
			branch_name: z.string().optional().describe('Git branch name for this task'),
			runtime_type: z
				.string()
				.optional()
				.describe(
					'Override the AI runtime for this task (claude_code, codex, gemini). Pass an empty string to clear.',
				),
		},
		async (args, db, auth) => {
			const denied = await verifyTeamAccess(db, auth, args.team_id as string);
			if (denied) return { error: denied };

			const currentRowResult = await db.query<{
				status: string;
				assignee_id: string | null;
				project_id: string;
			}>('SELECT status, assignee_id, project_id FROM tasks WHERE id = $1 AND team_id = $2', [
				args.task_id,
				args.team_id,
			]);
			const currentRow = currentRowResult.rows[0];
			if (currentRow) {
				const pDenied = assertProjectAccess(auth, currentRow.project_id);
				if (pDenied) return { error: pDenied };
			}

			const scopeDenied = assertRunTaskScope(
				auth,
				args.task_id as string,
				args.status as string | undefined,
			);
			if (scopeDenied) return { error: scopeDenied };

			const currentStatus = currentRow?.status;
			const previousAssigneeId = currentRow?.assignee_id ?? null;

			if (
				args.status !== undefined &&
				auth.type === AuthType.Agent &&
				currentStatus === TaskStatus.Closed
			) {
				return { error: 'Only the admin can re-open a closed task' };
			}

			if (
				args.status === TaskStatus.Closed &&
				auth.type === AuthType.Agent &&
				!(await isCoach(db, auth))
			) {
				return {
					error:
						'Only Coach can set status to "closed". Set status to "done" and Coach will close the task after review.',
				};
			}

			if (args.status === TaskStatus.Done || args.status === TaskStatus.Closed) {
				const childrenCheck = await assertChildrenAllClosed(
					db,
					args.team_id as string,
					args.task_id as string,
				);
				if (!childrenCheck.ok) return { error: childrenCheck.message };
			}
			if (args.status === TaskStatus.Done) {
				const callerMemberId = auth.type === AuthType.Agent ? auth.memberId : null;
				const activityCheck = await assertNoOutstandingActivity(
					db,
					args.task_id as string,
					callerMemberId,
				);
				if (!activityCheck.ok) return { error: activityCheck.message };
			}

			if (args.status !== undefined) {
				args.status = await coerceTargetStatusForBlockers(
					db,
					args.task_id as string,
					args.status as string,
				);
			}

			if (args.assignee_id && currentRow) {
				if (args.assignee_id !== previousAssigneeId) {
					const activeRunCheck = await assertNoActiveRun(db, args.task_id as string);
					if (!activeRunCheck.ok) return { error: activeRunCheck.message };
				}
				if (auth.type === AuthType.Agent && args.assignee_id !== previousAssigneeId) {
					const hierarchyCheck = await assertSubordinateAssignee(
						db,
						auth.memberId,
						args.assignee_id as string,
					);
					if (!hierarchyCheck.ok) return { error: hierarchyCheck.message };
				}
			}

			const sets: string[] = [];
			const params: unknown[] = [];
			let idx = 1;
			for (const [key, val] of Object.entries(args)) {
				if (['team_id', 'task_id'].includes(key) || val === undefined) continue;
				if (key === 'status') {
					sets.push(`status = $${idx}::task_status`);
				} else if (key === 'priority') {
					sets.push(`priority = $${idx}::task_priority`);
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
			params.push(args.task_id, args.team_id);
			const r = await db.query(
				`UPDATE tasks SET ${sets.join(', ')} WHERE id = $${idx} AND team_id = $${idx + 1} RETURNING ${TASK_COLUMNS_BARE}`,
				params,
			);
			if (!r.rows[0]) return null;

			const actorMemberId = auth.type === AuthType.Agent ? auth.memberId : null;

			if (args.description !== undefined) {
				trackBackground(
					recordTaskLinks(
						db,
						args.team_id as string,
						args.task_id as string,
						args.description as string,
						actorMemberId,
						wsManager,
					).catch((e) => log.error('Failed to record task links from description:', e)),
				);
			}

			if (args.status && currentStatus) {
				try {
					await triggerStatusAutomations(
						db,
						args.team_id as string,
						args.task_id as string,
						currentStatus,
						args.status as string,
						actorMemberId,
						wsManager,
					);
				} catch (e) {
					log.error('Failed to trigger status automations:', e);
				}
			}

			if (args.assignee_id && args.assignee_id !== previousAssigneeId) {
				const isAgent = await db.query('SELECT id FROM member_agents WHERE id = $1', [
					args.assignee_id,
				]);
				if (isAgent.rows.length > 0) {
					trackBackground(
						createWakeup(
							db,
							args.assignee_id as string,
							args.team_id as string,
							WakeupSource.Assignment,
							{
								task_id: args.task_id,
							},
						).catch((e) => log.error('Failed to wake agent:', e)),
					);
				}
			}

			return r.rows[0];
		},
		db,
	);

	tool(
		server,
		'add_task_blocker',
		'Declare that one task blocks another. The downstream ticket will not start an automatic agent run until the blocker reaches a terminal status (done, closed, cancelled). Use this when you discover that a ticket you have been woken on depends on work that has not landed yet — declare the blocker and end your turn; the system will wake you again when the blocker resolves. Cycles are rejected.',
		{
			team_id: z.string().describe('Team ID'),
			task_id: z.string().describe('Task identifier or UUID that should be blocked'),
			blocked_by_task_id: z.string().describe('Task identifier or UUID of the upstream blocker'),
		},
		async (args, db, auth) => {
			const denied = await verifyTeamAccess(db, auth, args.team_id as string);
			if (denied) return { error: denied };
			const teamId = args.team_id as string;
			const taskId = args.task_id as string;
			const taskScope = await assertProjectAccessForTask(db, auth, taskId);
			if (taskScope) return { error: taskScope };
			const blockerId = await resolveTaskId(db, teamId, args.blocked_by_task_id as string);
			if (!blockerId) return { error: 'Blocking task not found in this team' };
			const blockerScope = await assertProjectAccessForTask(db, auth, blockerId);
			if (blockerScope) return { error: blockerScope };
			if (blockerId === taskId) return { error: 'An task cannot block itself' };
			if (await wouldCreateCycle(db, taskId, blockerId)) {
				return { error: 'Dependency would create a cycle' };
			}
			const r = await db.query(
				`INSERT INTO task_dependencies (task_id, blocked_by_task_id)
				 VALUES ($1, $2) ON CONFLICT DO NOTHING
				 RETURNING id, task_id, blocked_by_task_id, created_at`,
				[taskId, blockerId],
			);
			if (r.rows.length === 0) return { error: 'Dependency already exists' };
			const actorMemberId = auth.type === AuthType.Agent ? auth.memberId : null;
			await reconcileBlockedStatus(db, teamId, taskId, actorMemberId, wsManager);
			return r.rows[0];
		},
		db,
	);

	tool(
		server,
		'remove_task_blocker',
		"Remove a blocker between two tasks. Call this when a dependency that was previously declared no longer applies. If removing this dependency clears the downstream ticket's last open blocker, its assignee is woken automatically.",
		{
			team_id: z.string().describe('Team ID'),
			task_id: z.string().describe('Task identifier or UUID that is currently blocked'),
			blocked_by_task_id: z.string().describe('Task identifier or UUID of the blocker to remove'),
		},
		async (args, db, auth) => {
			const denied = await verifyTeamAccess(db, auth, args.team_id as string);
			if (denied) return { error: denied };
			const teamId = args.team_id as string;
			const taskId = args.task_id as string;
			const taskScope = await assertProjectAccessForTask(db, auth, taskId);
			if (taskScope) return { error: taskScope };
			const blockerId = await resolveTaskId(db, teamId, args.blocked_by_task_id as string);
			if (!blockerId) return { error: 'Blocking task not found' };
			const r = await db.query(
				'DELETE FROM task_dependencies WHERE task_id = $1 AND blocked_by_task_id = $2 RETURNING id',
				[taskId, blockerId],
			);
			if (r.rows.length === 0) return { error: 'Dependency not found' };
			const actorMemberId = auth.type === AuthType.Agent ? auth.memberId : null;
			await reconcileBlockedStatus(db, teamId, taskId, actorMemberId, wsManager);
			await wakeIfReady(db, taskId);
			return { removed: true };
		},
		db,
	);

	// Agents
	tool(
		server,
		'list_agents',
		'List agents for a team',
		{
			team_id: z.string().describe('Team ID'),
		},
		async (args, db, auth) => {
			const denied = await verifyTeamAccess(db, auth, args.team_id as string);
			if (denied) return { error: denied };
			const r = await db.query(
				`SELECT m.id, ma.agent_type_id, ma.title, ma.slug,
				        ma.monthly_budget_cents, ma.budget_used_cents, ma.runtime_status, ma.admin_status
				 FROM members m JOIN member_agents ma ON ma.id = m.id WHERE m.team_id = $1 ORDER BY ma.title`,
				[args.team_id],
			);
			return r.rows;
		},
		db,
	);

	tool(
		server,
		'update_hire_proposal',
		'Revise the draft of a pending hire approval. Captain-only. Use this to expand or rewrite the system prompt, adjust role description, budget, heartbeat, or touches_code before admin review. All fields are optional — pass only what you want to change.',
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
			if (caller.rows[0]?.slug !== CAPTAIN_AGENT_SLUG) {
				return { error: 'Only the Captain can revise hire proposals' };
			}

			const approval = await db.query<{
				id: string;
				team_id: string;
				type: string;
				status: string;
				payload: Record<string, unknown>;
			}>('SELECT id, team_id, type, status, payload FROM approvals WHERE id = $1', [
				args.approval_id,
			]);
			if (approval.rows.length === 0) return { error: 'Approval not found' };

			const row = approval.rows[0];
			if (row.team_id !== auth.teamId) {
				return { error: 'Access denied: team mismatch' };
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
				 WHERE id = $2 RETURNING ${APPROVAL_COLUMNS}`,
				[JSON.stringify(patch), args.approval_id],
			);
			return updated.rows[0] ?? null;
		},
		db,
	);

	tool(
		server,
		'update_project_creation_proposal',
		'Revise the draft of a pending project_creation approval. Captain-only. Use this to refine the name, description, task_prefix, or initial_prd as the intake conversation evolves. All fields are optional — pass only what you want to change.',
		{
			approval_id: z.string().describe('project_creation approval ID'),
			name: z.string().optional().describe('Updated project name'),
			description: z.string().optional().describe('Updated project description'),
			task_prefix: z.string().optional().describe('Updated 2-4 char task prefix'),
			initial_prd: z
				.string()
				.nullable()
				.optional()
				.describe('Updated initial PRD markdown text. Pass null to clear.'),
		},
		async (args, db, auth) => {
			if (auth.type !== AuthType.Agent) {
				return { error: 'update_project_creation_proposal is only callable by agents' };
			}
			const caller = await db.query<{ slug: string }>(
				'SELECT slug FROM member_agents WHERE id = $1',
				[auth.memberId],
			);
			if (caller.rows[0]?.slug !== CAPTAIN_AGENT_SLUG) {
				return { error: 'Only the Captain can revise project creation proposals' };
			}

			const approval = await db.query<{
				id: string;
				team_id: string;
				type: string;
				status: string;
				payload: Record<string, unknown>;
			}>('SELECT id, team_id, type, status, payload FROM approvals WHERE id = $1', [
				args.approval_id,
			]);
			if (approval.rows.length === 0) return { error: 'Approval not found' };

			const row = approval.rows[0];
			if (row.team_id !== auth.teamId) {
				return { error: 'Access denied: team mismatch' };
			}
			if (row.type !== ApprovalType.ProjectCreation) {
				return { error: 'Approval is not a project creation request' };
			}
			if (row.status !== ApprovalStatus.Pending) {
				return { error: 'Project creation approval is already resolved' };
			}

			const patch: Record<string, unknown> = {};
			if (args.name !== undefined) {
				const trimmed = (args.name as string).trim();
				if (!trimmed) return { error: 'name cannot be empty' };
				patch.name = trimmed;
			}
			if (args.description !== undefined) {
				const trimmed = (args.description as string).trim();
				if (!trimmed) return { error: 'description cannot be empty' };
				patch.description = trimmed;
			}
			if (args.task_prefix !== undefined) {
				patch.task_prefix = (args.task_prefix as string).trim().toUpperCase();
			}
			if (args.initial_prd !== undefined) {
				patch.initial_prd =
					args.initial_prd === null ? null : (args.initial_prd as string).trim() || null;
			}

			if (Object.keys(patch).length === 0) {
				return { error: 'no fields to update' };
			}

			if (patch.name !== undefined || patch.task_prefix !== undefined) {
				const candidateName = (patch.name ?? row.payload.name) as string;
				const candidatePrefix =
					patch.task_prefix !== undefined ? (patch.task_prefix as string) : undefined;
				const prefixResult = await resolveProjectTaskPrefix(
					db,
					row.team_id,
					candidatePrefix,
					candidateName,
				);
				if (!prefixResult.ok) {
					return { error: prefixResult.message };
				}
				patch.task_prefix = prefixResult.prefix;
			}

			const updated = await db.query<Record<string, unknown>>(
				`UPDATE approvals SET payload = payload || $1::jsonb
				 WHERE id = $2 RETURNING ${APPROVAL_COLUMNS}`,
				[JSON.stringify(patch), args.approval_id],
			);
			return updated.rows[0] ?? null;
		},
		db,
	);

	tool(
		server,
		'list_team_templates',
		'List team templates (built-in Startup for software development, Blank, and custom). Use when recommending a team structure to hire.',
		{
			team_id: z.string().describe('Team ID'),
		},
		async (args, db, auth) => {
			const denied = await verifyTeamAccess(db, auth, args.team_id as string);
			if (denied) return { error: denied };
			const r = await db.query<{
				id: string;
				name: string;
				description: string;
				is_builtin: boolean;
				agent_types: Array<{ slug: string; name: string; role_description: string }>;
			}>(
				`SELECT ct.id, ct.name, ct.description, ct.is_builtin,
				    COALESCE(
				        json_agg(json_build_object(
				            'slug', at.slug,
				            'name', at.name,
				            'role_description', at.role_description
				        ) ORDER BY ctat.sort_order) FILTER (WHERE at.id IS NOT NULL),
				        '[]'
				    ) AS agent_types
				 FROM team_templates ct
				 LEFT JOIN team_template_agent_types ctat ON ctat.team_template_id = ct.id
				 LEFT JOIN agent_types at ON at.id = ctat.agent_type_id
				 GROUP BY ct.id
				 ORDER BY ct.is_builtin DESC, ct.name ASC`,
			);
			return r.rows;
		},
		db,
	);

	// Projects
	tool(
		server,
		'list_projects',
		'List projects for a team. Pass excerpt_chars (e.g. 300) to truncate description; omit for full content.',
		{
			team_id: z.string().describe('Team ID'),
			excerpt_chars: z
				.number()
				.int()
				.positive()
				.optional()
				.describe('When set, truncates description and adds description_truncated/_length'),
		},
		async (args, db, auth) => {
			const denied = await verifyTeamAccess(db, auth, args.team_id as string);
			if (denied) return { error: denied };
			const scoped = auth.type === AuthType.Agent && !auth.crossProject;
			const r = await db.query<Record<string, unknown>>(
				scoped
					? `SELECT id, team_id, name, slug, task_prefix, description, created_at, updated_at
					 FROM projects WHERE team_id = $1 AND id = $2`
					: `SELECT id, team_id, name, slug, task_prefix, description, created_at, updated_at
					 FROM projects WHERE team_id = $1 ORDER BY name`,
				scoped ? [args.team_id, auth.projectId] : [args.team_id],
			);
			const max = args.excerpt_chars as number | undefined;
			if (max == null) return r.rows;
			return r.rows.map((row) => applyExcerpt(row, 'description', max));
		},
		db,
	);

	tool(
		server,
		'create_project',
		'Create a new project',
		{
			team_id: z.string().describe('Team ID'),
			name: z.string().describe('Project name'),
			description: z.string().optional().describe('Project description'),
			task_prefix: z
				.string()
				.optional()
				.describe('2–4 uppercase alphanumeric chars; derived from name if omitted'),
		},
		async (args, db, auth) => {
			const teamId = args.team_id as string;
			const denied = await verifyTeamAccess(db, auth, teamId);
			if (denied) return { error: denied };
			if (auth.type === AuthType.Agent && !auth.crossProject) {
				return { error: 'Access denied: run is not scoped to create projects' };
			}

			const captainResult = await db.query<{ id: string }>(
				`SELECT ma.id FROM member_agents ma
				 JOIN members m ON m.id = ma.id
				 WHERE m.team_id = $1 AND ma.slug = $3 AND ma.admin_status = $2::agent_admin_status
				 LIMIT 1`,
				[teamId, AgentAdminStatus.Enabled, CAPTAIN_AGENT_SLUG],
			);
			const captainMemberId = captainResult.rows[0]?.id;
			if (!captainMemberId) {
				return { error: 'No enabled Captain found for this team' };
			}

			const slug = (args.name as string)
				.toLowerCase()
				.replace(/[^a-z0-9]+/g, '-')
				.replace(/^-|-$/g, '');
			const prefixResult = await resolveProjectTaskPrefix(
				db,
				teamId,
				args.task_prefix as string | undefined,
				args.name as string,
			);
			if (!prefixResult.ok) return { error: prefixResult.message };

			const { project, planningTask, deferCaptainPlanningWake } =
				await createProjectWithPlanningTask(db, {
					teamId,
					captainMemberId,
					name: args.name as string,
					slug,
					taskPrefix: prefixResult.prefix,
					description: (args.description as string | undefined) ?? '',
					events,
					actorType: auth.type === AuthType.Agent ? AuditActorType.Agent : AuditActorType.Admin,
					actorMemberId: auth.type === AuthType.Agent ? auth.memberId : null,
				});

			broadcastRowChange(wsManager, wsRoom.team(teamId), 'projects', 'INSERT', project);
			broadcastRowChange(wsManager, wsRoom.team(teamId), 'tasks', 'INSERT', planningTask);

			if (!deferCaptainPlanningWake) {
				await createWakeup(db, captainMemberId, teamId, WakeupSource.Assignment, {
					task_id: planningTask.id,
				});
			}

			return {
				...project,
				planning_task_id: planningTask.id,
				planning_task_identifier: planningTask.identifier,
			};
		},
		db,
	);

	// Comments
	tool(
		server,
		'list_comments',
		"List comments for an task. Returns up to 50 most-recent comments (newest first). Pass before (a comment ID) to walk older. Pass excerpt_chars (e.g. 500) to truncate long text comments; structured comments (system/option/task_link) are always returned whole. Each row includes parent_comment_id (UUID or null) so you can see reply threading — when you reply substantively to a comment, pass that comment's id back as parent_comment_id in create_comment.",
		{
			team_id: z.string().describe('Team ID'),
			task_id: z.string().describe('Task ID'),
			before: z
				.string()
				.optional()
				.describe('Comment ID — return only comments created before this one'),
			excerpt_chars: z
				.number()
				.int()
				.positive()
				.optional()
				.describe(
					'When set, truncates content.text on text-typed comments to this many characters and adds text_truncated/text_length',
				),
		},
		async (args, db, auth) => {
			const denied = await verifyTeamAccess(db, auth, args.team_id as string);
			if (denied) return { error: denied };
			const taskCheck = await db.query<{ project_id: string }>(
				'SELECT project_id FROM tasks WHERE id = $1 AND team_id = $2',
				[args.task_id, args.team_id],
			);
			if (taskCheck.rows.length === 0) return { error: 'Task not found in this team' };
			const pDenied = assertProjectAccess(auth, taskCheck.rows[0].project_id);
			if (pDenied) return { error: pDenied };
			const conditions = ['ic.task_id = $1'];
			const params: unknown[] = [args.task_id];
			if (args.before) {
				params.push(args.before);
				conditions.push(
					`(ic.created_at, ic.id) < (SELECT created_at, id FROM task_comments WHERE id = $${params.length})`,
				);
			}
			const r = await db.query<Record<string, unknown>>(
				`SELECT ic.id, ic.task_id, ic.author_member_id, ic.parent_comment_id,
				        ic.content_type, ic.content, ic.chosen_option, ic.created_at,
				        COALESCE(ma.title, m.display_name, 'Admin') AS author_name
				 FROM task_comments ic
				 LEFT JOIN members m ON m.id = ic.author_member_id
				 LEFT JOIN member_agents ma ON ma.id = ic.author_member_id
				 WHERE ${conditions.join(' AND ')}
				 ORDER BY ic.created_at DESC, ic.id DESC LIMIT 50`,
				params,
			);
			const viewerMemberId = await resolveActorMemberId(db, auth, args.team_id as string);
			const reactionsByComment = await loadReactionsForTask(
				db,
				args.task_id as string,
				viewerMemberId,
			);
			const commentIds = r.rows.map((row) => row.id as string);
			const attachmentsByComment = await loadAgentAttachmentsForComments(db, commentIds);
			const enriched: Record<string, unknown>[] = r.rows.map((row) => ({
				...row,
				reactions: reactionsByComment.get(row.id as string) ?? [],
				attachments: attachmentsByComment.get(row.id as string) ?? [],
			}));
			const max = args.excerpt_chars as number | undefined;
			if (max == null) return enriched;
			return enriched.map((row) => {
				if (row.content_type !== CommentContentType.Text) return row;
				const content = row.content as { text?: string } | null;
				const text = content?.text;
				if (typeof text !== 'string' || text.length <= max) return row;
				const ex = excerpt(text, max);
				return {
					...row,
					content: { ...content, text: ex.excerpt },
					text_truncated: ex.truncated,
					text_length: ex.length,
				};
			});
		},
		db,
	);

	const reactionKindSchema = z.enum(Object.values(ReactionKind) as [string, ...string[]]);

	tool(
		server,
		'add_reaction',
		'React to a comment without waking its author. Use this to acknowledge mentions or signal "seen / picked up" without forcing the original commenter to run again. Prefer this over a follow-up create_comment when you have nothing substantive to add — comments wake the author, reactions do not. Only react when the situation calls for it: a clean handoff to your own new ticket (✓ on the mention), or a brief acknowledgement that a request landed. If you need the original commenter to read something, post a comment instead.',
		{
			team_id: z.string().describe('Team ID'),
			task_id: z.string().describe('Task ID the comment belongs to'),
			comment_id: z
				.string()
				.uuid()
				.describe(
					'UUID of the comment to react to, as returned by list_comments. Sentinels like "last" / "latest" are not supported — you must pass an explicit UUID.',
				),
			kind: reactionKindSchema.describe(
				`Reaction kind. v1 supports: ${Object.values(ReactionKind).join(', ')}`,
			),
		},
		async (args, db, auth) => {
			const teamId = args.team_id as string;
			const denied = await verifyTeamAccess(db, auth, teamId);
			if (denied) return { error: denied };
			const taskScope = await assertProjectAccessForTask(db, auth, args.task_id as string);
			if (taskScope) return { error: taskScope };
			const memberId = await resolveActorMemberId(db, auth, teamId);
			if (!memberId) return { error: 'No member identity for caller' };
			const result = await addCommentReaction({
				db,
				teamId,
				taskId: args.task_id as string,
				commentId: args.comment_id as string,
				kind: args.kind as string,
				memberId,
			});
			if (!result.ok) return { error: result.message };
			broadcastRowChange(wsManager, wsRoom.team(teamId), 'comment_reactions', 'INSERT', {
				comment_id: args.comment_id,
				task_id: args.task_id,
				member_id: memberId,
				kind: args.kind,
			});
			return {
				comment_id: args.comment_id,
				kind: args.kind,
				reactions: result.reactions,
			};
		},
		db,
	);

	tool(
		server,
		'remove_reaction',
		'Remove your own reaction from a comment. Removing a reaction does not wake the comment author.',
		{
			team_id: z.string().describe('Team ID'),
			task_id: z.string().describe('Task ID the comment belongs to'),
			comment_id: z
				.string()
				.uuid()
				.describe(
					'UUID of the comment to remove the reaction from, as returned by list_comments. Sentinels like "last" / "latest" are not supported — you must pass an explicit UUID.',
				),
			kind: reactionKindSchema.describe(
				`Reaction kind. v1 supports: ${Object.values(ReactionKind).join(', ')}`,
			),
		},
		async (args, db, auth) => {
			const teamId = args.team_id as string;
			const denied = await verifyTeamAccess(db, auth, teamId);
			if (denied) return { error: denied };
			const taskScope = await assertProjectAccessForTask(db, auth, args.task_id as string);
			if (taskScope) return { error: taskScope };
			const memberId = await resolveActorMemberId(db, auth, teamId);
			if (!memberId) return { error: 'No member identity for caller' };
			const result = await removeCommentReaction({
				db,
				teamId,
				taskId: args.task_id as string,
				commentId: args.comment_id as string,
				kind: args.kind as string,
				memberId,
			});
			if (!result.ok) return { error: result.message };
			broadcastRowChange(wsManager, wsRoom.team(teamId), 'comment_reactions', 'DELETE', {
				comment_id: args.comment_id,
				task_id: args.task_id,
				member_id: memberId,
				kind: args.kind,
			});
			return {
				comment_id: args.comment_id,
				kind: args.kind,
				reactions: result.reactions,
			};
		},
		db,
	);

	tool(
		server,
		'create_comment',
		'Add a comment to an task. In content, reference teammates with @<agent-slug>. Reference tickets and project docs by their bare identifier/filename (e.g. IN-42, spec.md), and skills by their slug — no @ prefix. Do not wrap any of these in backticks — that makes them inert. When your comment is a direct response to a specific earlier one (answering a question, confirming/pushing back on a request, providing the follow-up that was asked for) ALWAYS set parent_comment_id to that comment\'s UUID — it wakes the original author with source=reply (so they\'re notified the conversation moved forward) and shows "replying to ..." threading in the UI so other readers can follow the dialogue. Skip parent_comment_id only when the comment is genuinely standalone (a new observation, an unrelated update). If you only need to acknowledge a mention without adding substance, use add_reaction instead.',
		{
			team_id: z.string().describe('Team ID'),
			task_id: z.string().describe('Task ID'),
			content: z.string().describe('Comment text'),
			parent_comment_id: z
				.string()
				.optional()
				.describe(
					'UUID of the comment you are replying to. Setting this wakes that comment\'s author with source=reply and renders this comment as "replying to ..." in the UI.',
				),
		},
		async (args, db, auth) => {
			const denied = await verifyTeamAccess(db, auth, args.team_id as string);
			if (denied) return { error: denied };
			// Verify task belongs to team
			const taskCheck = await db.query<{ project_id: string }>(
				'SELECT project_id FROM tasks WHERE id = $1 AND team_id = $2',
				[args.task_id, args.team_id],
			);
			if (taskCheck.rows.length === 0) return { error: 'Task not found in this team' };
			const pDenied = assertProjectAccess(auth, taskCheck.rows[0].project_id);
			if (pDenied) return { error: pDenied };
			let parentCommentId: string | null = null;
			if (args.parent_comment_id) {
				const parentCheck = await db.query(
					'SELECT 1 FROM task_comments WHERE id = $1 AND task_id = $2',
					[args.parent_comment_id, args.task_id],
				);
				if (parentCheck.rows.length === 0) {
					return { error: 'parent_comment_id does not belong to this task' };
				}
				parentCommentId = args.parent_comment_id as string;
			}
			const authorMemberId = auth.type === AuthType.Agent ? auth.memberId : null;
			const content = { text: args.content };
			const r = await db.query<{ id: string }>(
				`INSERT INTO task_comments (task_id, author_member_id, parent_comment_id, content_type, content) VALUES ($1, $2, $3, $4::comment_content_type, $5::jsonb) RETURNING *`,
				[
					args.task_id,
					authorMemberId,
					parentCommentId,
					CommentContentType.Text,
					JSON.stringify(content),
				],
			);
			await fireCommentWakeups({
				db,
				taskId: args.task_id as string,
				teamId: args.team_id as string,
				commentId: r.rows[0].id,
				content,
				contentType: CommentContentType.Text,
				authorMemberId,
				authorUserId: auth.type === AuthType.Admin ? auth.userId : null,
				authorRunId: auth.type === AuthType.Agent ? auth.runId : null,
				parentCommentId,
				wsManager,
			});
			trackBackground(
				recordTaskLinks(
					db,
					args.team_id as string,
					args.task_id as string,
					args.content as string,
					authorMemberId,
					wsManager,
				).catch((e) => log.error('Failed to record task links from comment:', e)),
			);
			return r.rows[0];
		},
		db,
	);

	const credentialKindSchema = z.enum([
		CredentialKind.ApiKey,
		CredentialKind.SshPrivateKey,
		CredentialKind.GithubPat,
		CredentialKind.OauthToken,
		CredentialKind.WebhookSecret,
		CredentialKind.Other,
	]);
	const credentialInputTypeSchema = z.enum([
		CredentialInputType.Text,
		CredentialInputType.Textarea,
		CredentialInputType.File,
	]);

	tool(
		server,
		'request_credential',
		'Ask the human assignee to provide a secret value (API key, SSH private key, OAuth token, etc.). Posts a structured comment on the task with a paste form. The agent never sees the value; it gets a placeholder string to embed in env vars or HTTP headers, which the egress proxy later substitutes. Returns immediately with the placeholder; the agent should stop work on whatever needed the credential and wait for a credential_provided wakeup.',
		{
			team_id: z.string().describe('Team ID'),
			task_id: z.string().describe('Task ID — the request comment is posted here'),
			name: z
				.string()
				.describe(
					'Secret name. Must match [A-Z][A-Z0-9_]{0,63} (e.g. GITHUB_PAT, ANTHROPIC_API_KEY). The placeholder returned will be __HEZO_SECRET_<name>__.',
				),
			kind: credentialKindSchema.describe(
				'Type of credential — drives validation when the human submits the value',
			),
			instructions: z
				.string()
				.describe(
					'Human-facing prose explaining why you need this credential and how the human can obtain it (e.g. "I need a GitHub PAT with `repo` scope to push branches. Create one at https://github.com/settings/tokens").',
				),
			input_type: credentialInputTypeSchema
				.optional()
				.describe('Form input type. Defaults: text for short keys, textarea for SSH/multiline.'),
			confirmation_text: z
				.string()
				.optional()
				.describe(
					'Optional yes/no confirmation prompt instead of a paste form (e.g. "Have you added the public key to github.com/owner/repo/settings/keys?"). When set, input_type is ignored.',
				),
			allowed_hosts: z
				.array(z.string())
				.optional()
				.describe(
					'Hostname allowlist for the egress proxy. The credential will only be substituted into outbound requests to these hosts. Wildcards: *.github.com matches one label segment.',
				),
			scope: z
				.enum(['team', 'project'])
				.optional()
				.describe('Storage scope. Default: team. Use project to scope to the current project.'),
		},
		async (args, db, auth) => {
			const denied = await verifyTeamAccess(db, auth, args.team_id as string);
			if (denied) return { error: denied };

			const name = args.name as string;
			const validation = validateSecretName(name);
			if (!validation.valid) return { error: validation.error };

			const taskId = args.task_id as string;
			const teamId = args.team_id as string;
			const scope = (args.scope as string | undefined) ?? 'team';

			const taskRow = await db.query<{ id: string; project_id: string | null }>(
				'SELECT id, project_id FROM tasks WHERE id = $1 AND team_id = $2',
				[taskId, teamId],
			);
			if (taskRow.rows.length === 0) return { error: 'Task not found in this team' };
			if (taskRow.rows[0].project_id) {
				const pDenied = assertProjectAccess(auth, taskRow.rows[0].project_id);
				if (pDenied) return { error: pDenied };
			}
			const projectId = scope === 'project' ? taskRow.rows[0].project_id : null;

			const placeholder = credentialPlaceholder(name);

			const existing = await db.query<{ id: string; content: Record<string, unknown> }>(
				`SELECT id, content FROM task_comments
				 WHERE task_id = $1
				   AND content_type = 'credential_request'::comment_content_type
				   AND chosen_option IS NULL
				   AND content->>'name' = $2
				   AND COALESCE(content->>'scope', 'team') = $3
				 ORDER BY created_at ASC LIMIT 1`,
				[taskId, name, scope],
			);
			if (existing.rows.length > 0) {
				return {
					placeholder,
					comment_id: existing.rows[0].id,
					status: 'pending',
					reused: true,
				};
			}

			const authorMemberId = auth.type === AuthType.Agent ? auth.memberId : null;
			const content = {
				name,
				kind: args.kind,
				instructions: args.instructions,
				input_type: args.confirmation_text
					? null
					: ((args.input_type as string | undefined) ?? CredentialInputType.Text),
				confirmation_text: args.confirmation_text ?? null,
				allowed_hosts: (args.allowed_hosts as string[] | undefined) ?? [],
				scope,
				project_id: projectId,
				placeholder,
			};

			const inserted = await db.query<{ id: string }>(
				`INSERT INTO task_comments (task_id, author_member_id, content_type, content)
				 VALUES ($1, $2, 'credential_request'::comment_content_type, $3::jsonb)
				 RETURNING id`,
				[taskId, authorMemberId, JSON.stringify(content)],
			);

			events?.emit({
				type: 'credential.requested',
				teamId,
				projectId,
				actorType: AuditActorType.Agent,
				actorMemberId: authorMemberId,
				taskId,
				name,
			});

			return {
				placeholder,
				comment_id: inserted.rows[0].id,
				status: 'pending',
				reused: false,
			};
		},
		db,
	);

	tool(
		server,
		'register_connector',
		'Register a third-party MCP server connector for the team and ask the human to authenticate. Posts a connect_required comment on the task with a Connect button; the human clicks it to run OAuth in their own browser. The agent never sees the token; subsequent runs receive the MCP via the egress proxy + placeholder substitution. Idempotent: re-registering an already-active connector returns its current state and fires the wakeup immediately. Auth mechanism is chosen automatically by what the provider supports: servers that advertise OAuth Dynamic Client Registration (most MCP servers) need only mcp_url and authorize with zero config. Providers whose Authorization Server cannot do DCR (e.g. GitHub) require a pre-registered client_id and use the device flow instead — these MUST be registered with provider_id set to a known registry key (e.g. "github"); passing only a raw mcp_url for such a provider will fail to authorize.',
		{
			team_id: z.string().describe('Team ID'),
			task_id: z.string().describe('Task ID where the connect_required comment is posted'),
			display_name: z
				.string()
				.describe(
					'Human-readable connector name shown in the task chat and on the Connectors page (e.g. "DatoCMS", "Linear").',
				),
			mcp_url: z
				.string()
				.describe(
					'URL of the MCP server (HTTP / SSE). The OAuth dance is discovered by probing this URL for a 401 + WWW-Authenticate header.',
				),
			mcp_transport: z
				.enum(['http', 'sse'])
				.optional()
				.describe('Transport for the MCP server. Defaults to http.'),
			provider_id: z
				.string()
				.optional()
				.describe(
					'Optional registry key (e.g. "datocms"). When set, capability defaults from the shared registry pre-fill display name and allowed hosts.',
				),
			skill_doc_id: z
				.string()
				.optional()
				.describe(
					'Optional ID of a previously-fetched skill document (see fetch_skill_file). When set, the skill file is exposed to every team agent run via the per-adapter skill path.',
				),
		},
		async (args, db, auth) => {
			const teamId = args.team_id as string;
			const taskId = args.task_id as string;
			const denied = await verifyTeamAccess(db, auth, teamId);
			if (denied) return { error: denied };

			const taskRow = await db.query<{ id: string; project_id: string | null }>(
				'SELECT id, project_id FROM tasks WHERE id = $1 AND team_id = $2',
				[taskId, teamId],
			);
			if (taskRow.rows.length === 0) return { error: 'Task not found in this team' };
			const projectId = taskRow.rows[0].project_id;
			if (projectId) {
				const pDenied = assertProjectAccess(auth, projectId);
				if (pDenied) return { error: pDenied };
			}

			const displayName = (args.display_name as string).trim();
			const providerId = (args.provider_id as string | undefined)?.trim() || null;
			const mcpUrl = (args.mcp_url as string).trim();
			const mcpTransport = (args.mcp_transport as 'http' | 'sse' | undefined) ?? 'http';
			const skillDocId = (args.skill_doc_id as string | undefined) ?? null;

			// Slug from providerId if available, else from display_name. The
			// (team_id, project_id, name) UNIQUE constraint makes this the
			// idempotency key.
			const slugSource = providerId ?? displayName;
			const name = slugSource
				.toLowerCase()
				.replace(/[^a-z0-9]+/g, '-')
				.replace(/^-|-$/g, '')
				.slice(0, 64);
			if (!name) return { error: 'display_name produced an empty slug' };

			const { createOrFetchConnector, statusOf } = await import('../services/connectors/lifecycle');
			const { row, alreadyExisted } = await createOrFetchConnector(db, {
				teamId,
				projectId: null, // connectors are team-scoped today
				name,
				displayName,
				mcpUrl,
				mcpTransport,
				skillDocId,
				createdByTaskId: taskId,
				providerId,
			});

			if (!alreadyExisted) {
				events?.emit({
					type: 'mcp_connection.created',
					teamId,
					actorType: auth.type === AuthType.Agent ? AuditActorType.Agent : AuditActorType.Admin,
					actorMemberId: auth.type === AuthType.Agent ? auth.memberId : null,
					connectionId: row.id as string,
					name: name as string,
				});
			}

			const status = statusOf(row);

			// If already active, no need for a Connect comment — just signal the
			// caller; they should retry whatever needed the connector.
			if (status === 'active') {
				return {
					connector_id: row.id,
					status,
					name: row.name,
					display_name: row.display_name,
					reused: true,
				};
			}

			// Idempotent comment: don't post a second connect_required for the same
			// connector_id on the same task.
			const existingComment = await db.query<{ id: string }>(
				`SELECT id FROM task_comments
				 WHERE task_id = $1
				   AND content_type = 'connect_required'::comment_content_type
				   AND content->>'connector_id' = $2
				 ORDER BY created_at ASC LIMIT 1`,
				[taskId, row.id],
			);

			let commentId: string;
			if (existingComment.rows.length > 0) {
				commentId = existingComment.rows[0].id;
			} else {
				const authorMemberId = auth.type === AuthType.Agent ? auth.memberId : null;
				const content = {
					connector_id: row.id,
					display_name: displayName,
					provider_id: providerId,
				};
				const inserted = await db.query<{ id: string }>(
					`INSERT INTO task_comments (task_id, author_member_id, content_type, content)
					 VALUES ($1, $2, 'connect_required'::comment_content_type, $3::jsonb)
					 RETURNING id`,
					[taskId, authorMemberId, JSON.stringify(content)],
				);
				commentId = inserted.rows[0].id;
			}

			return {
				connector_id: row.id,
				status,
				name: row.name,
				display_name: row.display_name,
				comment_id: commentId,
				reused: alreadyExisted,
			};
		},
		db,
	);

	tool(
		server,
		'fetch_skill_file',
		"Fetch a remote agent skill file (Markdown describing how to use a third-party MCP server) and store it in the team knowledge base as a doc with kind=mcp_skill. Returns the doc_id and slug. Subsequent agent runs across every project in the team get this skill file injected into their adapter's skills directory. Idempotent on (team_id, url) — re-fetching the same URL updates the existing doc.",
		{
			team_id: z.string().describe('Team ID'),
			url: z
				.string()
				.describe(
					'HTTPS URL of the skill file. Only http/https schemes are allowed; response must be < 256KB; 10s timeout.',
				),
			title: z
				.string()
				.optional()
				.describe('Human-readable title shown in the team KB. Defaults to the URL pathname.'),
		},
		async (args, db, auth) => {
			const teamId = args.team_id as string;
			const denied = await verifyTeamAccess(db, auth, teamId);
			if (denied) return { error: denied };

			const url = (args.url as string).trim();
			let parsed: URL;
			try {
				parsed = new URL(url);
			} catch {
				return { error: 'Invalid URL' };
			}
			if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
				return { error: 'Only http/https URLs are allowed' };
			}

			const controller = new AbortController();
			const timeout = setTimeout(() => controller.abort(), 10_000);
			let res: Response;
			try {
				res = await fetch(url, { signal: controller.signal });
			} catch (e) {
				clearTimeout(timeout);
				return { error: `Fetch failed: ${(e as Error).message}` };
			}
			clearTimeout(timeout);
			if (!res.ok) {
				return { error: `Fetch failed: HTTP ${res.status}` };
			}
			const contentLength = res.headers.get('content-length');
			if (contentLength && Number(contentLength) > 256 * 1024) {
				return { error: 'Response too large (>256KB)' };
			}
			const body = await res.text();
			if (body.length > 256 * 1024) {
				return { error: 'Response too large (>256KB)' };
			}

			// Slug from URL pathname (e.g. /docs/mcp-server/agent-skill.md → agent-skill).
			const pathSlug = parsed.pathname
				.split('/')
				.filter(Boolean)
				.pop()
				?.replace(/\.[a-z0-9]+$/i, '')
				.toLowerCase()
				.replace(/[^a-z0-9]+/g, '-')
				.replace(/^-|-$/g, '');
			const hostSlug = parsed.host.toLowerCase().replace(/[^a-z0-9]+/g, '-');
			const slug = `${hostSlug}--${pathSlug || 'skill'}`.slice(0, 64);
			const title = (args.title as string | undefined) ?? parsed.pathname;

			const authorMemberId = auth.type === AuthType.Agent ? auth.memberId : null;
			const doc = await upsertDocument(db, wsManager, {
				scope: { type: DocumentType.McpSkill, teamId, slug },
				title,
				content: body,
				authorMemberId,
				changeSummary: `Fetched from ${url}`,
				audit: {
					events,
					actorType: auth.type === AuthType.Agent ? AuditActorType.Agent : AuditActorType.Admin,
				},
			});

			// Track source_url in a separate small table? For v1 we encode it in
			// the title prefix so the doc is self-describing.
			return {
				doc_id: doc.id,
				slug: doc.slug,
				source_url: url,
				size_bytes: body.length,
				reused: false,
			};
		},
		db,
	);

	// Approvals
	tool(
		server,
		'list_approvals',
		'List pending approvals. Pass excerpt_chars (e.g. 500) to truncate long fields inside payload (e.g. skill-proposal content); omit for full payload.',
		{
			team_id: z.string().describe('Team ID'),
			excerpt_chars: z
				.number()
				.int()
				.positive()
				.optional()
				.describe(
					'When set, truncates long string fields inside payload (e.g. skill-proposal content) and adds *_truncated/_length companions',
				),
		},
		async (args, db, auth) => {
			const denied = await verifyTeamAccess(db, auth, args.team_id as string);
			if (denied) return { error: denied };
			const scoped = auth.type === AuthType.Agent && !auth.crossProject;
			const r = await db.query<Record<string, unknown>>(
				scoped
					? `SELECT ${APPROVAL_COLUMNS} FROM approvals
					 WHERE team_id = $1 AND status = $2::approval_status
					   AND payload->>'project_id' = $3
					 ORDER BY created_at DESC`
					: `SELECT ${APPROVAL_COLUMNS} FROM approvals
					 WHERE team_id = $1 AND status = $2::approval_status
					 ORDER BY created_at DESC`,
				scoped
					? [args.team_id, ApprovalStatus.Pending, auth.projectId]
					: [args.team_id, ApprovalStatus.Pending],
			);
			const max = args.excerpt_chars as number | undefined;
			if (max == null) return r.rows;
			return r.rows.map((row) => excerptApprovalPayload(row, max));
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
			const existing = await db.query<{ team_id: string; payload: Record<string, unknown> }>(
				'SELECT team_id, payload FROM approvals WHERE id = $1',
				[args.approval_id],
			);
			if (existing.rows.length === 0) return { error: 'Approval not found' };
			const denied = await verifyTeamAccess(db, auth, existing.rows[0].team_id);
			if (denied) return { error: denied };
			const approvalProjectId = existing.rows[0].payload?.project_id;
			if (typeof approvalProjectId === 'string') {
				const pDenied = assertProjectAccess(auth, approvalProjectId);
				if (pDenied) return { error: pDenied };
			} else if (auth.type === AuthType.Agent && !auth.crossProject) {
				return { error: 'Access denied: run is not scoped to resolve this approval' };
			}

			const actorMemberId = auth.type === AuthType.Agent ? auth.memberId : null;
			const resolved = await resolveApproval(db, args.approval_id as string, {
				status: args.status as typeof ApprovalStatus.Approved | typeof ApprovalStatus.Denied,
				resolutionNote: typeof args.resolution_note === 'string' ? args.resolution_note : null,
				dataDir,
				actorMemberId,
				wsManager,
				events,
			});
			if (!resolved.ok) {
				return { error: resolved.message };
			}

			const { row, sideEffects } = resolved;
			const teamId = existing.rows[0].team_id;
			broadcastApprovalChange(wsManager, teamId, 'UPDATE', row);
			if (wsManager) {
				const room = wsRoom.team(teamId);
				for (const effect of sideEffects) {
					broadcastRowChange(wsManager, room, effect.table, effect.op, effect.row);
				}
			}
			return row;
		},
		db,
	);

	// Costs
	tool(
		server,
		'get_costs',
		'Get cost summary for a team',
		{
			team_id: z.string().describe('Team ID'),
			group_by: z.enum(['agent', 'project', 'day']).optional().describe('Group costs by'),
		},
		async (args, db, auth) => {
			const denied = await verifyTeamAccess(db, auth, args.team_id as string);
			if (denied) return { error: denied };
			if (args.group_by === 'agent') {
				const r = await db.query(
					`SELECT ce.member_id, COALESCE(ma.title, m.display_name) AS agent_title, sum(ce.amount_cents)::int AS total_cents
				 FROM cost_entries ce LEFT JOIN members m ON m.id = ce.member_id LEFT JOIN member_agents ma ON ma.id = ce.member_id
				 WHERE ce.team_id = $1 GROUP BY ce.member_id, ma.title, m.display_name`,
					[args.team_id],
				);
				return r.rows;
			}
			const r = await db.query(
				`SELECT sum(amount_cents)::int AS total_cents, count(*)::int AS entry_count FROM cost_entries WHERE team_id = $1`,
				[args.team_id],
			);
			return r.rows[0];
		},
		db,
	);

	// System Prompt Management — read: any agent/admin in same team; write: coach only
	tool(
		server,
		'get_agent_system_prompt',
		"Read an agent's system prompt. Accessible by any agent or the admin in the same team. Returns the resolved role doc by default — `{{…}}` placeholders substituted with the real team name, mission, manager, KB, project docs, and team context — so you can see what the agent actually says about itself with real values. Pass placeholders=false to get the raw stored template with `{{…}}` placeholders intact; only do this when you intend to edit the prompt and need a safe round-trip back through update_agent_system_prompt.",
		{
			team_id: z.string().describe('Team ID'),
			agent_id: z.string().describe('Target agent member ID'),
			placeholders: z
				.boolean()
				.optional()
				.default(true)
				.describe(
					'When true (default) substitutes `{{…}}` placeholders with real team/team values. When false returns the raw stored template — needed when reading before update_agent_system_prompt so placeholders survive the round-trip.',
				),
		},
		async (args, db, auth) => {
			const denied = await verifyTeamAccess(db, auth, args.team_id as string);
			if (denied) return { error: denied };

			if (auth.type !== AuthType.Agent && auth.type !== AuthType.Admin) {
				return { error: 'Access denied' };
			}

			const agent = await db.query<{ title: string; slug: string }>(
				`SELECT ma.title, ma.slug
				 FROM member_agents ma JOIN members m ON m.id = ma.id
				 WHERE ma.id = $1 AND m.team_id = $2`,
				[args.agent_id, args.team_id],
			);
			if (agent.rows.length === 0) return { error: 'Agent not found in this team' };

			const raw = await getAgentSystemPrompt(db, args.team_id as string, args.agent_id as string);
			const system_prompt = args.placeholders
				? await resolveSystemPrompt(db, raw, {
						teamId: args.team_id as string,
						agentId: args.agent_id as string,
						mode: 'placeholders',
					})
				: raw;
			return { ...agent.rows[0], system_prompt };
		},
		db,
	);

	tool(
		server,
		'get_agent_system_prompts',
		`Read multiple agent system prompts in one call (max ${MAX_BATCH_AGENT_SYSTEM_PROMPTS}). Per-item \`mode\` chooses the resolution depth: \`placeholders\` (default) substitutes \`{{…}}\` with real values and stops, matching get_agent_system_prompt's default; \`preview\` additionally appends the resolver's runtime blocks (Project State, Team Context, Teammates, Working Guidelines) minus the per-run Run Context, matching the web UI's preview panel; \`raw\` returns the stored template untouched. Use this to compare prompts across the team in one round-trip — e.g. Captain auditing how team_context renders for every agent. For a single prompt, use get_agent_system_prompt.`,
		{
			team_id: z.string().describe('Team ID'),
			items: z
				.array(
					z.object({
						agent_id: z.string().describe('Target agent member ID or slug'),
						mode: z
							.enum(['raw', 'placeholders', 'preview'])
							.optional()
							.describe(
								'Resolution depth: raw | placeholders (default) | preview. See tool description.',
							),
					}),
				)
				.min(1)
				.max(MAX_BATCH_AGENT_SYSTEM_PROMPTS)
				.describe(`Up to ${MAX_BATCH_AGENT_SYSTEM_PROMPTS} items.`),
		},
		async (args, db, auth) => {
			const teamId = args.team_id as string;
			const denied = await verifyTeamAccess(db, auth, teamId);
			if (denied) return { error: denied };

			if (auth.type !== AuthType.Agent && auth.type !== AuthType.Admin) {
				return { error: 'Access denied' };
			}

			const items = args.items as Array<{ agent_id: string; mode?: SystemPromptMode }>;
			const results = await Promise.all(
				items.map(async (item, index) => {
					try {
						const out = await fetchAgentSystemPromptForBatch(
							db,
							teamId,
							item.agent_id,
							item.mode ?? 'placeholders',
						);
						return { index, ok: true as const, ...out };
					} catch (e) {
						if (e instanceof AgentSystemPromptError) {
							return { index, ok: false as const, agent_id: item.agent_id, error: e.message };
						}
						log.error('Unexpected error in get_agent_system_prompts:', e);
						return {
							index,
							ok: false as const,
							agent_id: item.agent_id,
							error: e instanceof Error ? e.message : 'internal_error',
						};
					}
				}),
			);
			return results;
		},
		db,
	);

	tool(
		server,
		'update_agent_system_prompt',
		'Apply a system prompt change for an agent. Callable by the Coach agent (for after-task learned-rules updates) or by the Captain of the same team (during team-coherence reviews). The change is applied immediately and a revision snapshot is stored so the admin can restore previous versions.',
		{
			team_id: z.string().describe('Team ID'),
			agent_id: z.string().describe('Target agent member ID'),
			new_system_prompt: z.string().describe('The full updated system prompt'),
			change_summary: z.string().describe('Summary of what changed and why'),
		},
		async (args, db, auth) => {
			const denied = await verifyTeamAccess(db, auth, args.team_id as string);
			if (denied) return { error: denied };

			const allowed =
				(await isCoach(db, auth)) || (await canCoordinateTeam(db, auth, args.team_id as string));
			if (!allowed) {
				return {
					error: 'Access denied: only the Coach or the Captain can update system prompts',
				};
			}

			const agentCheck = await db.query<{ id: string }>(
				`SELECT ma.id FROM member_agents ma JOIN members m ON m.id = ma.id
				 WHERE ma.id = $1 AND m.team_id = $2`,
				[args.agent_id, args.team_id],
			);
			if (agentCheck.rows.length === 0) return { error: 'Agent not found in this team' };

			const callerMemberId = auth.type === AuthType.Agent ? auth.memberId : null;

			const doc = await upsertDocument(db, undefined, {
				scope: {
					type: DocumentType.AgentSystemPrompt,
					teamId: args.team_id as string,
					memberAgentId: args.agent_id as string,
				},
				content: args.new_system_prompt as string,
				changeSummary: args.change_summary as string,
				authorMemberId: callerMemberId,
			});

			trackBackground(
				enqueueTeamCoherenceReviewTask(db, args.team_id as string, 'prompt_updated').catch((e) =>
					log.error('Failed to enqueue team coherence review after prompt update:', e),
				),
			);

			return { applied: true, document_id: doc.id };
		},
		db,
	);

	// Description maintenance — used by the Captain (and self) to write back
	// auto-generated agent and team summaries.
	tool(
		server,
		'set_agent_summary',
		'Save a short human-readable summary for an agent (≤1000 chars, single paragraph, plain prose). Callable by any agent in the same team or any the admin; the Captain is the expected caller, but agents may also self-summarise.',
		{
			team_id: z.string().describe('Team ID'),
			agent_id: z.string().describe('Target agent member ID'),
			summary: z.string().describe('The new summary, ≤1000 chars'),
		},
		async (args, db, auth) => {
			const denied = await verifyTeamAccess(db, auth, args.team_id as string);
			if (denied) return { error: denied };

			if (auth.type !== AuthType.Agent && auth.type !== AuthType.Admin) {
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
				   SELECT m.id FROM members m WHERE m.id = $2 AND m.team_id = $3
				 )
				 RETURNING id`,
				[summary, args.agent_id, args.team_id],
			);
			if (r.rows.length === 0) return { error: 'Agent not found in this team' };

			trackBackground(
				enqueueTeamCoherenceReviewTask(db, args.team_id as string, 'summary_updated').catch((e) =>
					log.error('Failed to enqueue team coherence review after summary update:', e),
				),
			);

			return { updated: true };
		},
		db,
	);

	tool(
		server,
		'set_team_summary',
		'Save the team-level collaboration summary for a team (≤4000 chars, plain prose, may span paragraphs). Only callable by the Captain of that team.',
		{
			team_id: z.string().describe('Team ID'),
			summary: z.string().describe('The new team summary, ≤4000 chars'),
		},
		async (args, db, auth) => {
			const denied = await verifyTeamAccess(db, auth, args.team_id as string);
			if (denied) return { error: denied };

			if (!(await canCoordinateTeam(db, auth, args.team_id as string))) {
				return { error: 'Access denied: only the Captain can update the team summary' };
			}

			const summary = String(args.summary ?? '').trim();
			if (summary.length === 0) return { error: 'summary must be non-empty' };
			if (summary.length > 4000) {
				return { error: `summary too long (${summary.length} chars; max 4000)` };
			}

			await db.query('UPDATE teams SET summary = $1, updated_at = now() WHERE id = $2', [
				summary,
				args.team_id,
			]);

			return { updated: true };
		},
		db,
	);

	tool(
		server,
		'set_agent_team_context',
		"Save the team-relationships context for an agent (≤6000 chars, plain prose, second-person 'you', describes how this agent relates to its manager, direct reports, peers, indirect reports, and humans). This blob is injected into the agent's system prompt at the start of every run. Only callable by the Captain of the same team.",
		{
			team_id: z.string().describe('Team ID'),
			agent_id: z.string().describe('Target agent member ID'),
			content: z.string().describe('The new team_context, ≤6000 chars'),
		},
		async (args, db, auth) => {
			const denied = await verifyTeamAccess(db, auth, args.team_id as string);
			if (denied) return { error: denied };

			if (!(await canCoordinateTeam(db, auth, args.team_id as string))) {
				return { error: 'Access denied: only the Captain can update agent team contexts' };
			}

			const content = String(args.content ?? '').trim();
			if (content.length === 0) return { error: 'content must be non-empty' };
			if (content.length > 6000) {
				return { error: `content too long (${content.length} chars; max 6000)` };
			}

			const r = await db.query<{ id: string }>(
				`UPDATE member_agents SET team_context = $1, updated_at = now()
				 WHERE id = $2 AND id IN (
				   SELECT m.id FROM members m WHERE m.id = $2 AND m.team_id = $3
				 )
				 RETURNING id`,
				[content, args.agent_id, args.team_id],
			);
			if (r.rows.length === 0) return { error: 'Agent not found in this team' };

			return { updated: true };
		},
		db,
	);

	tool(
		server,
		'get_agent_team_context',
		"Read an agent's stored team-relationships context. Useful for the Captain when regenerating siblings' contexts. Accessible by any agent or the admin in the same team.",
		{
			team_id: z.string().describe('Team ID'),
			agent_id: z.string().describe('Target agent member ID'),
		},
		async (args, db, auth) => {
			const denied = await verifyTeamAccess(db, auth, args.team_id as string);
			if (denied) return { error: denied };

			if (auth.type !== AuthType.Agent && auth.type !== AuthType.Admin) {
				return { error: 'Access denied' };
			}

			const r = await db.query<{ title: string; slug: string; team_context: string }>(
				`SELECT ma.title, ma.slug, ma.team_context
				 FROM member_agents ma JOIN members m ON m.id = ma.id
				 WHERE ma.id = $1 AND m.team_id = $2`,
				[args.agent_id, args.team_id],
			);
			if (r.rows.length === 0) return { error: 'Agent not found in this team' };

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
			team_id: z.string().describe('Team ID'),
			project_id: z.string().describe('Project ID'),
		},
		async (args, db, auth) => {
			const denied = await verifyTeamAccess(db, auth, args.team_id as string);
			if (denied) return { error: denied };
			const pDenied = assertProjectAccess(auth, args.project_id as string);
			if (pDenied) return { error: pDenied };
			const docs = await listDocuments(db, {
				type: DocumentType.ProjectDoc,
				teamId: args.team_id as string,
				projectId: args.project_id as string,
			});
			return {
				files: docs.map((d) => ({
					id: d.id,
					filename: d.slug,
					title: d.title,
					updated_at: d.updated_at,
				})),
			};
		},
		db,
	);

	tool(
		server,
		'list_project_assets',
		"List the project's assets — non-markdown files (UI mockups, wireframes, diagrams, PDFs). Reference one in a comment or doc as `assets/<filename>` (e.g. assets/login-mockup.png), no backticks. You can author text-based assets (.html, .svg, .txt) with write_project_asset; binary assets (images, PDFs) are human-uploaded.",
		{
			team_id: z.string().describe('Team ID'),
			project_id: z.string().describe('Project ID'),
		},
		async (args, db, auth) => {
			const denied = await verifyTeamAccess(db, auth, args.team_id as string);
			if (denied) return { error: denied };
			const pDenied = assertProjectAccess(auth, args.project_id as string);
			if (pDenied) return { error: pDenied };
			const assets = await db.query<{
				id: string;
				original_filename: string;
				content_type: string;
				created_at: string;
			}>(
				`SELECT id, original_filename, content_type, created_at
				 FROM assets WHERE project_id = $1 ORDER BY created_at DESC`,
				[args.project_id as string],
			);
			return {
				files: assets.rows.map((a) => ({
					id: a.id,
					filename: a.original_filename,
					content_type: a.content_type,
					created_at: a.created_at,
				})),
			};
		},
		db,
	);

	tool(
		server,
		'write_project_asset',
		'Save a text-based file to the project assets library so a human can open it (an interactive HTML mockup, an SVG diagram, a plain-text export). Allowed extensions: .html, .svg, .txt. Re-saving the same filename overwrites it, so the reference stays stable. Returns the reference string to drop into a comment as `assets/<filename>` (no backticks). HTML opens interactively in a new tab. Mockups and other deliverables belong here, never committed to the source repo.',
		{
			team_id: z.string().describe('Team ID'),
			project_id: z.string().describe('Project ID'),
			filename: z.string().describe('Filename to write (e.g. "ui-mockups.html")'),
			content: z.string().describe('File content'),
		},
		async (args, db, auth) => {
			const denied = await verifyTeamAccess(db, auth, args.team_id as string);
			if (denied) return { error: denied };
			const pDenied = assertProjectAccess(auth, args.project_id as string);
			if (pDenied) return { error: pDenied };

			const teamId = args.team_id as string;
			const projectId = args.project_id as string;
			const filename = normalizeAssetFilename(args.filename as string);
			const ext = extensionOf(filename);
			const contentType = ext
				? ATTACHMENT_EXTENSIONS[ext as keyof typeof ATTACHMENT_EXTENSIONS]
				: undefined;
			if (!contentType || !isAgentAuthorableAssetMime(contentType)) {
				return {
					error:
						'Asset must be a text-based file: .html, .svg, or .txt. Other types are human-uploaded.',
				};
			}

			const blob = new Blob([args.content as string], { type: contentType });
			if (blob.size > ATTACHMENT_MAX_BYTES) {
				return { error: 'Asset exceeds 10 MB.' };
			}

			const assetId = crypto.randomUUID();
			const { byteSize, sha256 } = await writeAsset(dataDir, teamId, projectId, assetId, blob);
			const uploadedBy = auth.type === AuthType.Agent ? auth.memberId : null;
			let result: Awaited<ReturnType<typeof upsertProjectAsset>>;
			try {
				result = await upsertProjectAsset(db, {
					assetId,
					teamId,
					projectId,
					contentType,
					byteSize,
					sha256,
					desiredName: filename,
					uploadedByMemberId: uploadedBy,
				});
			} catch (e) {
				await deleteAsset(dataDir, teamId, projectId, assetId).catch(() => {});
				throw e;
			}
			if (result.replacedAssetId) {
				await deleteAsset(dataDir, teamId, projectId, result.replacedAssetId).catch(() => {});
			}
			return { written: true, id: result.id, reference: `assets/${result.original_filename}` };
		},
		db,
	);

	tool(
		server,
		'read_project_asset',
		'Read a project asset\'s contents by filename (e.g. "ui-mockups.html") — the non-markdown files that list_project_assets returns (UI mockups, wireframes, SVG diagrams, text exports). Text-based assets (HTML, SVG, plain text) come back inline as `content`. Binary assets (images, PDFs, media) are not inlined; the response gives a read-only container path under /workspace/.hezo/assets/ to open directly. For markdown project docs use read_project_doc instead.',
		{
			team_id: z.string().describe('Team ID'),
			project_id: z.string().describe('Project ID'),
			filename: z.string().describe('Asset filename to read (e.g. "ui-mockups.html")'),
		},
		async (args, db, auth) => {
			const denied = await verifyTeamAccess(db, auth, args.team_id as string);
			if (denied) return { error: denied };
			const pDenied = assertProjectAccess(auth, args.project_id as string);
			if (pDenied) return { error: pDenied };

			const teamId = args.team_id as string;
			const projectId = args.project_id as string;
			const filename = normalizeAssetFilename(args.filename as string);

			const found = await db.query<{
				id: string;
				original_filename: string;
				content_type: string;
				byte_size: string;
			}>(
				`SELECT id, original_filename, content_type, byte_size
				 FROM assets WHERE project_id = $1 AND original_filename = $2`,
				[projectId, filename],
			);
			if (found.rows.length === 0) return { error: `Asset '${filename}' not found` };
			const asset = found.rows[0];

			// Text-based assets are returned inline; binary assets are left on the
			// read-only bind mount for the agent to open directly.
			const isText =
				asset.content_type.startsWith('text/') || asset.content_type === 'image/svg+xml';
			if (!isText) {
				return {
					filename: asset.original_filename,
					content_type: asset.content_type,
					byte_size: Number(asset.byte_size),
					binary: true,
					path: `${AGENT_ATTACHMENT_DIR}/${asset.id}`,
				};
			}

			const buf = await readAsset(dataDir, teamId, projectId, asset.id);
			return {
				filename: asset.original_filename,
				content_type: asset.content_type,
				content: buf.toString('utf-8'),
			};
		},
		db,
	);

	tool(
		server,
		'read_project_doc',
		'Read a project documentation file by filename',
		{
			team_id: z.string().describe('Team ID'),
			project_id: z.string().describe('Project ID'),
			filename: z.string().describe('Filename to read (e.g. "spec.md")'),
		},
		async (args, db, auth) => {
			const denied = await verifyTeamAccess(db, auth, args.team_id as string);
			if (denied) return { error: denied };
			const pDenied = assertProjectAccess(auth, args.project_id as string);
			if (pDenied) return { error: pDenied };
			const doc = await getDocument(db, {
				type: DocumentType.ProjectDoc,
				teamId: args.team_id as string,
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
		'Write a project documentation file. Project docs are markdown only — the filename must end in .md. For high-level project context: PRD, spec, implementation plan, research. Non-markdown files (mockups, wireframes, images, PDFs) live in the project assets library instead — reference those as `assets/<filename>`. In content, reference teammates with @<agent-slug>. Reference tickets and project docs by their bare identifier/filename (e.g. IN-42, spec.md), and skills by their slug — no @ prefix. Do not wrap any of these in backticks — that makes them inert.',
		{
			team_id: z.string().describe('Team ID'),
			project_id: z.string().describe('Project ID'),
			filename: z.string().describe('Markdown filename to write (e.g. "spec.md")'),
			content: z.string().describe('File content (markdown)'),
		},
		async (args, db, auth) => {
			const denied = await verifyTeamAccess(db, auth, args.team_id as string);
			if (denied) return { error: denied };
			const pDenied = assertProjectAccess(auth, args.project_id as string);
			if (pDenied) return { error: pDenied };
			if (!isMarkdownDocSlug(args.filename as string)) {
				return {
					error:
						'Project docs must be markdown (.md). Non-markdown files belong in the assets library, referenced as assets/<filename>.',
				};
			}
			const callerMemberId = auth.type === AuthType.Agent ? auth.memberId : null;
			const doc = await upsertDocument(db, wsManager, {
				scope: {
					type: DocumentType.ProjectDoc,
					teamId: args.team_id as string,
					projectId: args.project_id as string,
					slug: args.filename as string,
				},
				content: args.content as string,
				authorMemberId: callerMemberId,
				audit: {
					events,
					actorType: auth.type === AuthType.Agent ? AuditActorType.Agent : AuditActorType.Admin,
				},
			});
			return { written: true, id: doc.id, filename: doc.slug };
		},
		db,
	);

	// Skill proposals
	tool(
		server,
		'propose_skill',
		"Propose a new skill for the team's skills database (reusable team know-how: MCP server usage, integration steps, conventions, how agents coordinate). Creates an approval request; when approved the skill is written to the skills database.",
		{
			team_id: z.string().describe('Team ID'),
			skill_name: z.string().describe('Human-readable skill name'),
			skill_slug: z.string().describe('URL-safe slug for the skill file'),
			content: z.string().describe('Skill content (markdown)'),
			reason: z.string().describe('Why this skill should be added'),
		},
		async (args, db, auth) => {
			const denied = await verifyTeamAccess(db, auth, args.team_id as string);
			if (denied) return { error: denied };
			const callerMemberId = auth.type === AuthType.Agent ? auth.memberId : null;
			const teamId = args.team_id as string;
			const result = await db.query<Record<string, unknown>>(
				`INSERT INTO approvals (team_id, type, requested_by_member_id, payload)
				 VALUES ($1, $2::approval_type, $3, $4::jsonb)
				 RETURNING ${APPROVAL_COLUMNS}`,
				[
					teamId,
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
			const row = result.rows[0];
			if (row) {
				broadcastApprovalChange(wsManager, teamId, 'INSERT', row);
			}
			return { approval_id: row?.id, status: row?.status };
		},
		db,
	);

	// Semantic search
	tool(
		server,
		'semantic_search',
		'Search the team skills database, tasks, and project docs using natural language. Returns ranked results by relevance.',
		{
			team_id: z.string().describe('Team ID'),
			query: z.string().describe('Natural language search query'),
			scope: z
				.enum(['all', 'tasks', 'skills', 'project_docs'])
				.optional()
				.describe('Limit search to specific content type (default: all)'),
			limit: z.number().optional().describe('Max results (default: 10)'),
		},
		async (args, db, auth) => {
			const denied = await verifyTeamAccess(db, auth, args.team_id as string);
			if (denied) return { error: denied };

			const { isModelReady, semanticSearch } = await import('../services/embeddings');
			if (!isModelReady()) {
				return {
					error:
						'Embedding model not loaded yet. Search will be available shortly after server start.',
				};
			}

			const results = await semanticSearch(db, args.team_id as string, args.query as string, {
				scope: (args.scope as 'all' | 'tasks' | 'skills' | 'project_docs') ?? 'all',
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
		"List the team's skills database — the manifest of reusable team know-how (MCP server usage, integration steps, conventions, how agents coordinate). Returns each skill's name, slug, and description; call get_skill to load a skill's full body on demand.",
		{
			team_id: z.string().describe('Team ID'),
			tags: z.string().optional().describe('Filter by tag (comma-separated)'),
		},
		async (args, db, auth) => {
			const denied = await verifyTeamAccess(db, auth, args.team_id as string);
			if (denied) return { error: denied };

			let query = `SELECT id, name, slug, description, tags, created_at, updated_at
			             FROM skills WHERE (team_id = $1 OR team_id IS NULL) AND is_active = true`;
			const params: unknown[] = [args.team_id];

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
		"Load the full body of a skill from the team's skills database by slug. Use after list_skills surfaces a relevant skill in the manifest.",
		{
			team_id: z.string().describe('Team ID'),
			slug: z.string().describe('Skill slug'),
		},
		async (args, db, auth) => {
			const denied = await verifyTeamAccess(db, auth, args.team_id as string);
			if (denied) return { error: denied };

			const result = await db.query(
				`SELECT ${SKILL_COLUMNS} FROM skills WHERE (team_id = $1 OR team_id IS NULL) AND slug = $2 ORDER BY team_id NULLS LAST LIMIT 1`,
				[args.team_id, args.slug],
			);
			if (result.rows.length === 0) return { error: 'Skill not found' };
			return result.rows[0];
		},
		db,
	);

	tool(
		server,
		'create_skill',
		"Add or update a skill in the team's skills database directly (no approval needed) — record reusable team know-how such as MCP server usage, integration steps, conventions, and how agents coordinate. Use propose_skill when approval is required. If description is omitted it is derived from the skill body.",
		{
			team_id: z.string().describe('Team ID'),
			name: z.string().describe('Human-readable skill name'),
			slug: z.string().describe('URL-safe slug'),
			content: z.string().describe('Skill content (markdown)'),
			description: z.string().optional().describe('Short description'),
			tags: z.string().optional().describe('Comma-separated tags'),
		},
		async (args, db, auth) => {
			const denied = await verifyTeamAccess(db, auth, args.team_id as string);
			if (denied) return { error: denied };

			const callerMemberId = auth.type === AuthType.Agent ? auth.memberId : null;
			const { createHash } = await import('node:crypto');
			const contentHash = createHash('sha256')
				.update(args.content as string)
				.digest('hex');
			const tagList = args.tags ? (args.tags as string).split(',').map((t) => t.trim()) : [];
			// Backfill the manifest description from the body when omitted, so the
			// per-run skills manifest always has a usable one-line summary.
			const description =
				(args.description as string)?.trim() || deriveSkillSummary(args.content as string);

			const result = await db.query<{ id: string; slug: string }>(
				`INSERT INTO skills (team_id, name, slug, description, content, content_hash, created_by_member_id, tags)
				 VALUES ($1, $2, $3, $4, $5, $6, $7, $8::jsonb)
				 ON CONFLICT (team_id, slug) DO UPDATE SET
				   content = EXCLUDED.content,
				   content_hash = EXCLUDED.content_hash,
				   description = EXCLUDED.description,
				   tags = EXCLUDED.tags,
				   updated_at = now()
				 RETURNING id, slug`,
				[
					args.team_id,
					args.name,
					args.slug,
					description,
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

	tool(
		server,
		'list_mcp_connections',
		'List MCP server connections registered for the team (and optionally a project). Each row includes a derived `oauth_status` so you can tell whether a connector is usable: "active" means OAuth completed and the MCP tools should appear in your tool list on your next run; "pending" means waiting on the human to click Connect; "failed" means the OAuth flow errored (see auth_error); "revoked" means a human disconnected it; "none" means no OAuth needed (e.g., an env-var-token MCP or a public one). Do NOT confuse `install_status` (which tracks local-package install state and is meaningless for SaaS MCPs) with `oauth_status`.',
		{
			team_id: z.string().describe('Team ID'),
			project_id: z
				.string()
				.optional()
				.describe(
					'Optional project ID. When set, returns project-scoped + team-wide connections; when absent, only team-wide.',
				),
		},
		async (args, db, auth) => {
			const denied = await verifyTeamAccess(db, auth, args.team_id as string);
			if (denied) return { error: denied };
			const teamId = args.team_id as string;
			const projectId = (args.project_id as string | undefined) ?? null;
			const params: unknown[] = [teamId];
			let where = 'team_id = $1';
			if (projectId) {
				where += ' AND (project_id IS NULL OR project_id = $2)';
				params.push(projectId);
			} else {
				where += ' AND project_id IS NULL';
			}
			const r = await db.query<{
				id: string;
				team_id: string;
				project_id: string | null;
				name: string;
				display_name: string | null;
				kind: string;
				config: Record<string, unknown>;
				oauth_connection_id: string | null;
				install_status: string;
				install_error: string | null;
				skill_doc_id: string | null;
				created_by_task_id: string | null;
				activated_at: string | null;
				revoked_at: string | null;
				auth_error: string | null;
				created_at: string;
				updated_at: string;
			}>(
				`SELECT id, team_id, project_id, name, display_name, kind::text AS kind,
				        config, oauth_connection_id, install_status::text AS install_status, install_error,
				        skill_doc_id, created_by_task_id,
				        activated_at::text AS activated_at, revoked_at::text AS revoked_at, auth_error,
				        created_at::text, updated_at::text
				 FROM mcp_connections
				 WHERE ${where}
				 ORDER BY name ASC`,
				params,
			);
			// Derive a single oauth_status field that's the load-bearing signal
			// for whether the connector is usable by agents on subsequent runs.
			const cfg = (row: { config: Record<string, unknown> }): boolean => {
				const c = row.config as { dcr?: unknown };
				return !!c?.dcr;
			};
			return r.rows.map((row) => {
				let oauth_status: 'active' | 'pending' | 'failed' | 'revoked' | 'none';
				if (row.kind !== 'saas') oauth_status = 'none';
				else if (row.revoked_at) oauth_status = 'revoked';
				else if (row.auth_error && !row.activated_at) oauth_status = 'failed';
				else if (row.oauth_connection_id && row.activated_at) oauth_status = 'active';
				else if (cfg(row) || row.created_by_task_id) oauth_status = 'pending';
				else oauth_status = 'none';
				return { ...row, oauth_status };
			});
		},
		db,
	);

	tool(
		server,
		'test_connector',
		'Test an MCP connector end-to-end from the server side. Resolves the stored OAuth token from the vault and makes a direct HTTP call to the MCP server (bypassing the agent container and its egress proxy entirely). Returns the upstream status code, response excerpt, and the secret name + masked-token-prefix used. Use this when oauth_status says "active" but the MCP\'s tools are absent from your tool list — it isolates "is the token still valid against the provider?" from "does the proxy chain in the container work?".',
		{
			team_id: z.string().describe('Team ID'),
			connector_id: z.string().describe('mcp_connections.id from list_mcp_connections'),
		},
		async (args, db, auth) => {
			const denied = await verifyTeamAccess(db, auth, args.team_id as string);
			if (denied) return { error: denied };
			const teamId = args.team_id as string;
			const connectorId = args.connector_id as string;

			const row = await db.query<{
				id: string;
				team_id: string;
				name: string;
				kind: string;
				config: Record<string, unknown>;
				oauth_connection_id: string | null;
			}>(
				`SELECT id, team_id, name, kind::text AS kind, config, oauth_connection_id
				 FROM mcp_connections WHERE id = $1 AND team_id = $2`,
				[connectorId, teamId],
			);
			if (row.rows.length === 0) return { error: 'connector not found in this team' };
			const connector = row.rows[0];
			if (connector.kind !== 'saas') {
				return { error: `connector kind=${connector.kind}; test only meaningful for kind=saas` };
			}
			const config = connector.config as { url?: string };
			if (!config.url) return { error: 'connector has no mcp url' };

			let bearerToken: string | null = null;
			let secretName: string | null = null;
			let tokenPrefix: string | null = null;
			if (connector.oauth_connection_id) {
				const secret = await db.query<{ name: string; encrypted_value: string }>(
					`SELECT s.name, s.encrypted_value FROM oauth_connections oc
					 JOIN secrets s ON s.id = oc.access_token_secret_id
					 WHERE oc.id = $1`,
					[connector.oauth_connection_id],
				);
				if (secret.rows.length === 0) {
					return {
						error:
							'oauth_connection_id is set but no matching secret row found — vault is corrupted for this connector',
						connector_id: connector.id,
						oauth_connection_id: connector.oauth_connection_id,
					};
				}
				const key = masterKeyManager.getKey();
				if (!key) return { error: 'master key is locked; cannot decrypt secret to test' };
				const { decrypt } = await import('../crypto/encryption');
				try {
					bearerToken = decrypt(secret.rows[0].encrypted_value, key);
				} catch (e) {
					return {
						error: `failed to decrypt stored token: ${(e as Error).message}`,
						secret_name: secret.rows[0].name,
					};
				}
				secretName = secret.rows[0].name;
				tokenPrefix = bearerToken.slice(0, 8);
			}

			const headers: Record<string, string> = { Accept: 'application/json' };
			if (bearerToken) headers.Authorization = `Bearer ${bearerToken}`;

			let probeRes: Response;
			try {
				probeRes = await fetch(config.url, { method: 'GET', headers });
			} catch (e) {
				return {
					ok: false,
					error: `network probe failed: ${(e as Error).message}`,
					mcp_url: config.url,
					secret_name: secretName,
					token_prefix: tokenPrefix,
				};
			}
			const bodyText = await probeRes.text().catch(() => '');
			const wwwAuth = probeRes.headers.get('WWW-Authenticate') ?? null;
			return {
				ok: probeRes.ok,
				status: probeRes.status,
				mcp_url: config.url,
				secret_name: secretName,
				token_prefix: tokenPrefix,
				token_length: bearerToken?.length ?? 0,
				www_authenticate: wwwAuth,
				body_excerpt: bodyText.slice(0, 400),
				hint:
					probeRes.status === 401
						? bearerToken
							? 'Token rejected by upstream. Either the token expired, the scopes are insufficient, or the provider revoked it. Surface to the user; they may need to reconnect.'
							: 'No token sent (connector has no oauth_connection_id). OAuth never completed for this connector.'
						: probeRes.ok
							? "Token valid against upstream. If the MCP tools still don't appear in your tool list, the issue is in the container/proxy chain — file a bug with the launch-command headers and any audit_log entries for this host."
							: `Upstream returned ${probeRes.status}; check body_excerpt for details.`,
			};
		},
		db,
	);

	tool(
		server,
		'add_mcp_connection',
		"Register an MCP server (SaaS HTTP or local stdio) for this team/project. SaaS servers go into the agent's descriptor list immediately. Header values may include __HEZO_SECRET_<NAME>__ placeholders that the egress proxy substitutes at request time. Local servers must be installed before they take effect.",
		{
			team_id: z.string().describe('Team ID'),
			project_id: z
				.string()
				.optional()
				.describe('Optional project ID. Omit for a team-wide connection.'),
			name: z
				.string()
				.describe(
					'Server identifier — used as the MCP descriptor name and for de-duplication within (team, project).',
				),
			kind: z.enum(['saas', 'local']).describe('saas = HTTP MCP, local = stdio MCP'),
			config: z
				.record(z.string(), z.unknown())
				.describe('For saas: { url, headers? }. For local: { command, args?, env?, package? }.'),
		},
		async (args, db, auth) => {
			const denied = await verifyTeamAccess(db, auth, args.team_id as string);
			if (denied) return { error: denied };
			const teamId = args.team_id as string;
			const projectId = (args.project_id as string | undefined) ?? null;
			const name = String(args.name ?? '').trim();
			const kind = args.kind as 'saas' | 'local';
			const config = args.config as Record<string, unknown>;

			if (!name) return { error: 'name is required' };
			if (kind === 'saas') {
				if (!config?.url || typeof config.url !== 'string') {
					return { error: 'saas connections require config.url (string)' };
				}
			} else {
				if (!config?.command || typeof config.command !== 'string') {
					return { error: 'local connections require config.command (string)' };
				}
			}

			const initialStatus = kind === 'saas' ? 'installed' : 'pending';
			const r = await db.query<{
				id: string;
				install_status: string;
			}>(
				`INSERT INTO mcp_connections (team_id, project_id, name, kind, config, install_status)
				 VALUES ($1, $2, $3, $4::mcp_connection_kind, $5::jsonb, $6::mcp_install_status)
				 ON CONFLICT (team_id, project_id, name) DO UPDATE
				 SET kind = EXCLUDED.kind,
				     config = EXCLUDED.config,
				     install_status = EXCLUDED.install_status,
				     install_error = NULL,
				     updated_at = now()
				 RETURNING id, install_status::text AS install_status`,
				[teamId, projectId, name, kind, JSON.stringify(config), initialStatus],
			);
			return {
				id: r.rows[0].id,
				install_status: r.rows[0].install_status,
				note:
					kind === 'local'
						? 'Local MCP registered with status pending. Install via the installer or container provision before agent runs can use it.'
						: 'SaaS MCP registered. Will be available to the next agent run in this scope.',
			};
		},
		db,
	);

	tool(
		server,
		'remove_mcp_connection',
		'Remove a previously registered MCP connection. The next agent run in this scope will not see it.',
		{
			team_id: z.string().describe('Team ID'),
			id: z
				.string()
				.describe('mcp_connections.id (returned by add_mcp_connection or list_mcp_connections)'),
		},
		async (args, db, auth) => {
			const denied = await verifyTeamAccess(db, auth, args.team_id as string);
			if (denied) return { error: denied };
			const r = await db.query<{ id: string }>(
				'DELETE FROM mcp_connections WHERE id = $1 AND team_id = $2 RETURNING id',
				[args.id as string, args.team_id as string],
			);
			if (r.rows.length === 0) return { error: 'MCP connection not found' };
			return { removed: true, id: r.rows[0].id };
		},
		db,
	);

	return [...registeredTools];
}

/**
 * Whether the caller may perform team-coordination writes (summaries, team
 * contexts, prompts) for `teamId`. True for the team's own Captain and for any
 * HQ virtual member running inside the team — the latter covers the CEO/Coach
 * doing cross-team setup and coherence work.
 */
async function canCoordinateTeam(db: PGlite, auth: AuthInfo, teamId: string): Promise<boolean> {
	if (auth.type !== AuthType.Agent) return false;
	if (await isVirtualHqMemberInTeam(db, auth, teamId)) return true;
	const r = await db.query<{ slug: string }>(
		`SELECT ma.slug FROM member_agents ma
		 JOIN members m ON m.id = ma.id
		 WHERE ma.id = $1 AND m.team_id = $2`,
		[auth.memberId, teamId],
	);
	return r.rows[0]?.slug === CAPTAIN_AGENT_SLUG;
}

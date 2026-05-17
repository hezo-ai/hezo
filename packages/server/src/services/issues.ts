import type { PGlite } from '@electric-sql/pglite';
import {
	AuditAction,
	type AuditActorType,
	AuditEntityType,
	IssuePriority,
	IssueStatus,
	WakeupSource,
	wsRoom,
} from '@hezo/shared';
import { assertSubordinateAssignee } from '../lib/assignment-hierarchy';
import { auditLog } from '../lib/audit';
import { broadcastRowChange } from '../lib/broadcast';
import { hasOpenBlockers, wouldCreateCycle } from '../lib/dependencies';
import { allocateIssueIdentifier } from '../lib/issue-identifier';
import { assertChildDepthAllowed } from '../lib/issue-relationships';
import { assertOperationsAssignee } from '../lib/operations-assignee';
import { resolveIssueId } from '../lib/resolve';
import { logger } from '../logger';
import { recordIssueLinks } from './issue-events';
import { createWakeup } from './wakeup';
import type { WebSocketManager } from './ws';

const log = logger.child('issues-service');

// Bare projection of the issues table — excludes the 384-dim embedding vector
// that would otherwise inflate every response by ~4 KB of JSON noise the
// caller can't use. Shared by REST handlers, MCP tools, and this service.
export const ISSUE_COLUMNS_BARE = `id, company_id, project_id, assignee_id, parent_issue_id,
	created_by_member_id, created_by_run_id,
	number, identifier, title, description, rules,
	status, priority, labels,
	progress_summary, progress_summary_updated_at, progress_summary_updated_by,
	branch_name, runtime_type,
	created_at, updated_at`;

export interface CreateIssueInput {
	project_id: string;
	title: string;
	description?: string;
	assignee_id?: string;
	assignee_slug?: string;
	parent_issue_id?: string;
	priority?: string;
	labels?: string[];
	runtime_type?: string;
	blocked_by_issue_ids?: string[];
}

export interface CreateIssueCaller {
	actorType: AuditActorType;
	actorMemberId: string | null;
	// Set only when the caller is an agent run — drives the subordinate
	// assignee check and is recorded as created_by_run_id on the new issue.
	agentMemberId?: string;
	runId?: string;
}

export type CreateIssueErrorCode = 'INVALID_REQUEST' | 'NOT_FOUND' | 'FORBIDDEN';

export class CreateIssueError extends Error {
	readonly code: CreateIssueErrorCode;
	constructor(code: CreateIssueErrorCode, message: string) {
		super(message);
		this.code = code;
		this.name = 'CreateIssueError';
	}
}

export type IssueRow = Record<string, unknown> & { id: string; identifier: string };

export async function createIssue(
	db: PGlite,
	companyId: string,
	input: CreateIssueInput,
	caller: CreateIssueCaller,
	wsManager: WebSocketManager | undefined,
): Promise<IssueRow> {
	const title = input.title?.trim();
	if (!input.project_id || !title) {
		throw new CreateIssueError('INVALID_REQUEST', 'project_id and title are required');
	}

	let assigneeId = input.assignee_id;
	if (!assigneeId && input.assignee_slug) {
		const r = await db.query<{ id: string }>(
			`SELECT ma.id FROM member_agents ma
			 JOIN members m ON m.id = ma.id
			 WHERE ma.slug = $1 AND m.company_id = $2`,
			[input.assignee_slug, companyId],
		);
		if (r.rows.length === 0) {
			throw new CreateIssueError('NOT_FOUND', `Agent with slug '${input.assignee_slug}' not found`);
		}
		assigneeId = r.rows[0].id;
	}
	if (!assigneeId) {
		throw new CreateIssueError(
			'INVALID_REQUEST',
			'Either assignee_id or assignee_slug is required',
		);
	}

	const opsCheck = await assertOperationsAssignee(db, companyId, input.project_id, assigneeId);
	if (!opsCheck.ok) {
		throw new CreateIssueError('INVALID_REQUEST', opsCheck.message);
	}

	if (caller.agentMemberId) {
		const subordinateCheck = await assertSubordinateAssignee(db, caller.agentMemberId, assigneeId);
		if (!subordinateCheck.ok) {
			throw new CreateIssueError('FORBIDDEN', subordinateCheck.message);
		}
	}

	if (input.parent_issue_id) {
		const depthCheck = await assertChildDepthAllowed(db, companyId, input.parent_issue_id);
		if (!depthCheck.ok) {
			throw new CreateIssueError('INVALID_REQUEST', depthCheck.message);
		}
	}

	const { number: issueNumber, identifier } = await allocateIssueIdentifier(db, input.project_id);

	const r = await db.query<IssueRow>(
		`INSERT INTO issues (company_id, project_id, assignee_id, parent_issue_id,
		                     created_by_member_id, created_by_run_id,
		                     number, identifier, title, description,
		                     status, priority, labels, runtime_type)
		 VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10,
		         $11::issue_status, $12::issue_priority, $13::jsonb, $14::agent_runtime)
		 RETURNING ${ISSUE_COLUMNS_BARE}`,
		[
			companyId,
			input.project_id,
			assigneeId,
			input.parent_issue_id ?? null,
			caller.actorMemberId,
			caller.runId ?? null,
			issueNumber,
			identifier,
			title,
			input.description ?? '',
			IssueStatus.Backlog,
			input.priority ?? IssuePriority.Medium,
			JSON.stringify(input.labels ?? []),
			input.runtime_type ?? null,
		],
	);
	let issue = r.rows[0];

	if (input.blocked_by_issue_ids?.length) {
		await attachBlockers(db, companyId, issue.id, input.blocked_by_issue_ids);
		if (await hasOpenBlockers(db, issue.id)) {
			const updated = await db.query<typeof issue>(
				'UPDATE issues SET status = $1::issue_status WHERE id = $2 RETURNING *',
				[IssueStatus.Blocked, issue.id],
			);
			if (updated.rows[0]) issue = updated.rows[0];
		}
	}

	const isAgent = await db.query('SELECT id FROM member_agents WHERE id = $1', [assigneeId]);
	if (isAgent.rows.length > 0) {
		createWakeup(db, assigneeId, companyId, WakeupSource.Assignment, {
			issue_id: issue.id,
		}).catch((e) => log.error('Failed to create wakeup for assignment:', e));
	}

	broadcastRowChange(wsManager, wsRoom.company(companyId), 'issues', 'INSERT', issue);

	auditLog(
		db,
		companyId,
		caller.actorType,
		caller.actorMemberId,
		AuditAction.Created,
		AuditEntityType.Issue,
		issue.id,
		{ identifier },
	).catch((e) => log.error('Failed to write audit log for issue creation:', e));

	if (input.description) {
		recordIssueLinks(
			db,
			companyId,
			issue.id,
			input.description,
			caller.actorMemberId,
			wsManager,
		).catch((e) => log.error('Failed to record issue links from description:', e));
	}

	return issue;
}

async function attachBlockers(
	db: PGlite,
	companyId: string,
	issueId: string,
	rawIds: readonly string[],
): Promise<void> {
	const seen = new Set<string>();
	for (const raw of rawIds) {
		const trimmed = typeof raw === 'string' ? raw.trim() : '';
		if (!trimmed) continue;
		const blockerId = await resolveIssueId(db, companyId, trimmed);
		if (!blockerId) {
			throw new CreateIssueError('NOT_FOUND', `Blocking issue '${trimmed}' not found`);
		}
		if (blockerId === issueId) {
			throw new CreateIssueError('INVALID_REQUEST', 'An issue cannot block itself');
		}
		if (seen.has(blockerId)) continue;
		seen.add(blockerId);
		if (await wouldCreateCycle(db, issueId, blockerId)) {
			throw new CreateIssueError(
				'INVALID_REQUEST',
				`Adding ${trimmed} as a blocker would create a dependency cycle`,
			);
		}
		await db.query(
			`INSERT INTO issue_dependencies (issue_id, blocked_by_issue_id)
			 VALUES ($1, $2) ON CONFLICT DO NOTHING`,
			[issueId, blockerId],
		);
	}
}

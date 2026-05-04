import type { PGlite } from '@electric-sql/pglite';
import {
	ActionCommentKind,
	ApprovalStatus,
	ApprovalType,
	CommentContentType,
	OAuthRequestReason,
	PlatformType,
	WakeupSource,
	WakeupStatus,
} from '@hezo/shared';
import { logger } from '../logger';
import { createWakeup } from './wakeup';

const log = logger.child('repo-setup');

export interface RepoSetupGateCtx {
	companyId: string;
	projectId: string;
	issueId: string;
}

export interface EnsureResult {
	approvalId: string;
	commentId: string;
	approvalCreated: boolean;
	commentCreated: boolean;
	approvalRow?: Record<string, unknown>;
	commentRow?: Record<string, unknown>;
}

export async function ensureRepoSetupAction(
	db: PGlite,
	ctx: RepoSetupGateCtx,
): Promise<EnsureResult> {
	await db.query('BEGIN');
	try {
		const existingApproval = await findPendingApproval(db, ctx.companyId, ctx.projectId);
		let approvalId = existingApproval;
		let approvalCreated = false;
		if (!approvalId) {
			try {
				const ins = await db.query<{ id: string }>(
					`INSERT INTO approvals (company_id, type, status, payload)
					 VALUES ($1, $2::approval_type, $3::approval_status, $4::jsonb)
					 RETURNING id`,
					[
						ctx.companyId,
						ApprovalType.DesignatedRepoRequest,
						ApprovalStatus.Pending,
						JSON.stringify({
							platform: PlatformType.GitHub,
							reason: OAuthRequestReason.DesignatedRepo,
							project_id: ctx.projectId,
							issue_id: ctx.issueId,
						}),
					],
				);
				approvalId = ins.rows[0].id;
				approvalCreated = true;
			} catch (e) {
				const retry = await findPendingApproval(db, ctx.companyId, ctx.projectId);
				if (!retry) throw e;
				approvalId = retry;
			}
		}

		const existingComment = await db.query<{ id: string }>(
			`SELECT id FROM issue_comments
			 WHERE issue_id = $1
			   AND content_type = $2::comment_content_type
			   AND content->>'kind' = $3
			   AND content->>'approval_id' = $4
			   AND chosen_option IS NULL
			 LIMIT 1`,
			[ctx.issueId, CommentContentType.Action, ActionCommentKind.SetupRepo, approvalId],
		);

		let commentId: string;
		let commentCreated = false;
		if (existingComment.rows.length > 0) {
			commentId = existingComment.rows[0].id;
		} else {
			const ins = await db.query<{ id: string }>(
				`INSERT INTO issue_comments (issue_id, content_type, content)
				 VALUES ($1, $2::comment_content_type, $3::jsonb)
				 RETURNING id`,
				[
					ctx.issueId,
					CommentContentType.Action,
					JSON.stringify({ kind: ActionCommentKind.SetupRepo, approval_id: approvalId }),
				],
			);
			commentId = ins.rows[0].id;
			commentCreated = true;
		}

		await db.query('COMMIT');

		const result: EnsureResult = { approvalId, commentId, approvalCreated, commentCreated };
		if (approvalCreated) {
			const r = await db.query<Record<string, unknown>>('SELECT * FROM approvals WHERE id = $1', [
				approvalId,
			]);
			if (r.rows[0]) result.approvalRow = r.rows[0];
		}
		if (commentCreated) {
			const r = await db.query<Record<string, unknown>>(
				'SELECT * FROM issue_comments WHERE id = $1',
				[commentId],
			);
			if (r.rows[0]) result.commentRow = r.rows[0];
		}
		return result;
	} catch (e) {
		await db.query('ROLLBACK');
		throw e;
	}
}

async function findPendingApproval(
	db: PGlite,
	companyId: string,
	projectId: string,
): Promise<string | null> {
	const res = await db.query<{ id: string }>(
		`SELECT id FROM approvals
		 WHERE company_id = $1 AND type = $2::approval_type AND status = $3::approval_status
		   AND payload->>'project_id' = $4 AND payload->>'reason' = $5
		 LIMIT 1`,
		[
			companyId,
			ApprovalType.DesignatedRepoRequest,
			ApprovalStatus.Pending,
			projectId,
			OAuthRequestReason.DesignatedRepo,
		],
	);
	return res.rows.length > 0 ? res.rows[0].id : null;
}

export interface FinalizeInput {
	companyId: string;
	projectId: string;
	repoId: string;
	repoIdentifier: string;
	shortName: string;
}

export interface FinalizeResult {
	resolvedApprovalId: string | null;
	affectedIssueIds: string[];
	deferredWakeups: Array<{ memberId: string; issueId: string; wakeupId: string }>;
}

/**
 * Resolves the pending designated-repo approval for a project and rewrites every
 * pending setup-repo action comment attached to it. Callers must invoke the
 * post-commit orchestration (clone + container start + wakeup enqueue) after
 * this function returns.
 */
export async function finalizePendingRepoSetup(
	db: PGlite,
	input: FinalizeInput,
): Promise<FinalizeResult> {
	const approvalId = await findPendingApproval(db, input.companyId, input.projectId);
	if (!approvalId) {
		return { resolvedApprovalId: null, affectedIssueIds: [], deferredWakeups: [] };
	}

	const pendingComments = await db.query<{ id: string; issue_id: string }>(
		`SELECT ic.id, ic.issue_id FROM issue_comments ic
		 JOIN issues i ON i.id = ic.issue_id
		 WHERE ic.content_type = $1::comment_content_type
		   AND ic.content->>'kind' = $2
		   AND ic.content->>'approval_id' = $3
		   AND ic.chosen_option IS NULL
		   AND i.project_id = $4`,
		[CommentContentType.Action, ActionCommentKind.SetupRepo, approvalId, input.projectId],
	);

	const affectedIssueIds: string[] = [];
	for (const row of pendingComments.rows) {
		await db.query(`UPDATE issue_comments SET chosen_option = $1::jsonb WHERE id = $2`, [
			JSON.stringify({
				status: 'complete',
				result: {
					repo_id: input.repoId,
					repo_identifier: input.repoIdentifier,
					short_name: input.shortName,
				},
			}),
			row.id,
		]);
		await db.query(
			`INSERT INTO issue_comments (issue_id, content_type, content)
			 VALUES ($1, $2::comment_content_type, $3::jsonb)`,
			[
				row.issue_id,
				CommentContentType.System,
				JSON.stringify({
					text: `Repository ${input.repoIdentifier} set as the designated repo.`,
				}),
			],
		);
		affectedIssueIds.push(row.issue_id);
	}

	await db.query(
		`UPDATE approvals
		 SET status = $1::approval_status,
		     resolution_note = 'Auto-resolved: designated repo set',
		     resolved_at = now()
		 WHERE id = $2`,
		[ApprovalStatus.Approved, approvalId],
	);

	const deferred = await db.query<{
		id: string;
		member_id: string;
		payload: Record<string, unknown>;
	}>(
		`SELECT id, member_id, payload FROM agent_wakeup_requests
		 WHERE status = $1::wakeup_status
		   AND company_id = $2
		   AND payload->>'reason' = 'awaiting_repo_setup'
		   AND payload->>'project_id' = $3`,
		[WakeupStatus.Deferred, input.companyId, input.projectId],
	);

	const deferredWakeups = deferred.rows.map((w) => ({
		memberId: w.member_id,
		issueId: typeof w.payload.issue_id === 'string' ? w.payload.issue_id : '',
		wakeupId: w.id,
	}));

	return { resolvedApprovalId: approvalId, affectedIssueIds, deferredWakeups };
}

/**
 * Re-enqueues each deferred wakeup as a fresh Automation wakeup pointing at the
 * previously-blocked issue. The old Deferred rows are left for audit — they are
 * terminal from the wakeup queue's perspective.
 */
export async function enqueueRepoSetupResumeWakeups(
	db: PGlite,
	companyId: string,
	repoId: string,
	approvalId: string,
	deferredWakeups: FinalizeResult['deferredWakeups'],
): Promise<void> {
	for (const w of deferredWakeups) {
		if (!w.issueId) continue;
		try {
			await createWakeup(db, w.memberId, companyId, WakeupSource.Automation, {
				reason: 'repo_setup_complete',
				issue_id: w.issueId,
				approval_id: approvalId,
				repo_id: repoId,
			});
		} catch (e) {
			log.warn(`Failed to enqueue resume wakeup for member ${w.memberId}:`, e);
		}
	}
}

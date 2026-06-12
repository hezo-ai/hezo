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
import { withTransaction } from '../lib/sql';
import { logger } from '../logger';
import { createWakeup } from './wakeup';

const log = logger.child('repo-setup');

export interface RepoSetupGateCtx {
	teamId: string;
	projectId: string;
	taskId: string;
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
	const { approvalId, commentId, approvalCreated, commentCreated } = await withTransaction(
		db,
		async () => {
			const existingApproval = await findPendingApproval(db, ctx.teamId, ctx.projectId);
			let approvalId = existingApproval;
			let approvalCreated = false;
			if (!approvalId) {
				try {
					const ins = await db.query<{ id: string }>(
						`INSERT INTO approvals (team_id, type, status, payload)
						 VALUES ($1, $2::approval_type, $3::approval_status, $4::jsonb)
						 RETURNING id`,
						[
							ctx.teamId,
							ApprovalType.DesignatedRepoRequest,
							ApprovalStatus.Pending,
							JSON.stringify({
								platform: PlatformType.GitHub,
								reason: OAuthRequestReason.DesignatedRepo,
								project_id: ctx.projectId,
								task_id: ctx.taskId,
							}),
						],
					);
					approvalId = ins.rows[0].id;
					approvalCreated = true;
				} catch (e) {
					const retry = await findPendingApproval(db, ctx.teamId, ctx.projectId);
					if (!retry) throw e;
					approvalId = retry;
				}
			}

			const existingComment = await db.query<{ id: string }>(
				`SELECT id FROM task_comments
				 WHERE task_id = $1
				   AND content_type = $2::comment_content_type
				   AND content->>'kind' = $3
				   AND content->>'approval_id' = $4
				   AND chosen_option IS NULL
				 LIMIT 1`,
				[ctx.taskId, CommentContentType.Action, ActionCommentKind.SetupRepo, approvalId],
			);

			let commentId: string;
			let commentCreated = false;
			if (existingComment.rows.length > 0) {
				commentId = existingComment.rows[0].id;
			} else {
				const ins = await db.query<{ id: string }>(
					`INSERT INTO task_comments (task_id, content_type, content)
					 VALUES ($1, $2::comment_content_type, $3::jsonb)
					 RETURNING id`,
					[
						ctx.taskId,
						CommentContentType.Action,
						JSON.stringify({ kind: ActionCommentKind.SetupRepo, approval_id: approvalId }),
					],
				);
				commentId = ins.rows[0].id;
				commentCreated = true;
			}

			return { approvalId, commentId, approvalCreated, commentCreated };
		},
	);

	const result: EnsureResult = { approvalId, commentId, approvalCreated, commentCreated };
	if (approvalCreated) {
		const r = await db.query<Record<string, unknown>>('SELECT * FROM approvals WHERE id = $1', [
			approvalId,
		]);
		if (r.rows[0]) result.approvalRow = r.rows[0];
	}
	if (commentCreated) {
		const r = await db.query<Record<string, unknown>>('SELECT * FROM task_comments WHERE id = $1', [
			commentId,
		]);
		if (r.rows[0]) result.commentRow = r.rows[0];
	}
	return result;
}

async function findPendingApproval(
	db: PGlite,
	teamId: string,
	projectId: string,
): Promise<string | null> {
	const res = await db.query<{ id: string }>(
		`SELECT id FROM approvals
		 WHERE team_id = $1 AND type = $2::approval_type AND status = $3::approval_status
		   AND payload->>'project_id' = $4 AND payload->>'reason' = $5
		 LIMIT 1`,
		[
			teamId,
			ApprovalType.DesignatedRepoRequest,
			ApprovalStatus.Pending,
			projectId,
			OAuthRequestReason.DesignatedRepo,
		],
	);
	return res.rows.length > 0 ? res.rows[0].id : null;
}

export interface FinalizeInput {
	teamId: string;
	projectId: string;
	repoId: string;
	repoIdentifier: string;
}

export interface FinalizeResult {
	resolvedApprovalId: string | null;
	affectedTaskIds: string[];
	deferredWakeups: Array<{ memberId: string; taskId: string; wakeupId: string }>;
	approvalRow: Record<string, unknown> | null;
	updatedCommentRows: Record<string, unknown>[];
	systemCommentRows: Record<string, unknown>[];
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
	const approvalId = await findPendingApproval(db, input.teamId, input.projectId);
	if (!approvalId) {
		return {
			resolvedApprovalId: null,
			affectedTaskIds: [],
			deferredWakeups: [],
			approvalRow: null,
			updatedCommentRows: [],
			systemCommentRows: [],
		};
	}

	const pendingComments = await db.query<{ id: string; task_id: string }>(
		`SELECT ic.id, ic.task_id FROM task_comments ic
		 JOIN tasks i ON i.id = ic.task_id
		 WHERE ic.content_type = $1::comment_content_type
		   AND ic.content->>'kind' = $2
		   AND ic.content->>'approval_id' = $3
		   AND ic.chosen_option IS NULL
		   AND i.project_id = $4`,
		[CommentContentType.Action, ActionCommentKind.SetupRepo, approvalId, input.projectId],
	);

	const affectedTaskIds: string[] = [];
	const updatedCommentRows: Record<string, unknown>[] = [];
	const systemCommentRows: Record<string, unknown>[] = [];
	for (const row of pendingComments.rows) {
		const updated = await db.query<Record<string, unknown>>(
			`UPDATE task_comments SET chosen_option = $1::jsonb WHERE id = $2 RETURNING *`,
			[
				JSON.stringify({
					status: 'complete',
					result: {
						repo_id: input.repoId,
						repo_identifier: input.repoIdentifier,
					},
				}),
				row.id,
			],
		);
		if (updated.rows[0]) updatedCommentRows.push(updated.rows[0]);

		const sys = await db.query<Record<string, unknown>>(
			`INSERT INTO task_comments (task_id, content_type, content)
			 VALUES ($1, $2::comment_content_type, $3::jsonb)
			 RETURNING *`,
			[
				row.task_id,
				CommentContentType.System,
				JSON.stringify({
					kind: 'repo_designated',
					repo_identifier: input.repoIdentifier,
					host_type: 'github',
					text: `Repository ${input.repoIdentifier} set as the designated repo.`,
				}),
			],
		);
		if (sys.rows[0]) systemCommentRows.push(sys.rows[0]);
		affectedTaskIds.push(row.task_id);
	}

	const approvalUpdate = await db.query<Record<string, unknown>>(
		`UPDATE approvals
		 SET status = $1::approval_status,
		     resolution_note = 'Auto-resolved: designated repo set',
		     resolved_at = now()
		 WHERE id = $2
		 RETURNING *`,
		[ApprovalStatus.Approved, approvalId],
	);
	const approvalRow = approvalUpdate.rows[0] ?? null;

	const deferred = await db.query<{
		id: string;
		member_id: string;
		payload: Record<string, unknown>;
	}>(
		`SELECT id, member_id, payload FROM agent_wakeup_requests
		 WHERE status = $1::wakeup_status
		   AND team_id = $2
		   AND payload->>'reason' = 'awaiting_repo_setup'
		   AND payload->>'project_id' = $3`,
		[WakeupStatus.Deferred, input.teamId, input.projectId],
	);

	const deferredWakeups = deferred.rows.map((w) => ({
		memberId: w.member_id,
		taskId: typeof w.payload.task_id === 'string' ? w.payload.task_id : '',
		wakeupId: w.id,
	}));

	return {
		resolvedApprovalId: approvalId,
		affectedTaskIds,
		deferredWakeups,
		approvalRow,
		updatedCommentRows,
		systemCommentRows,
	};
}

/**
 * Re-enqueues each deferred wakeup as a fresh Automation wakeup pointing at the
 * previously-blocked task. The old Deferred rows are left for audit — they are
 * terminal from the wakeup queue's perspective.
 */
export async function enqueueRepoSetupResumeWakeups(
	db: PGlite,
	teamId: string,
	repoId: string,
	approvalId: string,
	deferredWakeups: FinalizeResult['deferredWakeups'],
): Promise<void> {
	for (const w of deferredWakeups) {
		if (!w.taskId) continue;
		try {
			await createWakeup(db, w.memberId, teamId, WakeupSource.Automation, {
				reason: 'repo_setup_complete',
				task_id: w.taskId,
				approval_id: approvalId,
				repo_id: repoId,
			});
		} catch (e) {
			log.warn(`Failed to enqueue resume wakeup for member ${w.memberId}:`, e);
		}
	}
}

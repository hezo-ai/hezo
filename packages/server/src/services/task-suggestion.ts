import {
	ActionCommentKind,
	ApprovalType,
	MAX_TASK_SUGGESTIONS_PER_TASK,
	type RepeatingCadence,
	ApprovalStatus as Status,
	type TaskSuggestionCadence,
	type TaskSuggestionKind,
	TERMINAL_TASK_STATUSES,
} from '@hezo/shared';
import type { Db } from '../db/database';
import { broadcastCommentFamilyChange } from '../lib/broadcast';
import { type KeyedLockRegistry, withKeyedLock } from '../lib/keyed-lock';
import { terminalStatusParams } from '../lib/sql';
import {
	insertProposalComment,
	type ProposalCommentSpec,
	type ProposalResolution,
	resolveProposalCommentAndWake,
} from './proposal-comment';
import type { WebSocketManager } from './ws';

/** The label on the CEO's suggestions task, the only task a suggestion attaches to. */
export const TASK_SUGGESTIONS_LABEL = 'task-suggestions';

/**
 * One key per suggestions task: {@link fileTaskSuggestion} reads the card count
 * and the pending titles, then inserts, so parallel calls on one task take
 * turns. Other tasks are not held; each holder runs a few queries.
 */
const taskSuggestionsLocks: KeyedLockRegistry = new Map();

/** Longest description excerpt a card's stored snapshot keeps; the approval holds the rest. */
const SNAPSHOT_DESCRIPTION_MAX_CHARS = 280;

/**
 * A CEO task suggestion, carried in the pending `approvals` row's payload. It is
 * NOT a task: the real task is created only when the admin approves (see the
 * `task_suggestion` approval handler). Mirrors the goal-suggestion flow.
 */
export interface TaskSuggestionPayload {
	project_id: string;
	kind: TaskSuggestionKind;
	title: string;
	description?: string;
	/** The CEO's cadence. Never changes; decides whether the card offers a choice. */
	suggested_cadence?: RepeatingCadence | null;
	/** The current choice, seeded from `suggested_cadence` and changed on the card. */
	cadence?: TaskSuggestionCadence | null;
	/** The suggestions task the card sits on and the resolution wake returns to. */
	task_id: string;
}

/** Insert a pending `task_suggestion` approval carrying the proposed task. */
export async function insertTaskSuggestionApproval(
	db: Db,
	teamId: string,
	payload: TaskSuggestionPayload,
	requestedByMemberId: string | null,
): Promise<Record<string, unknown>> {
	const result = await db.query<Record<string, unknown>>(
		`INSERT INTO approvals (team_id, type, requested_by_member_id, payload, status)
		 VALUES ($1, $2::approval_type, $3, $4::jsonb, $5::approval_status)
		 RETURNING *`,
		[
			teamId,
			ApprovalType.TaskSuggestion,
			requestedByMemberId,
			JSON.stringify(payload),
			Status.Pending,
		],
	);
	return result.rows[0];
}

export type FileTaskSuggestionResult =
	| { ok: true; approval: Record<string, unknown>; card: Record<string, unknown> | null }
	| { ok: false; error: string };

/**
 * File one suggestion on its suggestions task: refuse it past the per-task cap
 * or when its title matches an open task or a pending suggestion, else insert
 * the approval and its card in one transaction. The caller broadcasts both.
 */
export async function fileTaskSuggestion(
	db: Db,
	params: { teamId: string; payload: TaskSuggestionPayload; requestedByMemberId: string | null },
): Promise<FileTaskSuggestionResult> {
	const { teamId, payload, requestedByMemberId } = params;
	return withKeyedLock(taskSuggestionsLocks, payload.task_id, async () => {
		const filed = await db.query<{ n: number }>(
			`SELECT COUNT(*)::int AS n FROM task_comments
			 WHERE task_id = $1 AND content->>'kind' = $2`,
			[payload.task_id, ActionCommentKind.TaskSuggestion],
		);
		if ((filed.rows[0]?.n ?? 0) >= MAX_TASK_SUGGESTIONS_PER_TASK) {
			return {
				ok: false,
				error: `This task already has ${MAX_TASK_SUGGESTIONS_PER_TASK} suggestions, the most one task takes.`,
			};
		}

		// Bounded by the project's tasks (project index) and the team's pending
		// approvals (team + status index); runs once per suggestion.
		const terminal = terminalStatusParams(6);
		const dup = await db.query<{ source: string }>(
			`SELECT 'task' AS source FROM tasks
			 WHERE project_id = $1 AND LOWER(BTRIM(title)) = LOWER($2)
			   AND status NOT IN (${terminal.placeholders})
			 UNION ALL
			 SELECT 'suggestion' FROM approvals
			 WHERE team_id = $3 AND status = $4::approval_status AND type = $5::approval_type
			   AND LOWER(BTRIM(payload->>'title')) = LOWER($2)
			 LIMIT 1`,
			[
				payload.project_id,
				payload.title,
				teamId,
				Status.Pending,
				ApprovalType.TaskSuggestion,
				...terminal.values,
			],
		);
		if (dup.rows[0]) {
			return {
				ok: false,
				error:
					dup.rows[0].source === 'task'
						? `An open task in this project already has the title "${payload.title}".`
						: `A pending suggestion in this project already has the title "${payload.title}".`,
			};
		}

		return db.transaction(async (): Promise<FileTaskSuggestionResult> => {
			// The same row lock `update_task` takes to close the task: a close and a
			// filing take turns, so no card lands on a task that just closed, and a
			// close never misses a card filed just before it.
			const host = await db.query<{ status: string }>(
				'SELECT status::text AS status FROM tasks WHERE id = $1 FOR UPDATE',
				[payload.task_id],
			);
			const status = host.rows[0]?.status;
			if (!status || (TERMINAL_TASK_STATUSES as readonly string[]).includes(status)) {
				return { ok: false, error: 'The suggestions task is no longer open.' };
			}
			const approval = await insertTaskSuggestionApproval(db, teamId, payload, requestedByMemberId);
			const card = await insertTaskSuggestionComment(db, {
				taskId: payload.task_id,
				approvalId: approval.id as string,
				payload: payload as unknown as Record<string, unknown>,
				teamId,
				projectId: payload.project_id,
			});
			return { ok: true, approval, card };
		});
	});
}

/** The display snapshot stored in a task-suggestion action comment's `content`. */
function buildContentSnapshot(payload: Record<string, unknown>): Record<string, unknown> {
	const description = typeof payload.description === 'string' ? payload.description : '';
	return {
		title: payload.title ?? '',
		// Not `kind`: that key names the comment's action kind.
		suggestion_kind: payload.kind ?? null,
		description:
			description.length > SNAPSHOT_DESCRIPTION_MAX_CHARS
				? `${description.slice(0, SNAPSHOT_DESCRIPTION_MAX_CHARS).trimEnd()}…`
				: description,
		suggested_cadence: payload.suggested_cadence ?? null,
		cadence: payload.cadence ?? null,
	};
}

/**
 * A task suggestion as a proposal-style approval. No assignee fallback: every
 * suggestion is filed by the CEO through `suggest_task`.
 */
const TASK_SUGGESTION: ProposalCommentSpec = {
	kind: ActionCommentKind.TaskSuggestion,
	wakeReason: 'task_suggestion_resolved',
	wakeKeyPrefix: 'task-suggestion-resolved',
	snapshot: buildContentSnapshot,
	wakeTaskAssigneeWhenRequesterIsHuman: false,
};

/**
 * Post the suggestion's `action` comment (`kind: 'task_suggestion'`) on the
 * suggestions task, carrying the approval id, so the thread shows the card with
 * Approve and Deny beside the inbox row.
 */
export async function insertTaskSuggestionComment(
	db: Db,
	params: {
		taskId: string;
		approvalId: string;
		payload: Record<string, unknown>;
		teamId: string;
		projectId: string;
	},
	wsManager?: WebSocketManager,
): Promise<Record<string, unknown> | null> {
	return insertProposalComment(db, TASK_SUGGESTION, params, wsManager);
}

/**
 * Flip the suggestion's comment to created/denied and re-wake the CEO, so it can
 * close its suggestions task once no card is pending.
 */
export async function resolveTaskSuggestionCommentAndWake(
	db: Db,
	params: {
		approval: Record<string, unknown>;
		status: ProposalResolution;
		created?: { id: string; identifier: string; blockedByIdentifier: string | null } | null;
		resolutionNote?: string | null;
	},
	wsManager?: WebSocketManager,
): Promise<void> {
	const { approval, status, created, resolutionNote } = params;
	return resolveProposalCommentAndWake(
		db,
		TASK_SUGGESTION,
		{
			approval,
			status,
			chosenExtra: created
				? {
						created_task_id: created.id,
						created_task_identifier: created.identifier,
						blocked_by_identifier: created.blockedByIdentifier,
					}
				: undefined,
			resolutionNote,
		},
		wsManager,
	);
}

/**
 * Refresh the pending card's stored snapshot after the admin changes the
 * cadence, so every viewer's card shows the choice the approval now carries.
 * Scoped to the suggestions task, so the lookup reads only that task's comments.
 */
export async function refreshTaskSuggestionComment(
	db: Db,
	approval: Record<string, unknown>,
	wsManager?: WebSocketManager,
): Promise<void> {
	const payload = (approval.payload ?? {}) as Record<string, unknown>;
	if (typeof payload.task_id !== 'string') return;
	const updated = await db.query<Record<string, unknown>>(
		`UPDATE task_comments
		 SET content = content || $1::jsonb
		 WHERE task_id = $2
		   AND content->>'kind' = $3
		   AND content->>'approval_id' = $4
		   AND chosen_option IS NULL
		 RETURNING *`,
		[
			JSON.stringify(buildContentSnapshot(payload)),
			payload.task_id,
			ActionCommentKind.TaskSuggestion,
			approval.id as string,
		],
	);
	if (typeof payload.project_id !== 'string') return;
	for (const row of updated.rows) {
		broadcastCommentFamilyChange(
			wsManager,
			approval.team_id as string,
			payload.project_id,
			'task_comments',
			'UPDATE',
			row,
		);
	}
}

import type { Db } from '../db/database';

export type AssignmentHierarchyCheck = { ok: true } | { ok: false; message: string };

export function assignmentHierarchyError(assigneeSlug: string): string {
	return `Cannot assign to @${assigneeSlug}: agents can only assign work to a direct subordinate (or themselves). Do not route around this by assigning the task to @${assigneeSlug}'s manager as a stand-in with a "please reassign" note — that lands work on the wrong owner and distorts the board. Instead: post a create_comment with @${assigneeSlug} (on this task or the most relevant open one) describing the work, and let them open their own task. If you are planning a multi-step chain that runs below your direct reports, hand the responsible direct report a single breakdown task; when it lands, they create and fan out their subtree's tasks.`;
}

/**
 * Enforce that an agent caller may only assign tasks to its direct subordinates.
 * Self-assignment is always allowed. Non-agent assignees (human members) are
 * unaffected — the rule is specifically about agent-to-agent delegation.
 *
 * Caller must already be authenticated as AuthType.Agent; the check is a no-op
 * for admin / API-key auth and should be gated by the caller.
 */
export async function assertSubordinateAssignee(
	db: Db,
	callerMemberId: string,
	assigneeId: string,
): Promise<AssignmentHierarchyCheck> {
	if (callerMemberId === assigneeId) return { ok: true };

	const result = await db.query<{ slug: string; reports_to: string | null }>(
		`SELECT slug, reports_to FROM member_agents WHERE id = $1`,
		[assigneeId],
	);
	if (result.rows.length === 0) return { ok: true };

	const row = result.rows[0];
	if (row.reports_to === callerMemberId) return { ok: true };
	return { ok: false, message: assignmentHierarchyError(row.slug) };
}

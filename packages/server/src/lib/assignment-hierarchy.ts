import type { PGlite } from '@electric-sql/pglite';

export type AssignmentHierarchyCheck = { ok: true } | { ok: false; message: string };

export function assignmentHierarchyError(assigneeSlug: string): string {
	return `Cannot assign to @${assigneeSlug}: agents can only assign work to their direct subordinates. To request work from someone outside your direct reports, use create_comment with @${assigneeSlug} on an existing ticket they own (or one they would naturally pick up).`;
}

/**
 * Enforce that an agent caller may only assign issues to its direct subordinates.
 * Self-assignment is always allowed. Non-agent assignees (human members) are
 * unaffected — the rule is specifically about agent-to-agent delegation.
 *
 * Caller must already be authenticated as AuthType.Agent; the check is a no-op
 * for board / API-key auth and should be gated by the caller.
 */
export async function assertSubordinateAssignee(
	db: PGlite,
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

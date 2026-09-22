import { MembershipRole } from '@hezo/shared';

/**
 * SQL: whether the user at `userExpr` is an admin of the team at `teamExpr` - a
 * superuser, or a member of that team whose role is admin. The one definition of
 * "the admin": who an `@admin` notice reaches, and whose word releases a hold
 * that only the admin may lift. False for a NULL user.
 */
export function isAdminUserSql(userExpr: string, teamExpr: string): string {
	return `(EXISTS (SELECT 1 FROM users au WHERE au.id = ${userExpr} AND au.is_superuser)
	  OR EXISTS (
	    SELECT 1 FROM member_users amu
	      JOIN members am ON am.id = amu.id
	     WHERE amu.user_id = ${userExpr}
	       AND amu.role = '${MembershipRole.Admin}'::membership_role
	       AND am.team_id = ${teamExpr}))`;
}

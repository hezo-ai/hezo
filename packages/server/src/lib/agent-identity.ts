/**
 * Server-side helpers for an agent's identity: the human name that displays in
 * place of its role, and the spec its avatar is drawn from.
 *
 * The rules here are enforced identically by every write path (the REST PATCH and
 * the `set_agent_name` MCP tool), so they live in one place rather than being
 * restated per route.
 */

import { randomUUID } from 'node:crypto';
import {
	type AgentGender,
	type AvatarSpec,
	DEFAULT_TEAM_ID,
	humanNameError,
	isNameOnlyRole,
	isReservedAgentSlug,
	makeAvatarSpec,
} from '@hezo/shared';
import type { Db } from '../db/database';
import { toSlug } from './slug';

export { isNameOnlyRole };

/**
 * SQL for what an agent is *called*: its human name when it has one, else its
 * role. Used by every `*_name` projection in a feed, so a comment shows "Max"
 * rather than "Engineer". Fields named `*_title` keep reading the role.
 *
 * Takes the table alias because the joins differ per query.
 */
export function agentDisplayNameSql(alias: string): string {
	return `NULLIF(${alias}.human_name, '')`;
}

/** Why a human name was refused. `null` means it is available. */
export type HumanNameRejection = { code: 'INVALID' | 'RESERVED' | 'TAKEN'; message: string };

/**
 * Validate a proposed human name and check it is free within the agent's reach.
 *
 * "Free" spans the agent's own team plus HQ, because that is exactly the set a
 * mention resolves against - two agents an author can reach with the same handle
 * would make `@max` ambiguous. Checked against role slugs as well as other human
 * names, since both are mention handles.
 *
 * Uniqueness is enforced here rather than by a unique index: the scope is
 * team-plus-HQ rather than global, which no single index expresses. Callers MUST
 * run this inside the same transaction as the write, or two concurrent renames
 * could both pass.
 */
export async function checkHumanNameAvailable(
	db: Db,
	input: { teamId: string; name: string; excludeMemberId?: string },
): Promise<HumanNameRejection | null> {
	const trimmed = input.name.trim();
	if (!trimmed) return null;

	const invalid = humanNameError(trimmed);
	if (invalid) return { code: 'INVALID', message: invalid };

	const slug = toSlug(trimmed);
	if (!slug) {
		return { code: 'INVALID', message: 'Name must contain a letter or digit' };
	}
	if (isReservedAgentSlug(slug) || isNameOnlyRole(slug)) {
		return { code: 'RESERVED', message: `"${trimmed}" is reserved and cannot be used as a name` };
	}

	const clash = await db.query<{ slug: string }>(
		`SELECT ma.slug FROM member_agents ma
		 JOIN members m ON m.id = ma.id
		 WHERE (m.team_id = $1 OR m.team_id = $2)
		   AND (ma.slug = $3 OR ma.human_name_slug = $3)
		   AND ($4::uuid IS NULL OR ma.id <> $4::uuid)
		 LIMIT 1`,
		[input.teamId, DEFAULT_TEAM_ID, slug, input.excludeMemberId ?? null],
	);
	if (clash.rows[0]) {
		return {
			code: 'TAKEN',
			message: `"${trimmed}" is already taken by another teammate`,
		};
	}
	return null;
}

/**
 * Set (or clear, with an empty name) an agent's human name, keeping its mention
 * handle and the label the server renders it under in step. Caller is
 * responsible for validating via `checkHumanNameAvailable` in the same
 * transaction.
 */
export async function applyAgentHumanName(
	db: Db,
	memberId: string,
	name: string,
	gender?: AgentGender | null,
): Promise<void> {
	const trimmed = name.trim();
	const humanName = trimmed || null;
	await db.query(
		`UPDATE member_agents
		 SET human_name = $2, human_name_slug = $3, gender = COALESCE($4, gender), updated_at = now()
		 WHERE id = $1`,
		[memberId, humanName, humanName ? toSlug(humanName) : null, gender ?? null],
	);
	// `display_name` is the server-side label for the member, so it follows what
	// the agent is actually called.
	await db.query(
		`UPDATE members SET display_name = COALESCE($2, (SELECT title FROM member_agents WHERE id = $1))
		 WHERE id = $1`,
		[memberId, humanName],
	);
}

/**
 * A freshly-randomised avatar for an agent, composed server-side.
 *
 * Only the seed is ever chosen freely: the gender and the role's outfit family
 * are derived from the agent, so a caller cannot dress an agent as a Captain or
 * contradict its name. `seed` lets a human pick one of the options they were
 * shown; omitting it generates a new face.
 */
export function buildAgentAvatarSpec(agent: {
	slug: string;
	title: string;
	gender: AgentGender | null;
	seed?: string;
}): AvatarSpec {
	return makeAvatarSpec({
		seed: agent.seed?.trim() || randomUUID(),
		gender: agent.gender ?? 'n',
		roleSlug: agent.slug,
		roleTitle: agent.title,
	});
}

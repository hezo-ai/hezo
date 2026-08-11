/**
 * Export a **live team's current state** as a self-contained marketplace team
 * bundle (`MarketplaceTeamDef`) — the inverse of `applyMarketplaceTeamToTeam`.
 * A user who has evolved a team's roster and prompts can download the bundle and
 * send it to the Hezo authors on GitHub to have it published to the marketplace.
 *
 * The bundle captures exactly what a marketplace team ships: the team metadata,
 * the Captain override (its partial-resolved system prompt + team context), and
 * the rest of the roster (each role's prompt, budgets, effort, and reporting
 * line). It deliberately ships **only** roster + prompts — never skills, MCP
 * servers, secrets, or project config, which are configured per project and are
 * not part of a team template (see `.dev/architecture.md` § Team marketplace).
 *
 * Discovery `keywords` are generated from the team's own text (only Hezo's
 * built-in teams carry a hand-authored list); `version` starts at 1. The Hezo
 * authors' `build:marketplace` re-derives the content hash, version, and
 * validation when the bundle lands in the repo — so this export is a starting
 * point for a published team, not a signed artifact.
 */

import type { AgentEffort, AgentGender, AvatarSpec } from '@hezo/shared';
import {
	CAPTAIN_AGENT_SLUG,
	generateTeamKeywords,
	inferGender,
	MARKETPLACE_SCHEMA_VERSION,
	type MarketplaceCaptainOverride,
	type MarketplaceRosterAgent,
	type MarketplaceTeamDef,
	makeAvatarSpec,
	RESERVED_ROSTER_SLUGS,
} from '@hezo/shared';
import type { Db } from '../db/database';
import { toSlug } from '../lib/slug';
import { getAgentSystemPrompt } from './documents';
import { computeContentHash } from './marketplace-build';

/** Note attached to the exported bundle's initial changelog entry. */
export const EXPORTED_TEAM_CHANGELOG_NOTE = 'Exported from a live Hezo team.';

/** A team that cannot be turned into a marketplace bundle (e.g. it has no Captain). */
export class TeamBundleExportError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'TeamBundleExportError';
	}
}

interface MemberRow {
	id: string;
	slug: string;
	title: string;
	human_name: string | null;
	gender: AgentGender | null;
	avatar_spec: AvatarSpec | null;
	role_description: string;
	summary: string;
	team_context: string;
	default_effort: AgentEffort;
	heartbeat_interval_min: number;
	run_timeout_min: number;
	monthly_budget_cents: number;
	daily_budget_cents: number;
	weekly_budget_cents: number;
	touches_code: boolean;
	reports_to: string | null;
}

/**
 * Assemble a `MarketplaceTeamDef` from a team's live DB state. Throws a
 * `TeamBundleExportError` when the team has no Captain (a marketplace team's
 * Captain override is required) or the team row is missing.
 */
export async function exportTeamBundle(db: Db, teamId: string): Promise<MarketplaceTeamDef> {
	const teamRes = await db.query<{
		name: string;
		slug: string;
		description: string;
		summary: string;
	}>('SELECT name, slug, description, summary FROM teams WHERE id = $1', [teamId]);
	const team = teamRes.rows[0];
	if (!team) throw new TeamBundleExportError('Team not found');

	// Every agent member of this team, oldest first for a stable roster order.
	// Cross-team instance agents (CEO/Coach) live in HQ, not here, so this scope
	// already excludes them; the reserved-slug filter below is belt-and-braces.
	const membersRes = await db.query<MemberRow>(
		`SELECT ma.id, ma.slug, ma.title, ma.human_name, ma.gender, ma.avatar_spec,
		        ma.role_description, ma.summary, ma.team_context,
		        ma.default_effort::text AS default_effort,
		        ma.heartbeat_interval_min, ma.run_timeout_min,
		        ma.monthly_budget_cents, ma.daily_budget_cents, ma.weekly_budget_cents,
		        ma.touches_code, ma.reports_to
		 FROM member_agents ma
		 JOIN members m ON m.id = ma.id
		 WHERE m.team_id = $1
		 ORDER BY m.created_at ASC, ma.title ASC`,
		[teamId],
	);
	const members = membersRes.rows;
	const idToSlug = new Map(members.map((m) => [m.id, m.slug]));

	const captainRow = members.find((m) => m.slug === CAPTAIN_AGENT_SLUG);
	if (!captainRow) {
		throw new TeamBundleExportError(
			'This team has no Captain and cannot be exported as a marketplace bundle',
		);
	}

	const captain: MarketplaceCaptainOverride = {
		system_prompt: await getAgentSystemPrompt(db, teamId, captainRow.id),
		team_context: captainRow.team_context,
	};

	const rosterRows = members.filter(
		(m) => m.slug !== CAPTAIN_AGENT_SLUG && !RESERVED_ROSTER_SLUGS.includes(m.slug),
	);
	const rosterSlugs = new Set(rosterRows.map((m) => m.slug));

	// Map a member's `reports_to` (a member id) to a slug the marketplace roster
	// understands: the Captain, or another roster role. A reporting line to anyone
	// out of the roster (a deleted member, or a cross-team instance agent) becomes
	// null — the top of the roster — rather than inventing a Captain link.
	const resolveReportsToSlug = (reportsTo: string | null): string | null => {
		if (!reportsTo) return null;
		const slug = idToSlug.get(reportsTo);
		if (!slug) return null;
		if (slug === CAPTAIN_AGENT_SLUG) return CAPTAIN_AGENT_SLUG;
		return rosterSlugs.has(slug) ? slug : null;
	};

	const roster: MarketplaceRosterAgent[] = [];
	let sortOrder = 1;
	for (const m of rosterRows) {
		roster.push({
			slug: m.slug,
			title: m.title,
			// The team travels with the people on it: whatever this project named
			// the role and whichever avatar it settled on is what a project
			// provisioned from the exported bundle will start with.
			human_name: m.human_name,
			gender: m.gender ?? inferGender(m.human_name),
			avatar_spec:
				m.avatar_spec ??
				makeAvatarSpec({
					seed: m.id,
					gender: m.gender ?? inferGender(m.human_name),
					roleSlug: m.slug,
					roleTitle: m.title,
				}),
			reports_to_slug: resolveReportsToSlug(m.reports_to),
			sort_order: sortOrder++,
			role_description: m.role_description,
			summary: m.summary,
			team_context: m.team_context,
			system_prompt: await getAgentSystemPrompt(db, teamId, m.id),
			default_effort: m.default_effort,
			heartbeat_interval_min: m.heartbeat_interval_min,
			run_timeout_min: m.run_timeout_min,
			monthly_budget_cents: m.monthly_budget_cents,
			daily_budget_cents: m.daily_budget_cents,
			weekly_budget_cents: m.weekly_budget_cents,
			touches_code: m.touches_code,
		});
	}

	const summary = team.summary?.trim() ?? '';
	// A team's `description` is often blank (it's optional); fall back to the
	// auto-generated summary so the exported bundle still describes itself.
	const description = team.description?.trim() || summary;

	const keywords = generateTeamKeywords([
		team.name,
		description,
		summary,
		...roster.map((r) => r.title),
		...roster.map((r) => r.role_description),
	]);

	const content = {
		slug: toSlug(team.slug || team.name),
		name: team.name,
		description,
		summary,
		captain,
		roster,
	};

	return {
		schema_version: MARKETPLACE_SCHEMA_VERSION,
		slug: content.slug,
		name: content.name,
		description: content.description,
		summary: content.summary,
		keywords,
		version: 1,
		content_hash: computeContentHash(content),
		changelog: [{ version: 1, notes: EXPORTED_TEAM_CHANGELOG_NOTE }],
		captain,
		roster,
	};
}

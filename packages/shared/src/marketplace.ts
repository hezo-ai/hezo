/**
 * Distribution format for **marketplace team templates** — the self-contained
 * JSON (one per team) that Hezo ships in the repo's `marketplace/` folder and
 * that instances fetch (GitHub raw in production, the local folder in dev, the
 * embedded `teams-bundle.json` snapshot as an offline fallback).
 *
 * These are the shared, dependency-free **types**. The server
 * (`packages/server/src/services/marketplace.ts`) owns the zod parsing/validation
 * at the untrusted fetch boundary; the web app imports the same types to render
 * the marketplace UI. Keep this file pure (no runtime deps) so it stays in the
 * `@hezo/shared` pure-logic tier.
 */

import { CAPTAIN_AGENT_SLUG, CEO_AGENT_SLUG, COACH_AGENT_SLUG } from './constants.js';
import type { AgentEffort } from './types/common.js';

/**
 * Current distribution-format version. Bumped only when the JSON *shape* changes
 * incompatibly; a loader that reads a higher `schema_version` than it knows must
 * refuse the file (and fall back to its embedded snapshot). Distinct from a
 * team's own `version`, which tracks the team's *content*.
 */
export const MARKETPLACE_SCHEMA_VERSION = 1;

/**
 * Slugs that can never appear in a marketplace team's `roster`: the Captain is
 * provisioned via the builtin path (its prompt rides in the top-level `captain`
 * override), and the CEO/Coach are instance-level singletons that live in HQ,
 * never in a team template. The build rejects a roster entry using any of these.
 */
export const RESERVED_ROSTER_SLUGS: readonly string[] = [
	CAPTAIN_AGENT_SLUG,
	CEO_AGENT_SLUG,
	COACH_AGENT_SLUG,
];

/** One changelog entry: the integer version it describes and optional notes. */
export interface MarketplaceChangelogEntry {
	version: number;
	notes: string;
}

/**
 * A skill shipped with a team template — inline (`content`) or downloaded
 * (`source_url`) at provision time. Mirrors the server's `TemplateSkillConfig`.
 */
export interface MarketplaceSkillConfig {
	name?: string;
	title?: string;
	slug?: string;
	description?: string;
	content?: string;
	source_url?: string;
}

/** A single non-builtin roster role, fully self-contained. */
export interface MarketplaceRosterAgent {
	slug: string;
	title: string;
	/** A sibling roster slug, or null for the top of the roster. */
	reports_to_slug: string | null;
	sort_order: number;
	role_description: string;
	summary: string;
	team_context: string;
	/**
	 * Partial-resolved markdown with `{{...}}` runtime placeholders still intact
	 * and WITHOUT `SHARED_INSTRUCTIONS` (appended at run time). This is exactly
	 * what lands in the provisioned agent's `agent_system_prompt` document.
	 */
	system_prompt: string;
	default_effort: AgentEffort;
	heartbeat_interval_min: number;
	run_timeout_min: number;
	monthly_budget_cents: number;
	daily_budget_cents: number;
	weekly_budget_cents: number;
	touches_code: boolean;
}

/**
 * The Captain override carried by a marketplace team. Applied via the builtin
 * captain path (the Captain keeps its `agent_type_id` + reports-to-CEO link);
 * only its prompt + team context come from the team.
 */
export interface MarketplaceCaptainOverride {
	system_prompt: string;
	team_context: string;
}

/** One self-contained marketplace team definition (`marketplace/teams/<slug>.json`). */
export interface MarketplaceTeamDef {
	schema_version: number;
	/** Stable id, also the filename. */
	slug: string;
	name: string;
	description: string;
	/** Team-level narrative (the team summary shown to agents). */
	summary: string;
	/** Unsigned integer, auto-incremented by the build when content changes. */
	version: number;
	/** sha256 of the canonical def MINUS version/changelog/content_hash/schema_version. */
	content_hash: string;
	/** Newest-first version history; an entry per version is optional but recommended. */
	changelog: MarketplaceChangelogEntry[];
	skills_config: MarketplaceSkillConfig[];
	mcp_servers: unknown[];
	mpp_config: Record<string, unknown>;
	captain: MarketplaceCaptainOverride;
	/** Non-builtin roles only — never captain/coach/ceo (see RESERVED_ROSTER_SLUGS). */
	roster: MarketplaceRosterAgent[];
}

/** One row in the catalog manifest (`marketplace/index.json`). */
export interface MarketplaceIndexEntry {
	slug: string;
	name: string;
	description: string;
	summary: string;
	version: number;
	/** Total number of roles in the team, INCLUDING the always-present Captain. */
	roster_count: number;
	/** The newest changelog entry's notes, for a one-line list-page hint. */
	latest_notes: string;
}

/** The catalog manifest listing every available marketplace team. */
export interface MarketplaceIndex {
	schema_version: number;
	teams: MarketplaceIndexEntry[];
}

/** Derive a catalog entry from a full team def. */
export function toMarketplaceIndexEntry(def: MarketplaceTeamDef): MarketplaceIndexEntry {
	const latest = def.changelog.find((c) => c.version === def.version);
	return {
		slug: def.slug,
		name: def.name,
		description: def.description,
		summary: def.summary,
		version: def.version,
		// +1 for the Captain, which every team has but which lives outside `roster`.
		roster_count: def.roster.length + 1,
		latest_notes: latest?.notes ?? '',
	};
}

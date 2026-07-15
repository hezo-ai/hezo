/**
 * Pure assembly + versioning logic for marketplace team templates. The build
 * script (`packages/server/scripts/build-marketplace-teams.ts`) does the
 * filesystem I/O and calls into here; tests import these helpers directly. No
 * filesystem or network access lives in this module so it stays deterministic
 * and testable (mirrors the `scripts/coverage/lcov.ts` split).
 */

import { createHash } from 'node:crypto';
import {
	MARKETPLACE_SCHEMA_VERSION,
	type MarketplaceCaptainOverride,
	type MarketplaceChangelogEntry,
	type MarketplaceRosterAgent,
	type MarketplaceTeamDef,
	RESERVED_ROSTER_SLUGS,
	requiredSystemPromptVarsError,
} from '@hezo/shared';

/**
 * A hand-authored per-team manifest (`agents/<team>/team.json`): the structured
 * roster + team metadata the build can't derive from the markdown prompt bodies.
 * Prompt bodies are NOT stored here — they are read from `agents/<team>/<slug>.md`
 * at build time. `captain` carries only its team context (its prompt comes from
 * `agents/<team>/captain.md`).
 */
export interface TeamManifest {
	schema_version: number;
	slug: string;
	name: string;
	description: string;
	summary: string;
	changelog: MarketplaceChangelogEntry[];
	captain: { team_context: string };
	roster: Array<Omit<MarketplaceRosterAgent, 'system_prompt'>>;
}

/** The content fields that feed the content hash (everything but version/changelog/hash). */
interface TeamContent {
	slug: string;
	name: string;
	description: string;
	summary: string;
	captain: MarketplaceCaptainOverride;
	roster: MarketplaceRosterAgent[];
}

/** Recursively sort object keys and normalize line endings so the hash is stable. */
function canonicalize(value: unknown): unknown {
	if (Array.isArray(value)) return value.map(canonicalize);
	if (value && typeof value === 'object') {
		const out: Record<string, unknown> = {};
		for (const key of Object.keys(value as Record<string, unknown>).sort()) {
			out[key] = canonicalize((value as Record<string, unknown>)[key]);
		}
		return out;
	}
	if (typeof value === 'string') return value.replace(/\r\n/g, '\n');
	return value;
}

/**
 * sha256 over the canonicalized content (keys sorted, arrays in a defined order,
 * `\n` line endings), excluding `version`/`changelog`/`content_hash`/`schema_version`.
 * Order-independent for `roster` (by sort_order then slug) so authoring order never
 * causes a spurious version bump.
 */
export function computeContentHash(content: TeamContent): string {
	const hashInput = {
		slug: content.slug,
		name: content.name,
		description: content.description,
		summary: content.summary,
		captain: content.captain,
		roster: [...content.roster].sort(
			(a, b) => a.sort_order - b.sort_order || a.slug.localeCompare(b.slug),
		),
	};
	const json = JSON.stringify(canonicalize(hashInput));
	return createHash('sha256').update(json).digest('hex');
}

/**
 * Resolve the team's version + changelog against the previously-committed def.
 * Version auto-increments on any content-hash change; the manifest's changelog is
 * authoritative for the notes text, and an entry for the current version is
 * ensured (a stub `{version, notes:''}` is added if the author didn't supply one).
 */
export function reconcileVersionAndChangelog(
	prev: MarketplaceTeamDef | null,
	contentHash: string,
	manifestChangelog: MarketplaceChangelogEntry[],
): { version: number; changelog: MarketplaceChangelogEntry[] } {
	let version: number;
	if (!prev) version = 1;
	else if (prev.content_hash === contentHash) version = prev.version;
	else version = prev.version + 1;

	const notesByVersion = new Map<number, string>();
	for (const entry of manifestChangelog) notesByVersion.set(entry.version, entry.notes);
	if (!notesByVersion.has(version)) notesByVersion.set(version, '');

	const changelog = [...notesByVersion.entries()]
		.map(([v, notes]) => ({ version: v, notes }))
		.sort((a, b) => b.version - a.version);

	return { version, changelog };
}

/**
 * Assemble a full, self-contained marketplace team def from its manifest and a
 * prompt resolver (`roleSlug → partial-resolved markdown`). Throws on a reserved
 * roster slug, a missing prompt body, or a prompt missing a required `{{...}}`
 * substitution variable — so authoring errors fail the build.
 */
export function buildTeamDef(
	manifest: TeamManifest,
	promptFor: (roleSlug: string) => string | undefined,
	prev: MarketplaceTeamDef | null,
): MarketplaceTeamDef {
	const validatePrompt = (label: string, prompt: string | undefined): string => {
		if (!prompt?.trim()) {
			throw new Error(`Team "${manifest.slug}": missing system prompt for ${label}`);
		}
		const err = requiredSystemPromptVarsError(prompt);
		if (err) throw new Error(`Team "${manifest.slug}" ${label}: ${err}`);
		return prompt;
	};

	const captain: MarketplaceCaptainOverride = {
		system_prompt: validatePrompt('captain', promptFor('captain')),
		team_context: manifest.captain.team_context,
	};

	const roster: MarketplaceRosterAgent[] = [...manifest.roster]
		.sort((a, b) => a.sort_order - b.sort_order || a.slug.localeCompare(b.slug))
		.map((entry) => {
			if (RESERVED_ROSTER_SLUGS.includes(entry.slug)) {
				throw new Error(
					`Team "${manifest.slug}": roster may not contain reserved slug "${entry.slug}" (captain/coach/ceo are provisioned separately)`,
				);
			}
			return { ...entry, system_prompt: validatePrompt(entry.slug, promptFor(entry.slug)) };
		});

	const content: TeamContent = {
		slug: manifest.slug,
		name: manifest.name,
		description: manifest.description,
		summary: manifest.summary,
		captain,
		roster,
	};

	const contentHash = computeContentHash(content);
	const { version, changelog } = reconcileVersionAndChangelog(
		prev,
		contentHash,
		manifest.changelog,
	);

	// Explicit, stable key order for the committed file (readability; the hash is
	// order-independent since canonicalize() sorts keys).
	return {
		schema_version: MARKETPLACE_SCHEMA_VERSION,
		slug: content.slug,
		name: content.name,
		description: content.description,
		summary: content.summary,
		version,
		content_hash: contentHash,
		changelog,
		captain: content.captain,
		roster: content.roster,
	};
}

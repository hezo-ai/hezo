/**
 * Loads marketplace team templates for an instance. Source order:
 *   1. **Local folder** — `HEZO_MARKETPLACE_DIR`, or the repo `marketplace/` when
 *      running from source (dev). Always read fresh (dev regenerates it on boot).
 *   2. **GitHub raw** — the committed `marketplace/` on `hezo-ai/hezo` (prod). This
 *      is what lets a running instance pick up updated default teams without a
 *      binary upgrade. Cached ~1h (GitHub rate-limits anonymous calls).
 *   3. **Embedded bundle** — `teams-bundle.json` baked into the binary. Offline
 *      fallback only.
 *
 * The GitHub layer is an untrusted boundary, so every fetched def is validated
 * (zod) and its `schema_version` is checked before use.
 */

import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import {
	MARKETPLACE_SCHEMA_VERSION,
	type MarketplaceIndexEntry,
	type MarketplaceTeamDef,
	toMarketplaceIndexEntry,
} from '@hezo/shared';
import { z } from 'zod';
import { runtimeConfig } from '../config/runtime';
import { logger } from '../logger';

const log = logger.child('marketplace');

/** The repo whose committed `marketplace/` a production instance fetches. */
const REPO = 'hezo-ai/hezo';
const TTL_MS = 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 8000;

const rosterAgentSchema = z.object({
	slug: z.string().min(1),
	title: z.string().min(1),
	// Omitting it is the normal case - a role is addressed by its role - so an
	// absent key means "no name" rather than an invalid team.
	human_name: z.string().nullish().default(null),
	gender: z.enum(['f', 'm', 'n']),
	avatar_spec: z.object({
		seed: z.string(),
		gender: z.enum(['f', 'm', 'n']),
		style: z.string(),
	}),
	reports_to_slug: z.string().nullable(),
	sort_order: z.number(),
	role_description: z.string(),
	summary: z.string(),
	team_context: z.string(),
	system_prompt: z.string().min(1),
	default_effort: z.string(),
	heartbeat_interval_min: z.number(),
	run_timeout_min: z.number(),
	monthly_budget_cents: z.number(),
	daily_budget_cents: z.number(),
	weekly_budget_cents: z.number(),
	touches_code: z.boolean(),
});

const teamDefSchema = z.object({
	schema_version: z.number(),
	slug: z.string().min(1),
	name: z.string().min(1),
	description: z.string(),
	summary: z.string(),
	keywords: z.array(z.string()),
	version: z.number(),
	content_hash: z.string(),
	changelog: z.array(z.object({ version: z.number(), notes: z.string() })),
	captain: z.object({ system_prompt: z.string().min(1), team_context: z.string() }),
	roster: z.array(rosterAgentSchema),
});

/**
 * Validate an untrusted value as a marketplace team def. Returns null (and logs)
 * on a schema mismatch or an unknown `schema_version` (newer than we understand),
 * so the caller can fall through to the next source.
 */
export function parseMarketplaceTeam(value: unknown): MarketplaceTeamDef | null {
	const parsed = teamDefSchema.safeParse(value);
	if (!parsed.success) {
		log.warn(`Rejected marketplace team def: ${parsed.error.issues[0]?.message ?? 'invalid'}`);
		return null;
	}
	if (parsed.data.schema_version > MARKETPLACE_SCHEMA_VERSION) {
		log.warn(
			`Skipping marketplace team "${parsed.data.slug}": schema_version ${parsed.data.schema_version} > supported ${MARKETPLACE_SCHEMA_VERSION}`,
		);
		return null;
	}
	return parsed.data as MarketplaceTeamDef;
}

// ─── Local folder (dev / explicit override) ────────────────────────────────

function resolveLocalMarketplaceDir(): string | null {
	if (process.env.HEZO_MARKETPLACE_DIR) return process.env.HEZO_MARKETPLACE_DIR;
	// Repo-root marketplace/ when running from source. In a compiled binary
	// import.meta.url resolves under /$bunfs and this path doesn't exist on disk,
	// so this returns null and the loader falls through to GitHub / the bundle.
	let base = new URL('.', import.meta.url).pathname;
	// vitest/vite rewrites import.meta.url into a `/@fs/...` virtual URL.
	if (base.startsWith('/@fs/')) base = base.slice('/@fs'.length);
	const dir = join(base, '..', '..', '..', '..', 'marketplace');
	return existsSync(dir) ? dir : null;
}

async function loadLocalTeams(dir: string): Promise<MarketplaceTeamDef[]> {
	const teamsDir = join(dir, 'teams');
	if (!existsSync(teamsDir)) return [];
	const files = (await readdir(teamsDir)).filter((f) => f.endsWith('.json')).sort();
	const defs: MarketplaceTeamDef[] = [];
	for (const file of files) {
		try {
			const def = parseMarketplaceTeam(JSON.parse(await readFile(join(teamsDir, file), 'utf8')));
			if (def) defs.push(def);
		} catch (e) {
			log.warn(`Failed to read local marketplace team ${file}: ${(e as Error).message}`);
		}
	}
	return defs;
}

// ─── Embedded bundle (offline fallback) ────────────────────────────────────

async function loadBundledTeams(): Promise<MarketplaceTeamDef[]> {
	// Literal import so `bun build --compile` embeds it. Empty stub → treated as absent.
	let mod: { default: { teams?: Record<string, unknown> } };
	try {
		mod = (await import('../db/teams-bundle.json')) as {
			default: { teams?: Record<string, unknown> };
		};
	} catch {
		return [];
	}
	const teams = mod.default?.teams;
	if (!teams || Object.keys(teams).length === 0) return [];
	const defs: MarketplaceTeamDef[] = [];
	for (const raw of Object.values(teams)) {
		const def = parseMarketplaceTeam(raw);
		if (def) defs.push(def);
	}
	return defs;
}

// ─── GitHub raw (production live catalog) ───────────────────────────────────

async function fetchJson(url: string): Promise<unknown | null> {
	try {
		const res = await fetch(url, {
			headers: { 'User-Agent': 'hezo', Accept: 'application/json' },
			signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
		});
		if (!res.ok) return null;
		return await res.json();
	} catch {
		return null;
	}
}

/** Fetch `marketplace/<path>` from GitHub raw, trying `main` then `master`. */
async function fetchFromGitHub(path: string): Promise<unknown | null> {
	const { ref: configuredRef, baseUrl } = runtimeConfig().marketplace;
	const refs = configuredRef === 'main' ? ['main', 'master'] : [configuredRef];
	for (const ref of refs) {
		const body = await fetchJson(`${baseUrl}/${REPO}/${ref}/marketplace/${path}`);
		if (body !== null) return body;
	}
	return null;
}

let ghCache: { at: number; defs: MarketplaceTeamDef[] } | null = null;

async function loadGitHubTeams(force: boolean): Promise<MarketplaceTeamDef[] | null> {
	if (!force && ghCache && Date.now() - ghCache.at < TTL_MS) return ghCache.defs;

	const indexRaw = await fetchFromGitHub('index.json');
	if (indexRaw === null) return ghCache?.defs ?? null;
	const index = z.object({ teams: z.array(z.object({ slug: z.string() })) }).safeParse(indexRaw);
	if (!index.success) return ghCache?.defs ?? null;

	const defs: MarketplaceTeamDef[] = [];
	for (const { slug } of index.data.teams) {
		const raw = await fetchFromGitHub(`teams/${slug}.json`);
		const def = raw !== null ? parseMarketplaceTeam(raw) : null;
		if (def) defs.push(def);
	}
	ghCache = { at: Date.now(), defs };
	return defs;
}

// ─── Public API ─────────────────────────────────────────────────────────────

/**
 * Resolve the full team set from the best available source (local → GitHub →
 * embedded bundle). Returns an empty array only when no source is reachable.
 */
export async function loadMarketplaceTeams(force = false): Promise<MarketplaceTeamDef[]> {
	const localDir = resolveLocalMarketplaceDir();
	if (localDir) return loadLocalTeams(localDir);

	const gh = await loadGitHubTeams(force);
	if (gh && gh.length > 0) return gh;

	const bundled = await loadBundledTeams();
	if (bundled.length > 0) return bundled;

	return gh ?? [];
}

/** The catalog (list-page metadata) for every available marketplace team. */
export async function getMarketplaceCatalog(force = false): Promise<MarketplaceIndexEntry[]> {
	const defs = await loadMarketplaceTeams(force);
	return defs.map(toMarketplaceIndexEntry).sort((a, b) => a.slug.localeCompare(b.slug));
}

/** A single team's full definition, or null if it isn't in the catalog. */
export async function getMarketplaceTeam(
	slug: string,
	force = false,
): Promise<MarketplaceTeamDef | null> {
	const defs = await loadMarketplaceTeams(force);
	return defs.find((d) => d.slug === slug) ?? null;
}

/** Test hook: drop the cached GitHub fetch so a later call re-fetches. */
export function resetMarketplaceCache(): void {
	ghCache = null;
}

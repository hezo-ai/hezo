#!/usr/bin/env bun
/**
 * Regenerates the committed marketplace team templates from their authoring
 * sources: the per-team manifest `agents/<team>/team.json` + the partial-resolved
 * markdown prompt bodies under `agents/<team>/*.md`. Writes one self-contained
 * `marketplace/teams/<slug>.json` per team plus the `marketplace/index.json`
 * catalog. Auto-increments each team's `version` when its content changed vs the
 * committed file (content-hash diff); the manifest's `changelog` supplies the notes.
 *
 * These outputs are COMMITTED to git (unlike the gitignored `*-bundle.json`
 * embeds) — they are what a production instance fetches from GitHub raw. Run this
 * after editing any `agents/<team>/` prompt or `team.json`; `bun run dev` runs it
 * automatically before starting the server.
 */
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { MarketplaceIndex, MarketplaceTeamDef } from '@hezo/shared';
import { toMarketplaceIndexEntry } from '@hezo/shared';
import { loadFilesystemAgentRoles } from '../src/db/agent-roles';
import { resolvePartials } from '../src/db/resolve-partials';
import { buildTeamDef, type TeamManifest } from '../src/services/marketplace-build';

const agentsDir = join(import.meta.dir, '..', '..', '..', 'agents');
const marketplaceDir = join(import.meta.dir, '..', '..', '..', 'marketplace');
const teamsOutDir = join(marketplaceDir, 'teams');

function readCommittedDef(slug: string): MarketplaceTeamDef | null {
	const path = join(teamsOutDir, `${slug}.json`);
	if (!existsSync(path)) return null;
	return JSON.parse(readFileSync(path, 'utf8')) as MarketplaceTeamDef;
}

function serialize(value: unknown): string {
	return `${JSON.stringify(value, null, '\t')}\n`;
}

const resolved = resolvePartials(await loadFilesystemAgentRoles(agentsDir));

// Team source dirs are exactly those under agents/ that carry a team.json manifest
// (excludes _instance/, _partials/, blank/ — Blank stays binary-seeded).
const entries = await readdir(agentsDir, { withFileTypes: true });
const teamDirs = entries
	.filter((e) => e.isDirectory() && !e.name.startsWith('_'))
	.map((e) => e.name);

await mkdir(teamsOutDir, { recursive: true });

const built: MarketplaceTeamDef[] = [];
for (const dir of teamDirs.sort()) {
	const manifestPath = join(agentsDir, dir, 'team.json');
	if (!existsSync(manifestPath)) continue;
	const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as TeamManifest;

	const promptFor = (roleSlug: string): string | undefined => resolved[`${dir}/${roleSlug}.md`];
	const prev = readCommittedDef(manifest.slug);
	const def = buildTeamDef(manifest, promptFor, prev);

	await writeFile(join(teamsOutDir, `${manifest.slug}.json`), serialize(def));
	built.push(def);

	const bumped = !prev || prev.version !== def.version;
	const currentNote = def.changelog.find((c) => c.version === def.version)?.notes ?? '';
	if (bumped) {
		console.log(`  ${manifest.slug}: v${prev?.version ?? 0} → v${def.version}`);
		if (!currentNote.trim()) {
			console.warn(
				`  ⚠ ${manifest.slug}: no changelog note for v${def.version} — add { "version": ${def.version}, "notes": "…" } to agents/${dir}/team.json`,
			);
		}
	} else {
		console.log(`  ${manifest.slug}: v${def.version} (unchanged)`);
	}
}

const index: MarketplaceIndex = {
	schema_version: 1,
	teams: built.map(toMarketplaceIndexEntry).sort((a, b) => a.slug.localeCompare(b.slug)),
};
await writeFile(join(marketplaceDir, 'index.json'), serialize(index));

console.log(`Built ${built.length} marketplace team(s) → ${teamsOutDir}`);

#!/usr/bin/env bun
/**
 * Bundles the committed marketplace team templates (`marketplace/teams/*.json` +
 * `marketplace/index.json`) into `packages/server/src/db/teams-bundle.json` so a
 * compiled binary embeds an offline snapshot. This is the OFFLINE FALLBACK only —
 * at runtime the marketplace loader prefers the live catalog (local folder in dev,
 * GitHub raw in prod) and falls back to this bundle when the network is
 * unavailable. Gitignored (regenerated), unlike `marketplace/*.json` which are
 * committed. Mirrors `bundle-skills.ts`.
 */
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { MarketplaceIndex, MarketplaceTeamDef } from '@hezo/shared';

const marketplaceDir = join(import.meta.dir, '..', '..', '..', 'marketplace');
const teamsDir = join(marketplaceDir, 'teams');
const outputPath = join(import.meta.dir, '..', 'src', 'db', 'teams-bundle.json');

const teams: Record<string, MarketplaceTeamDef> = {};
if (existsSync(teamsDir)) {
	const files = (await readdir(teamsDir)).filter((f) => f.endsWith('.json')).sort();
	for (const file of files) {
		const def = JSON.parse(readFileSync(join(teamsDir, file), 'utf8')) as MarketplaceTeamDef;
		teams[def.slug] = def;
	}
}

const indexPath = join(marketplaceDir, 'index.json');
const index: MarketplaceIndex | null = existsSync(indexPath)
	? (JSON.parse(readFileSync(indexPath, 'utf8')) as MarketplaceIndex)
	: null;

await mkdir(dirname(outputPath), { recursive: true });
await writeFile(outputPath, JSON.stringify({ index, teams }));
console.log(`Bundled ${Object.keys(teams).length} marketplace team(s) → ${outputPath}`);

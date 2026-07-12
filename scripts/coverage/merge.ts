#!/usr/bin/env bun
// Cross-shard coverage merge. CI shards the vitest tiers for speed and each shard
// writes an istanbul `coverage-final.json`; this merges them per package into one
// deterministic lcov (branches keyed by source location, not by an unstable
// per-run ordinal), reconciles the Bun tier's line model against the merged
// vitest model, concatenates every package into one repo-root-relative lcov, and
// prints the combined line+branch total the way Coveralls scores this repo.
//
// Used two ways:
//   - CI merge job: `merge.ts --artifacts <dir> --out coverage/lcov.info`, where
//     <dir> holds the downloaded per-shard artifacts (see resolveArtifacts).
//   - Local `bun run test --coverage`: scripts/test.ts calls buildCombinedLcov()
//     directly with each tier's freshly-written coverage-final.json, so a dev
//     sees the same number Coveralls will report.
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { Command } from 'commander';
import {
	combinedCoverageStats,
	type CoverageStats,
	mergeCoverageJsonToLcov,
	normalizeLcov,
	reconcileBunLcovLineModel,
} from './lcov';

export interface MergeInputs {
	/** istanbul coverage-final.json paths, one per server vitest shard. */
	serverJson: string[];
	/** istanbul coverage-final.json paths, one per web vitest shard. */
	webJson: string[];
	/** istanbul coverage-final.json paths for the (unsharded) shared tier. */
	sharedJson: string[];
	/** Bun-native tier lcov path (no branch data); reconciled against merged server. */
	bunLcov?: string;
}

export interface MergeResult {
	combined: string;
	server: string;
	web: string;
	shared: string;
	bun: string;
	stats: CoverageStats;
}

/** Merge every tier into one repo-root-relative lcov + compute the combined total. */
export function buildCombinedLcov(inputs: MergeInputs): MergeResult {
	const server = inputs.serverJson.length
		? normalizeLcov(mergeCoverageJsonToLcov(inputs.serverJson), 'packages/server')
		: '';
	const web = inputs.webJson.length
		? normalizeLcov(mergeCoverageJsonToLcov(inputs.webJson), 'packages/web')
		: '';
	const shared = inputs.sharedJson.length
		? normalizeLcov(mergeCoverageJsonToLcov(inputs.sharedJson), 'packages/shared')
		: '';
	let bun = '';
	if (inputs.bunLcov && existsSync(inputs.bunLcov)) {
		const normalized = normalizeLcov(readFileSync(inputs.bunLcov, 'utf8'), 'packages/server');
		bun = server ? reconcileBunLcovLineModel(normalized, server) : normalized;
	}
	const parts = [server, bun, web, shared].filter(Boolean);
	return {
		combined: parts.join(''),
		server,
		web,
		shared,
		bun,
		stats: combinedCoverageStats(parts),
	};
}

/**
 * Locate each tier's coverage input inside a directory of downloaded CI
 * artifacts. Artifact names are fixed by ci.yml: `backend-coverage-<shard>` and
 * `web-coverage-<shard>` each hold a `coverage-final.json`; `shared-coverage`
 * holds the shared `coverage-final.json`; `backend-bun-coverage` holds the Bun
 * `lcov.info`.
 */
export function resolveArtifacts(dir: string): MergeInputs {
	const entries = existsSync(dir) ? readdirSync(dir) : [];
	const jsonIn = (name: string) => resolve(dir, name, 'coverage-final.json');
	const serverJson = entries
		.filter((e) => /^backend-coverage-\d+$/.test(e))
		.map(jsonIn)
		.filter(existsSync);
	const webJson = entries
		.filter((e) => /^web-coverage-\d+$/.test(e))
		.map(jsonIn)
		.filter(existsSync);
	const sharedJson = [jsonIn('shared-coverage')].filter(existsSync);
	const bunLcov = resolve(dir, 'backend-bun-coverage', 'lcov.info');
	return { serverJson, webJson, sharedJson, bunLcov: existsSync(bunLcov) ? bunLcov : undefined };
}

export function formatStats(stats: CoverageStats): string {
	const pct = (c: number, r: number) => (r ? ((c / r) * 100).toFixed(2) : '100.00');
	const { lines: l, branches: b } = stats;
	return [
		`lines:    ${l.covered}/${l.relevant} = ${pct(l.covered, l.relevant)}%`,
		`branches: ${b.covered}/${b.relevant} = ${pct(b.covered, b.relevant)}%`,
		`COMBINED: ${l.covered + b.covered}/${l.relevant + b.relevant} = ${stats.combinedPct.toFixed(2)}%`,
	].join('\n');
}

// CLI entry — only when run directly, so the exports above stay importable.
if (import.meta.main) {
	const program = new Command()
		.name('coverage-merge')
		.description('Merge per-shard coverage into one lcov and report the combined total')
		.requiredOption('--artifacts <dir>', 'Directory of downloaded per-shard coverage artifacts')
		.option('--out <file>', 'Write the combined lcov here', 'coverage/lcov.info')
		.parse();
	const opts = program.opts();
	const result = buildCombinedLcov(resolveArtifacts(opts.artifacts as string));
	const out = resolve(process.cwd(), opts.out as string);
	mkdirSync(dirname(out), { recursive: true });
	writeFileSync(out, result.combined);
	console.log(`\nWrote combined lcov → ${opts.out}`);
	console.log(formatStats(result.stats));
}

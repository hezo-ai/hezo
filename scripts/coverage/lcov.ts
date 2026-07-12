// Coverage-report plumbing shared by the test runner (scripts/test.ts) and the
// cross-shard merge (scripts/coverage/merge.ts).
//
// Why this exists: CI shards the vitest tiers across runners for speed. Line
// coverage (DA rows, keyed by absolute line number) merges cleanly across
// shards, but branch coverage does not: coverage-v8 assigns each branch a
// synthetic (block, branch) ordinal that is NOT stable across separate runs, so
// uploading each shard's lcov as its own parallel Coveralls build makes Coveralls
// count the same source branch under different identities — inflating the branch
// denominator (~19.5k real branches were reported as ~36k) and deflating the
// combined line+branch total by ~6 points. The fix is to merge the shards'
// *istanbul JSON* (coverage-final.json, whose branches are keyed by AST source
// location, not by an ordinal) into one coverage map per package, then emit a
// single lcov. Branch identities are then assigned once, deterministically, from
// the merged map, so no cross-shard double-counting occurs.
//
// These are pure string/number transforms (plus a thin istanbul wrapper) so they
// can be unit-tested without a DB/DOM — see packages/server/test/coverage-lcov.test.ts.
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import libCoverage from 'istanbul-lib-coverage';
import { createContext } from 'istanbul-lib-report';
import reports from 'istanbul-reports';

/**
 * Merge many istanbul `coverage-final.json` reports (e.g. one per vitest shard)
 * into a single lcov string. Branches are keyed by source location inside the
 * merged coverage map, so the emitted lcov numbers them once — the whole point
 * of merging in JSON space rather than OR-ing per-shard lcovs.
 */
export function mergeCoverageJsonToLcov(jsonPaths: string[]): string {
	const map = libCoverage.createCoverageMap({});
	for (const p of jsonPaths) {
		if (!existsSync(p)) continue;
		const data = JSON.parse(readFileSync(p, 'utf8')) as libCoverage.CoverageMapData;
		map.merge(libCoverage.createCoverageMap(data));
	}
	const dir = mkdtempSync(join(tmpdir(), 'hezo-lcov-'));
	const context = createContext({ dir, coverageMap: map });
	reports.create('lcovonly', {}).execute(context);
	return readFileSync(resolve(dir, 'lcov.info'), 'utf8');
}

/**
 * Rewrite every `SF:` path to be repo-root-relative (`packages/<pkg>/src/...`)
 * and keep only records under that package's `src/` tree. Absolute paths
 * (istanbul emits `/abs/.../packages/server/src/x.ts`), spawn-cwd-relative paths
 * (`src/x.ts` from `bun test --coverage`), and already-normalized paths all
 * collapse to the same repo-root-relative form so Coveralls maps them across the
 * monorepo without per-package `src/` paths colliding. Records outside
 * `<pkg>/src/` (loaded test helpers, node_modules) are dropped.
 */
export function normalizeLcov(lcovText: string, pkg: string): string {
	const srcPrefix = `${pkg}/src/`;
	const records = lcovText
		.split(/^end_of_record$/m)
		.map((rec) => rec.trim())
		.filter(Boolean)
		.map((rec) =>
			rec
				// Absolute or nested path containing packages/<pkg>/src/... → strip the lead-in.
				.replace(/^SF:.*?(packages\/[^/]+\/(?:src)\/.*)$/m, 'SF:$1')
				// Spawn-cwd-relative `src/...` (no leading slash, not already packages/…) → prefix.
				.replace(/^SF:(?!\/|packages\/)(.+)$/m, (_m, rest) => `SF:${pkg}/${rest}`),
		)
		.filter((rec) => {
			const sf = rec.match(/^SF:(.+)$/m);
			return sf ? sf[1].startsWith(srcPrefix) : false;
		});
	return records.length ? `${records.join('\nend_of_record\n')}\nend_of_record\n` : '';
}

/**
 * `bun test --coverage` counts every line of a loaded file as executable —
 * comments, blank lines, type-only lines — and emits `DA:<n>,0` for all of them
 * in files its few specs merely load. Coveralls merges by line number, so those
 * phantom rows count as "missed" for every file both tiers load and depress the
 * merged total. Reconcile: for each file the vitest lcov also reports, keep only
 * the Bun `DA` rows whose line numbers exist in the vitest line model (recomputing
 * LF/LH); files only the Bun tier loads pass through unchanged. Bun emits no
 * branch data, so BRDA/BRF/BRH rows are untouched.
 */
export function reconcileBunLcovLineModel(bunLcovText: string, vitestLcovText: string): string {
	const vitestLines = new Map<string, Set<number>>();
	let sf = '';
	for (const line of vitestLcovText.split('\n')) {
		if (line.startsWith('SF:')) {
			sf = line.slice(3).trim();
			if (!vitestLines.has(sf)) vitestLines.set(sf, new Set());
		} else if (line.startsWith('DA:')) {
			vitestLines.get(sf)?.add(Number.parseInt(line.slice(3), 10));
		}
	}
	const records = bunLcovText
		.split(/^end_of_record$/m)
		.map((rec) => rec.trim())
		.filter(Boolean)
		.map((rec) => {
			const sfMatch = rec.match(/^SF:(.+)$/m);
			const model = sfMatch ? vitestLines.get(sfMatch[1].trim()) : undefined;
			if (!model) return rec;
			let lf = 0;
			let lh = 0;
			const kept = rec.split('\n').filter((line) => {
				if (!line.startsWith('DA:')) return true;
				const [ln, hits] = line.slice(3).split(',');
				if (!model.has(Number.parseInt(ln, 10))) return false;
				lf++;
				if (Number.parseInt(hits, 10) > 0) lh++;
				return true;
			});
			return kept
				.map((line) => {
					if (line.startsWith('LF:')) return `LF:${lf}`;
					if (line.startsWith('LH:')) return `LH:${lh}`;
					return line;
				})
				.join('\n');
		});
	return records.length ? `${records.join('\nend_of_record\n')}\nend_of_record\n` : '';
}

export interface CoverageStats {
	lines: { covered: number; relevant: number };
	branches: { covered: number; relevant: number };
	/** Combined line+branch percentage — the metric Coveralls reports for this repo. */
	combinedPct: number;
}

/**
 * Compute the combined line+branch coverage of one or more lcov strings the way
 * Coveralls scores this repo: covered = LH + BH, relevant = LF + BF across every
 * file. Multiple lcovs (e.g. per package) are OR-merged first — lines by
 * (file,line) max-hits, branches by (file,line,block,branch) max-taken — so the
 * total equals what Coveralls computes after closing the parallel build.
 */
export function combinedCoverageStats(lcovTexts: string[]): CoverageStats {
	const lineHits = new Map<string, Map<number, number>>();
	const branchTaken = new Map<string, Map<string, number>>();
	for (const text of lcovTexts) {
		let sf = '';
		for (const line of text.split('\n')) {
			if (line.startsWith('SF:')) {
				sf = line.slice(3).trim();
				if (!lineHits.has(sf)) lineHits.set(sf, new Map());
				if (!branchTaken.has(sf)) branchTaken.set(sf, new Map());
			} else if (line.startsWith('DA:')) {
				const [ln, hits] = line.slice(3).split(',');
				const n = Number.parseInt(ln, 10);
				const m = lineHits.get(sf);
				if (m) m.set(n, Math.max(m.get(n) ?? 0, Number.parseInt(hits, 10)));
			} else if (line.startsWith('BRDA:')) {
				const [ln, block, branch, taken] = line.slice(5).split(',');
				const key = `${ln}:${block}:${branch}`;
				const t = taken === '-' ? 0 : Number.parseInt(taken, 10);
				const m = branchTaken.get(sf);
				if (m) m.set(key, Math.max(m.get(key) ?? 0, t));
			}
		}
	}
	let lf = 0;
	let lh = 0;
	let bf = 0;
	let bh = 0;
	for (const lines of lineHits.values())
		for (const hits of lines.values()) {
			lf++;
			if (hits > 0) lh++;
		}
	for (const brs of branchTaken.values())
		for (const t of brs.values()) {
			bf++;
			if (t > 0) bh++;
		}
	const covered = lh + bh;
	const relevant = lf + bf;
	return {
		lines: { covered: lh, relevant: lf },
		branches: { covered: bh, relevant: bf },
		combinedPct: relevant ? (covered / relevant) * 100 : 100,
	};
}

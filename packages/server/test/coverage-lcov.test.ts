import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
// Build-tooling under scripts/ — imported directly (pure functions, no DB/DOM).
import {
	combinedCoverageStats,
	mergeCoverageJsonToLcov,
	normalizeLcov,
	reconcileBunLcovLineModel,
} from '../../../scripts/coverage/lcov';
import { buildCombinedLcov, resolveArtifacts } from '../../../scripts/coverage/merge';

const tmpDirs: string[] = [];
function tmp(): string {
	const d = mkdtempSync(join(tmpdir(), 'cov-test-'));
	tmpDirs.push(d);
	return d;
}
afterAll(() => {
	// Best-effort cleanup; ignore if already gone.
	for (const d of tmpDirs) {
		try {
			rmSync(d, { recursive: true, force: true });
		} catch {
			/* noop */
		}
	}
});

/**
 * Minimal istanbul FileCoverage for one source file with one `if` branch and two
 * executable statements. `b` is the branch hit vector [thenHits, elseHits].
 */
function fileCoverage(path: string, b: [number, number], s: [number, number]) {
	return {
		[path]: {
			path,
			statementMap: {
				'0': { start: { line: 1, column: 0 }, end: { line: 1, column: 20 } },
				'1': { start: { line: 2, column: 0 }, end: { line: 2, column: 20 } },
			},
			fnMap: {},
			branchMap: {
				'0': {
					type: 'if',
					line: 1,
					loc: { start: { line: 1, column: 0 }, end: { line: 3, column: 1 } },
					locations: [
						{ start: { line: 1, column: 0 }, end: { line: 3, column: 1 } },
						{ start: { line: 1, column: 0 }, end: { line: 3, column: 1 } },
					],
				},
			},
			s: { '0': s[0], '1': s[1] },
			f: {},
			b: { '0': b },
		},
	};
}

function writeJson(obj: unknown): string {
	const dir = tmp();
	const p = join(dir, 'coverage-final.json');
	writeFileSync(p, JSON.stringify(obj));
	return p;
}

describe('normalizeLcov', () => {
	it('rewrites an absolute istanbul path to a repo-root-relative src path', () => {
		const lcov =
			'SF:/home/runner/work/hezo/hezo/packages/server/src/cli.ts\nDA:1,1\nend_of_record\n';
		expect(normalizeLcov(lcov, 'packages/server')).toContain('SF:packages/server/src/cli.ts');
	});

	it('prefixes a spawn-cwd-relative src path (the shape bun test emits)', () => {
		const lcov = 'SF:src/services/egress/proxy.ts\nDA:1,1\nend_of_record\n';
		expect(normalizeLcov(lcov, 'packages/server')).toContain(
			'SF:packages/server/src/services/egress/proxy.ts',
		);
	});

	it('drops records outside the package src tree (loaded test helpers, node_modules)', () => {
		const lcov =
			'SF:/x/packages/server/test/helpers/app.ts\nDA:1,1\nend_of_record\n' +
			'SF:/x/packages/server/src/keep.ts\nDA:1,1\nend_of_record\n';
		const out = normalizeLcov(lcov, 'packages/server');
		expect(out).toContain('SF:packages/server/src/keep.ts');
		expect(out).not.toContain('helpers/app.ts');
	});
});

describe('reconcileBunLcovLineModel', () => {
	it('drops bun DA rows for lines absent from the vitest model and recomputes LF/LH', () => {
		// Bun counts lines 1,2,3 as executable (2 & 3 are a comment/blank it counts
		// as missed). vitest's model for the file has only lines 1 and 2.
		const bun = 'SF:packages/server/src/x.ts\nDA:1,5\nDA:2,0\nDA:3,0\nLF:3\nLH:1\nend_of_record\n';
		const vitest = 'SF:packages/server/src/x.ts\nDA:1,1\nDA:2,1\nend_of_record\n';
		const out = reconcileBunLcovLineModel(bun, vitest);
		expect(out).toContain('DA:1,5');
		expect(out).toContain('DA:2,0');
		expect(out).not.toContain('DA:3,0'); // phantom line stripped
		expect(out).toContain('LF:2');
		expect(out).toContain('LH:1');
	});

	it('passes through a file the vitest model does not report', () => {
		const bun = 'SF:packages/server/src/bun-only.ts\nDA:1,1\nDA:2,0\nLF:2\nLH:1\nend_of_record\n';
		const out = reconcileBunLcovLineModel(
			bun,
			'SF:packages/server/src/other.ts\nDA:1,1\nend_of_record\n',
		);
		expect(out).toContain('DA:2,0');
		expect(out).toContain('LF:2');
	});
});

describe('combinedCoverageStats', () => {
	it('scores lines + branches combined (the metric Coveralls reports)', () => {
		const lcov =
			'SF:packages/server/src/x.ts\n' +
			'DA:1,1\nDA:2,0\nLF:2\nLH:1\n' +
			'BRDA:1,0,0,1\nBRDA:1,0,1,0\nBRF:2\nBRH:1\n' +
			'end_of_record\n';
		const s = combinedCoverageStats([lcov]);
		expect(s.lines).toEqual({ covered: 1, relevant: 2 });
		expect(s.branches).toEqual({ covered: 1, relevant: 2 });
		// (1 line + 1 branch) / (2 lines + 2 branches) = 50%
		expect(s.combinedPct).toBeCloseTo(50, 5);
	});

	it('OR-merges across lcovs: a line/branch covered in any tier counts covered', () => {
		const a = 'SF:packages/server/src/x.ts\nDA:1,0\nBRDA:1,0,0,-\nend_of_record\n';
		const b = 'SF:packages/server/src/x.ts\nDA:1,3\nBRDA:1,0,0,2\nend_of_record\n';
		const s = combinedCoverageStats([a, b]);
		expect(s.lines).toEqual({ covered: 1, relevant: 1 });
		expect(s.branches).toEqual({ covered: 1, relevant: 1 });
	});
});

describe('mergeCoverageJsonToLcov (deterministic cross-shard branch model)', () => {
	it('merges two shards of the same file by source location — branch count stays stable, hits sum', () => {
		const path = '/repo/packages/server/src/x.ts';
		// Shard A took the "then" branch; shard B took the "else" branch. Merged,
		// both sides of the single branch are covered — and it is still ONE branch
		// with two locations, never double-counted (the whole point of the fix).
		const shardA = writeJson(fileCoverage(path, [1, 0], [1, 0]));
		const shardB = writeJson(fileCoverage(path, [0, 1], [0, 1]));
		const lcov = normalizeLcov(mergeCoverageJsonToLcov([shardA, shardB]), 'packages/server');
		const s = combinedCoverageStats([lcov]);
		// Exactly the one file's two branch locations — not four.
		expect(s.branches.relevant).toBe(2);
		expect(s.branches.covered).toBe(2); // then from A, else from B
		expect((lcov.match(/^SF:/gm) ?? []).length).toBe(1);
	});

	it('is deterministic: merging the same inputs twice yields identical lcov', () => {
		const path = '/repo/packages/server/src/y.ts';
		const j = writeJson(fileCoverage(path, [3, 0], [3, 3]));
		const first = normalizeLcov(mergeCoverageJsonToLcov([j]), 'packages/server');
		const second = normalizeLcov(mergeCoverageJsonToLcov([j]), 'packages/server');
		expect(first).toBe(second);
	});
});

describe('resolveArtifacts + buildCombinedLcov (the CI merge job)', () => {
	// Lay out a fake download-artifact tree: one subdir per artifact, each holding
	// the file ci.yml uploads under that name.
	function artifactTree(): string {
		const dir = tmp();
		const write = (sub: string, file: string, body: string) => {
			mkdirSync(join(dir, sub), { recursive: true });
			writeFileSync(join(dir, sub, file), body);
		};
		// Two server shards of the same file — different sides of one branch.
		write(
			'backend-coverage-1',
			'coverage-final.json',
			JSON.stringify(fileCoverage('/r/packages/server/src/a.ts', [1, 0], [1, 0])),
		);
		write(
			'backend-coverage-2',
			'coverage-final.json',
			JSON.stringify(fileCoverage('/r/packages/server/src/a.ts', [0, 1], [0, 1])),
		);
		write(
			'web-coverage-1',
			'coverage-final.json',
			JSON.stringify(fileCoverage('/r/packages/web/src/w.ts', [1, 1], [1, 1])),
		);
		write(
			'shared-coverage',
			'coverage-final.json',
			JSON.stringify(fileCoverage('/r/packages/shared/src/s.ts', [1, 0], [1, 0])),
		);
		// Bun lcov: covers server/a.ts line 1, plus a phantom line 99 to be reconciled away.
		write(
			'backend-bun-coverage',
			'lcov.info',
			'SF:src/a.ts\nDA:1,4\nDA:99,0\nLF:2\nLH:1\nend_of_record\n',
		);
		return dir;
	}

	it('discovers every tier from the artifact dir and merges them into one lcov', () => {
		const dir = artifactTree();
		const inputs = resolveArtifacts(dir);
		expect(inputs.serverJson).toHaveLength(2);
		expect(inputs.webJson).toHaveLength(1);
		expect(inputs.sharedJson).toHaveLength(1);
		expect(inputs.bunLcov).toBeDefined();

		const { combined, stats } = buildCombinedLcov(inputs);
		// Three source files, each repo-root-relative to its package.
		expect(combined).toContain('SF:packages/server/src/a.ts');
		expect(combined).toContain('SF:packages/web/src/w.ts');
		expect(combined).toContain('SF:packages/shared/src/s.ts');
		// The two server shards' branch merges to one 2-location branch, both
		// covered. web (both sides) + shared (one side) → 2 + 2 + 1 covered of 6.
		expect(stats.branches.relevant).toBe(6); // 2 per file × 3 files
		expect(stats.branches.covered).toBe(5);
	});

	it("reconciles the Bun tier's phantom lines against the merged server model", () => {
		const dir = artifactTree();
		const { bun } = buildCombinedLcov(resolveArtifacts(dir));
		// server/a.ts is in the vitest model (lines 1-2), so bun's phantom line 99 is dropped.
		expect(bun).toContain('SF:packages/server/src/a.ts');
		expect(bun).toContain('DA:1,4');
		expect(bun).not.toContain('DA:99,0');
	});

	it('tolerates a missing artifact dir (a run where every shard failed to report)', () => {
		const inputs = resolveArtifacts(join(tmpdir(), 'does-not-exist-hezo-cov'));
		expect(inputs.serverJson).toHaveLength(0);
		const { combined, stats } = buildCombinedLcov(inputs);
		expect(combined).toBe('');
		expect(stats.combinedPct).toBe(100);
	});
});

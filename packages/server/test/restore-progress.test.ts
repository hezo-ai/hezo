import { createHash } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { restoreAssetBlobs } from '../src/assets/blob-backup';
import { LocalAssetStore } from '../src/assets/drivers/local';
import { createMemoryDb } from '../src/db/client';
import type { Db } from '../src/db/database';
import { dumpLogicalBackupToFile, restoreLogicalBackupFromFile } from '../src/db/logical-backup';
import { runMigrations } from '../src/db/migrate';
import { openDatabase } from '../src/db/open';
import { BASE_SCHEMA } from '../src/db/schema';
import {
	createProgressReporter,
	createStreamProgressReporter,
	formatBytes,
	formatCount,
	formatDuration,
	formatProgressLine,
	type ProgressState,
	progressRatio,
	truncateLine,
} from '../src/lib/progress';
import { safeClose } from './helpers';
import { createTestApp } from './helpers/app';
import { allMigrations } from './helpers/migrate';

// `hezo restore` on a real instance spends minutes inside two loops (row
// inserts, asset-blob copies) that used to print nothing at all, so an operator
// could not tell a slow restore from a hung one. These cover both halves: the
// renderer that turns progress states into terminal output, and the restore
// engines that emit those states.

/** The ANSI erase-to-end-of-line the in-place renderer appends. */
const CLEAR_TO_EOL = '\u001b[K';

const tempDirs: string[] = [];
function makeTempDir(): string {
	const dir = mkdtempSync(join(tmpdir(), 'hezo-restore-progress-'));
	tempDirs.push(dir);
	return dir;
}

afterAll(() => {
	for (const dir of tempDirs) rmSync(dir, { recursive: true, force: true });
});

/** A stream stand-in that records every chunk the reporter writes. */
function fakeStream(opts: { isTTY?: boolean; columns?: number } = {}) {
	const chunks: string[] = [];
	return {
		write: (chunk: string) => {
			chunks.push(chunk);
			return true;
		},
		isTTY: opts.isTTY,
		columns: opts.columns,
		text: () => chunks.join(''),
		/** Rendered lines, with the in-place control codes stripped. */
		lines: () =>
			chunks
				.join('')
				.split(CLEAR_TO_EOL)
				.join('')
				.split(/[\r\n]/)
				.filter((l) => l.length > 0),
	};
}

/** A clock the reporter reads, so throttling and ETAs are deterministic. */
function fakeClock(start = 0) {
	let t = start;
	return {
		now: () => t,
		advance: (ms: number) => {
			t += ms;
		},
	};
}

describe('progress formatting', () => {
	it('formats counts, bytes and durations for an operator', () => {
		expect(formatCount(0)).toBe('0');
		expect(formatCount(1_204_000)).toBe('1,204,000');

		expect(formatBytes(0)).toBe('0 B');
		expect(formatBytes(-5)).toBe('0 B');
		expect(formatBytes(900)).toBe('900 B');
		expect(formatBytes(1536)).toBe('1.5 KB');
		expect(formatBytes(20 * 1024 * 1024)).toBe('20 MB');
		expect(formatBytes(3.5 * 1024 ** 3)).toBe('3.5 GB');

		expect(formatDuration(0)).toBe('0s');
		expect(formatDuration(12_400)).toBe('12s');
		expect(formatDuration(72_000)).toBe('1m 12s');
		expect(formatDuration(3_930_000)).toBe('1h 05m');
	});

	it('derives completion from counters or an explicit ratio, clamped to 0..1', () => {
		expect(progressRatio({ phase: 'p', label: 'l' })).toBeUndefined();
		// No total to divide by → unknown, not 0%.
		expect(progressRatio({ phase: 'p', label: 'l', done: 5 })).toBeUndefined();
		expect(progressRatio({ phase: 'p', label: 'l', done: 5, total: 20 })).toBe(0.25);
		expect(progressRatio({ phase: 'p', label: 'l', done: 30, total: 20 })).toBe(1);
		expect(progressRatio({ phase: 'p', label: 'l', ratio: 0.5, done: 1, total: 20 })).toBe(0.5);
		expect(progressRatio({ phase: 'p', label: 'l', total: 0, done: 0 })).toBeUndefined();
	});

	it('renders percent, counts, detail, elapsed and an ETA', () => {
		const state: ProgressState = {
			phase: 'load',
			label: 'Loading rows',
			done: 250_000,
			total: 1_000_000,
			unit: 'rows',
			detail: 'task_comments',
		};
		expect(formatProgressLine(state, 60_000)).toBe(
			'Loading rows · 25% · 250,000/1,000,000 rows · task_comments · 1m 00s · ~3m 00s left',
		);

		// Under a second in: no elapsed, and no ETA extrapolated from noise.
		expect(formatProgressLine(state, 200)).toBe(
			'Loading rows · 25% · 250,000/1,000,000 rows · task_comments',
		);
		// Complete → nothing left to estimate.
		expect(formatProgressLine({ ...state, done: 1_000_000 }, 60_000)).toBe(
			'Loading rows · 100% · 1,000,000/1,000,000 rows · task_comments · 1m 00s',
		);
		// Byte counters ride alongside the unit counts.
		expect(
			formatProgressLine(
				{
					phase: 'assets',
					label: 'Restoring asset files',
					done: 3,
					total: 10,
					unit: 'files',
					bytes: 2048,
				},
				0,
			),
		).toBe('Restoring asset files · 30% · 3/10 files · 2.0 KB');
		// An announcement is just its label plus context.
		expect(
			formatProgressLine({ phase: 'read', label: 'Reading the backup', detail: '1.5 KB' }, 0),
		).toBe('Reading the backup · 1.5 KB');
	});

	it('truncates a line that would wrap past the terminal width', () => {
		expect(truncateLine('short', 40)).toBe('short');
		expect(truncateLine('0123456789', 5)).toBe('0123…');
		expect(truncateLine('0123456789', 0)).toBe('0123456789');
	});
});

describe('progress reporter', () => {
	it('rewrites one line in place on a TTY and closes it when the phase ends', () => {
		const stream = fakeStream({ isTTY: true, columns: 200 });
		const clock = fakeClock();
		const reporter = createProgressReporter({
			write: stream.write,
			isTty: true,
			columns: 200,
			throttleMs: 100,
			now: clock.now,
		});

		reporter.report({ phase: 'load', label: 'Loading rows', done: 0, total: 10, unit: 'rows' });
		clock.advance(150);
		reporter.report({ phase: 'load', label: 'Loading rows', done: 5, total: 10, unit: 'rows' });
		clock.advance(150);
		reporter.report({ phase: 'load', label: 'Loading rows', done: 10, total: 10, unit: 'rows' });
		reporter.finish();

		// Every update rewrote the same row: carriage returns, one closing newline.
		const text = stream.text();
		expect(text.split('\r').length - 1).toBe(3);
		expect(text.split('\n').length - 1).toBe(1);
		expect(text).toContain(CLEAR_TO_EOL);
		expect(stream.lines()).toEqual([
			'Loading rows · 0% · 0/10 rows',
			'Loading rows · 50% · 5/10 rows',
			'Loading rows · 100% · 10/10 rows',
		]);
	});

	it('throttles mid-phase updates but always flushes the phase’s final state', () => {
		const stream = fakeStream({ isTTY: true, columns: 200 });
		const clock = fakeClock();
		const reporter = createProgressReporter({
			write: stream.write,
			isTty: true,
			columns: 200,
			throttleMs: 1_000,
			now: clock.now,
		});

		reporter.report({ phase: 'parse', label: 'Reading rows', done: 0, unit: 'rows', ratio: 0 });
		// Three updates inside the throttle window collapse to nothing rendered…
		for (const done of [10, 20, 30]) {
			clock.advance(10);
			reporter.report({
				phase: 'parse',
				label: 'Reading rows',
				done,
				unit: 'rows',
				ratio: done / 100,
			});
		}
		expect(stream.lines()).toEqual(['Reading rows · 0% · 0 rows']);

		// …but the last one is flushed when the phase ends, so the counter never
		// stalls at a stale value.
		reporter.finish();
		expect(stream.lines()).toEqual(['Reading rows · 0% · 0 rows', 'Reading rows · 30% · 30 rows']);
	});

	it('appends throttled whole lines when the output is a pipe, not a TTY', () => {
		const stream = fakeStream();
		const clock = fakeClock();
		const reporter = createProgressReporter({
			write: stream.write,
			isTty: false,
			throttleMs: 5_000,
			now: clock.now,
		});

		reporter.report({ phase: 'load', label: 'Loading rows', done: 0, total: 100, unit: 'rows' });
		clock.advance(1_000);
		reporter.report({ phase: 'load', label: 'Loading rows', done: 20, total: 100, unit: 'rows' });
		clock.advance(6_000);
		reporter.report({ phase: 'load', label: 'Loading rows', done: 60, total: 100, unit: 'rows' });
		reporter.report({ phase: 'load', label: 'Loading rows', done: 100, total: 100, unit: 'rows' });
		reporter.finish();

		// No carriage returns into a log file; the 1s-later update was throttled
		// away, the 6s-later one and the completion were kept.
		expect(stream.text()).not.toContain('\r');
		expect(stream.text()).not.toContain(CLEAR_TO_EOL);
		expect(stream.lines()).toEqual([
			'Loading rows · 0% · 0/100 rows',
			'Loading rows · 60% · 60/100 rows · 7s · ~5s left',
			'Loading rows · 100% · 100/100 rows · 7s',
		]);
	});

	it('closes an announcement line so the step’s own logging starts clean', () => {
		const stream = fakeStream({ isTTY: true, columns: 200 });
		const reporter = createProgressReporter({ write: stream.write, isTty: true, columns: 200 });

		reporter.report({ phase: 'schema', label: 'Recreating the schema', detail: '41 migrations' });
		expect(stream.text()).toBe(`\rRecreating the schema · 41 migrations${CLEAR_TO_EOL}\n`);

		// note() and finish() stay safe on an already-closed line.
		reporter.note('Restored database: 12 rows.');
		reporter.finish();
		expect(stream.lines()).toEqual([
			'Recreating the schema · 41 migrations',
			'Restored database: 12 rows.',
		]);
	});

	it('keeps a note on its own row while a counter line is open', () => {
		const stream = fakeStream({ isTTY: true, columns: 200 });
		const reporter = createProgressReporter({ write: stream.write, isTty: true, columns: 200 });
		reporter.report({ phase: 'load', label: 'Loading rows', done: 1, total: 2, unit: 'rows' });
		reporter.note('done');
		expect(stream.text()).toBe(`\rLoading rows · 50% · 1/2 rows${CLEAR_TO_EOL}\ndone\n`);
	});

	it('is silent under NODE_ENV=test and renders against a real stream otherwise', () => {
		const quiet = fakeStream({ isTTY: true, columns: 200 });
		const silent = createStreamProgressReporter(quiet, { NODE_ENV: 'test' });
		silent.report({ phase: 'load', label: 'Loading rows', done: 1, total: 2 });
		silent.note('nothing');
		silent.finish();
		expect(quiet.text()).toBe('');

		const live = fakeStream({ isTTY: true, columns: 200 });
		const reporter = createStreamProgressReporter(live, { NODE_ENV: 'production' });
		reporter.report({ phase: 'load', label: 'Loading rows', done: 1, total: 2, unit: 'rows' });
		reporter.finish();
		expect(live.lines()).toEqual(['Loading rows · 50% · 1/2 rows']);
	});
});

describe('database restore progress emission', () => {
	const migrations = allMigrations();
	let ctx: Awaited<ReturnType<typeof createTestApp>>;
	let dir: string;
	let backupFile: string;

	beforeAll(async () => {
		ctx = await createTestApp();
		dir = mkdtempSync(join(tmpdir(), 'hezo-restore-progress-'));
		backupFile = join(dir, 'source.backup.gz');
		await dumpLogicalBackupToFile(ctx.db, backupFile, { hezoVersion: 'test', migrations });
	}, 120_000);

	afterAll(async () => {
		rmSync(dir, { recursive: true, force: true });
		await safeClose(ctx.db);
	});

	it('reports every phase, with a row counter that climbs to the restored total', async () => {
		const restored = await createMemoryDb();
		const states: ProgressState[] = [];
		try {
			const summary = await restoreLogicalBackupFromFile(restored, backupFile, migrations, {
				onProgress: (s) => states.push({ ...s }),
			});

			// The phases an operator watching a long restore should see, in order.
			// There is deliberately no separate parse phase: rows are parsed and
			// inserted in one pass, so the restore never holds the whole database
			// in memory. Reading everything first (which is what made a row *total*
			// knowable up front) is the bug, not the feature.
			expect([...new Set(states.map((s) => s.phase))]).toEqual([
				'schema',
				'prepare',
				'load',
				'constraints',
			]);

			// The load counter is monotonic and lands exactly on the restored rows.
			const load = states.filter((s) => s.phase === 'load');
			expect(load.length).toBeGreaterThan(1);
			const done = load.map((s) => s.done ?? -1);
			expect(done).toEqual([...done].sort((a, b) => a - b));
			expect(done[0]).toBe(0);
			expect(done[done.length - 1]).toBe(summary.rows);
			// The table being loaded is named, so a stall is attributable.
			expect(load.some((s) => (s.detail ?? '').length > 0)).toBe(true);
			// Compressed bytes consumed climb alongside the rows, which is the only
			// completion signal available without reading the file twice.
			expect(load.some((s) => (s.bytes ?? 0) > 0)).toBe(true);
		} finally {
			await safeClose(restored as { close: () => Promise<void> });
		}
	}, 120_000);

	it('reports the wipe phase only when restoring over an existing schema', async () => {
		const target = await createMemoryDb();
		try {
			const first: ProgressState[] = [];
			await restoreLogicalBackupFromFile(target, backupFile, migrations, {
				onProgress: (s) => first.push({ ...s }),
			});
			expect(first.some((s) => s.phase === 'wipe')).toBe(false);

			const second: ProgressState[] = [];
			await restoreLogicalBackupFromFile(target, backupFile, migrations, {
				wipe: true,
				onProgress: (s) => second.push({ ...s }),
			});
			expect(second.some((s) => s.phase === 'wipe')).toBe(true);
		} finally {
			await safeClose(target as { close: () => Promise<void> });
		}
	}, 120_000);
});

describe('asset restore progress emission', () => {
	it('counts asset blobs as they are copied out of a bundle', async () => {
		const dataDir = makeTempDir();
		const opened = await openDatabase({ dataDir });
		const db: Db = opened.db;
		try {
			await db.exec(BASE_SCHEMA);
			await runMigrations(db, allMigrations());

			const team = await db.query<{ id: string }>(
				`INSERT INTO teams (name, slug) VALUES ('Progress', 'progress') RETURNING id`,
			);
			const project = await db.query<{ id: string }>(
				`INSERT INTO projects (team_id, name, slug, task_prefix)
				 VALUES ($1, 'Assets', 'assets', 'AS') RETURNING id`,
				[team.rows[0].id],
			);
			const projectId = project.rows[0].id;

			// A bundle carrying several blobs, laid out the way `hezo backup` writes
			// them (`<bundle>/assets/<projectId>/<assetId>`).
			const bundleDir = makeTempDir();
			const source = new LocalAssetStore(bundleDir);
			let expectedBytes = 0;
			for (let i = 0; i < 5; i++) {
				const content = Buffer.from(`asset payload ${i}`.repeat(i + 1));
				expectedBytes += content.byteLength;
				const asset = await db.query<{ id: string }>(
					`INSERT INTO assets (team_id, project_id, content_type, byte_size, sha256, original_filename)
					 VALUES ($1, $2, 'text/plain', $3, $4, $5) RETURNING id`,
					[
						team.rows[0].id,
						projectId,
						content.byteLength,
						createHash('sha256').update(content).digest('hex'),
						`asset-${i}.txt`,
					],
				);
				await source.write(projectId, asset.rows[0].id, new Blob([content]));
			}

			const states: ProgressState[] = [];
			const summary = await restoreAssetBlobs(db, new LocalAssetStore(makeTempDir()), bundleDir, {
				onProgress: (s) => states.push({ ...s }),
			});
			expect(summary.count).toBe(5);

			expect([...new Set(states.map((s) => s.phase))]).toEqual(['assets-scan', 'assets']);
			const copied = states.filter((s) => s.phase === 'assets');
			expect(copied[0]).toMatchObject({ done: 0, total: 5, unit: 'files', bytes: 0 });
			const last = copied[copied.length - 1];
			expect(last).toMatchObject({ done: 5, total: 5, bytes: expectedBytes });
			expect(progressRatio(last)).toBe(1);
		} finally {
			await safeClose(db as { close: () => Promise<void> });
		}
	}, 120_000);
});

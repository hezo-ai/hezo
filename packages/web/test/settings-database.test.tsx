import {
	DEFAULT_LOCALE_SETTINGS,
	DEFAULT_LOG_COMPACTION_RETENTION_DAYS,
	Language,
	RunLogPassKind,
	RunLogPassPhase,
	RunLogRewriteFailureReason,
} from '@hezo/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render } from '@testing-library/react';
import { expect, test } from 'vitest';
import { DatabaseSection } from '../src/components/database-section';
import type { DatabaseInfo } from '../src/hooks/use-database-info';
import type { RunLogUsage } from '../src/hooks/use-run-log-compaction';
// The section's confirm dialog resolves its cancel/close labels through `t()`,
// so the tree needs the i18n context the app shell always provides.
import { I18nProvider } from '../src/lib/i18n';
import { queryKeys } from '../src/lib/query-keys';
import { renderApp } from './helpers/render';

// Full-route render against the real in-process backend: the embedded variant
// is what a test server actually runs, on the dedicated Storage subpage.
test('storage subpage shows the embedded database card', async () => {
	const { findByTestId } = await renderApp({ initialPath: '/settings/storage' });

	// findByTestId auto-waits — anchor on the data-driven rows so the query has
	// resolved before asserting content.
	const backend = await findByTestId('settings-database-backend');
	expect(backend.textContent).toBe('Embedded (PGlite)');
	const display = await findByTestId('settings-database-display');
	expect(display.textContent).toContain('pgdata');
});

/** A zero-usage payload — no run logs, nothing compactable, no pass running. */
function emptyUsage(backend: 'embedded' | 'external'): RunLogUsage {
	return {
		backend,
		database_bytes: backend === 'embedded' ? 4096 : null,
		run_log_bytes: 0,
		run_count: 0,
		free_bytes: 0,
		compactable_run_count: 0,
		older_than_days: DEFAULT_LOG_COMPACTION_RETENTION_DAYS,
		compaction: null,
		last: null,
	};
}

// Isolated-component render with a seeded cache — no real external Postgres or
// on-disk snapshots needed, and it proves the client renders exactly the
// pre-redacted string it was given (no reveal affordance, no raw URL).
function renderCard(
	info: DatabaseInfo,
	opts: {
		superuser?: boolean;
		superseded?: { count: number; bytes: number };
		usage?: RunLogUsage;
	} = {},
) {
	// staleTime: Infinity keeps the seeded cache authoritative — the file-level
	// renderApp beforeEach reroutes fetch into the real in-process backend, and
	// a mount refetch would overwrite the seeded payload with the test server's.
	const qc = new QueryClient({
		defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } },
	});
	qc.setQueryData(queryKeys.me(), { type: 'admin', is_superuser: opts.superuser ?? true });
	qc.setQueryData(queryKeys.databaseInfo(), info);
	if (opts.superseded) qc.setQueryData(queryKeys.supersededData(), opts.superseded);
	// Seed the usage query so the mounted component doesn't fetch it live.
	qc.setQueryData(
		queryKeys.runLogUsage(DEFAULT_LOG_COMPACTION_RETENTION_DAYS),
		opts.usage ?? emptyUsage(info.backend),
	);
	return render(
		<QueryClientProvider client={qc}>
			<I18nProvider>
				<DatabaseSection />
			</I18nProvider>
		</QueryClientProvider>,
	);
}

function renderExternal(info: DatabaseInfo, opts: { superuser?: boolean } = {}) {
	return renderCard(info, opts);
}

test('external variant renders the occluded connection string, never credentials', async () => {
	const { findByTestId } = renderExternal({
		backend: 'external',
		display: 'postgres://••••:••••@db.example.com:5432/hezo?sslmode=require',
		server_version: '16.4',
	});

	const backend = await findByTestId('settings-database-backend');
	expect(backend.textContent).toBe('External Postgres');

	const display = await findByTestId('settings-database-display');
	expect(display.textContent).toContain('••••:••••@db.example.com:5432/hezo');
	expect(display.textContent).toContain('sslmode=require');

	const version = await findByTestId('settings-database-version');
	expect(version.textContent).toContain('PostgreSQL 16.4');
});

test('the card does not render for non-superusers', () => {
	const { queryByTestId } = renderExternal(
		{ backend: 'external', display: 'postgres://••••:••••@h/db' },
		{ superuser: false },
	);
	expect(queryByTestId('settings-database')).toBeNull();
});

// Embedded backend surfaces the pre-migration snapshots (pgdata.superseded.*)
// with a control to reclaim them — sized in GB, gated on there being something
// to prune.
test('embedded card shows the prune control with the snapshot size', async () => {
	const { findByTestId } = renderCard(
		{ backend: 'embedded', display: '/root/.hezo/pgdata' },
		{ superseded: { count: 3, bytes: 1_932_735_283 } }, // ~1.8 GB
	);
	const size = await findByTestId('settings-database-superseded-size');
	expect(size.textContent).toContain('3 snapshots');
	expect(size.textContent).toContain('1.8 GB');
	await findByTestId('settings-database-prune');
});

test('the prune button opens a confirm dialog warning that rollback is lost', async () => {
	const { findByTestId, findByText } = renderCard(
		{ backend: 'embedded', display: '/root/.hezo/pgdata' },
		{ superseded: { count: 2, bytes: 1024 * 1024 } },
	);
	fireEvent.click(await findByTestId('settings-database-prune'));
	// ConfirmDialog renders into a portal on document.body; the bound queries
	// target baseElement (document.body), so they reach the portal content.
	await findByText('Prune old database versions?');
	await findByText(/able to roll back to an earlier version/);
});

test('no prune control when there are no snapshots to reclaim', () => {
	const { queryByTestId } = renderCard(
		{ backend: 'embedded', display: '/root/.hezo/pgdata' },
		{ superseded: { count: 0, bytes: 0 } },
	);
	expect(queryByTestId('settings-database-superseded')).toBeNull();
});

test('no prune control for external Postgres', () => {
	const { queryByTestId } = renderCard({
		backend: 'external',
		display: 'postgres://••••:••••@h/db',
	});
	expect(queryByTestId('settings-database-superseded')).toBeNull();
});

// ── Run-log compaction ──────────────────────────────────────────────────────

function usageWith(overrides: Partial<RunLogUsage>): RunLogUsage {
	return { ...emptyUsage('embedded'), ...overrides };
}

test('embedded card shows the database size + run-log readout', async () => {
	const { findByTestId } = renderCard(
		{ backend: 'embedded', display: '/root/.hezo/pgdata' },
		{
			usage: usageWith({
				database_bytes: 2_500_000_000,
				run_log_bytes: 1_100_000_000,
				run_count: 1333,
			}),
		},
	);
	const dbSize = await findByTestId('settings-db-size');
	expect(dbSize.textContent).toContain('2.3 GB');
	const logSize = await findByTestId('settings-run-log-size');
	expect(logSize.textContent).toContain('1.0 GB');
	expect(logSize.textContent).toContain('1,333');
});

test('the free-space estimate and trim count show for the chosen window', async () => {
	const { findByTestId } = renderCard(
		{ backend: 'embedded', display: '/root/.hezo/pgdata' },
		{ usage: usageWith({ free_bytes: 1_073_741_824, compactable_run_count: 900 }) },
	);
	const free = await findByTestId('settings-run-log-free');
	expect(free.textContent).toBe('About 1.0 GB of this is free space.');
	const line = await findByTestId('settings-compact-eligible');
	expect(line.textContent).toBe('Trims 900 runs older than 30 days.');
});

test('a free-space estimate of zero reads as little free space, not as a size', async () => {
	const { findByTestId } = renderCard(
		{ backend: 'external', display: 'postgres://••••:••••@h/db' },
		{ usage: usageWith({ backend: 'external', database_bytes: null, free_bytes: 0 }) },
	);
	const free = await findByTestId('settings-run-log-free');
	expect(free.textContent).toBe('Little of this is free space.');
});

test('with nothing old enough to trim, only returning space to disk stays available', async () => {
	for (const backend of ['embedded', 'external'] as const) {
		const { findByTestId, unmount } = renderCard(
			{ backend, display: backend === 'embedded' ? '/root/.hezo/pgdata' : 'postgres://h/db' },
			{ usage: usageWith({ backend, free_bytes: 800_000_000, compactable_run_count: 0 }) },
		);
		const compact = (await findByTestId('settings-compact-button')) as HTMLButtonElement;
		expect(compact.disabled).toBe(true);
		const line = await findByTestId('settings-compact-eligible');
		expect(line.textContent).toBe('Nothing older than 30 days to compact.');
		const reclaim = (await findByTestId('settings-reclaim-button')) as HTMLButtonElement;
		expect(reclaim.disabled).toBe(false);
		unmount();
	}
});

test('the return-space button warns that each table is locked while it is rewritten', async () => {
	const { findByTestId, findByText } = renderCard(
		{ backend: 'external', display: 'postgres://••••:••••@h/db' },
		{ usage: usageWith({ backend: 'external', database_bytes: null, free_bytes: 800_000_000 }) },
	);
	fireEvent.click(await findByTestId('settings-reclaim-button'));
	await findByText('Return free space to disk?');
	await findByText(/Each table is locked while it is rewritten: agent runs cannot save their logs/);
	await findByText(/needs free disk space for a new copy of it/);
});

test('the compact button opens a confirm dialog explaining what is kept', async () => {
	const { findByTestId, findByText } = renderCard(
		{ backend: 'embedded', display: '/root/.hezo/pgdata' },
		{ usage: usageWith({ free_bytes: 500_000_000, compactable_run_count: 120 }) },
	);
	fireEvent.click(await findByTestId('settings-compact-button'));
	await findByText('Compact run logs older than 30 days?');
	// Phrases unique to the dialog (the help paragraph is worded differently), so
	// findByText resolves to a single element.
	await findByText(/full command that launched each run is kept/);
	await findByText(/clearly marked as compacted, and status/);
	await findByText(/permanently discarded and can.t be recovered/);
	// The embedded backend ends a compaction with the rewrite, and says so.
	await findByText(/Each table is locked while it is rewritten\.$/);
});

test('while a pass is running the button is disabled and progress shows', async () => {
	const { findByTestId } = renderCard(
		{ backend: 'embedded', display: '/root/.hezo/pgdata' },
		{
			usage: usageWith({
				compaction: {
					kind: RunLogPassKind.Compact,
					phase: RunLogPassPhase.Trimming,
					started_at: new Date().toISOString(),
					older_than_days: 30,
					total: 2740,
					processed: 1200,
					trimmed_bytes: 640_000_000,
				},
			}),
		},
	);
	const button = (await findByTestId('settings-compact-button')) as HTMLButtonElement;
	expect(button.disabled).toBe(true);
	const reclaim = (await findByTestId('settings-reclaim-button')) as HTMLButtonElement;
	expect(reclaim.disabled).toBe(true);
	const progress = await findByTestId('settings-compact-progress');
	expect(progress.textContent).toContain('1,200 / 2,740 runs · 610.4 MB of log text trimmed');
});

test('an embedded compaction shows its closing rewrite, not a finished progress bar', async () => {
	const { findByTestId, queryByTestId } = renderCard(
		{ backend: 'embedded', display: '/root/.hezo/pgdata' },
		{
			usage: usageWith({
				compaction: {
					kind: RunLogPassKind.Compact,
					phase: RunLogPassPhase.Rewriting,
					started_at: new Date().toISOString(),
					older_than_days: 30,
					total: 10,
					processed: 10,
					trimmed_bytes: 5_000_000,
				},
			}),
		},
	);
	const notice = await findByTestId('settings-compact-rewriting');
	expect(notice.textContent).toBe('Returning space to disk…');
	expect(queryByTestId('settings-compact-progress')).toBeNull();
});

test('while space is returned to disk, both buttons wait and no estimate shows', async () => {
	const { findByTestId, queryByTestId } = renderCard(
		{ backend: 'external', display: 'postgres://••••:••••@h/db' },
		{
			usage: usageWith({
				backend: 'external',
				database_bytes: null,
				compaction: {
					kind: RunLogPassKind.Reclaim,
					phase: RunLogPassPhase.Rewriting,
					started_at: new Date().toISOString(),
				},
			}),
		},
	);
	const reclaim = (await findByTestId('settings-reclaim-button')) as HTMLButtonElement;
	expect(reclaim.disabled).toBe(true);
	expect(reclaim.textContent).toBe('Returning space to disk…');
	const compact = (await findByTestId('settings-compact-button')) as HTMLButtonElement;
	expect(compact.disabled).toBe(true);
	expect(queryByTestId('settings-run-log-free')).toBeNull();
	expect(queryByTestId('settings-run-log-last')).toBeNull();
});

// ── The last pass: trimmed text and disk space are separate figures ─────────

test('an external compaction reports the text it trimmed, never disk reclaimed', async () => {
	// The case that read as a bug: "1.9 GB reclaimed" beside an unchanged 1.9 GB.
	const { findByTestId } = renderCard(
		{ backend: 'external', display: 'postgres://••••:••••@h/db' },
		{
			usage: usageWith({
				backend: 'external',
				database_bytes: null,
				run_log_bytes: 2_040_109_465,
				last: {
					kind: RunLogPassKind.Compact,
					finished_at: new Date().toISOString(),
					older_than_days: 30,
					processed: 1206,
					trimmed_bytes: 2_040_109_465,
					disk_bytes_freed: null,
					rewrite_failure: null,
				},
			}),
		},
	);
	const last = await findByTestId('settings-run-log-last');
	expect(last.textContent).toBe('Last compaction: 1,206 runs · 1.9 GB of log text trimmed.');
});

test('an embedded compaction reports both the trimmed text and the disk returned', async () => {
	const { findByTestId } = renderCard(
		{ backend: 'embedded', display: '/root/.hezo/pgdata' },
		{
			usage: usageWith({
				last: {
					kind: RunLogPassKind.Compact,
					finished_at: new Date().toISOString(),
					older_than_days: 30,
					processed: 1,
					trimmed_bytes: 2_040_109_465,
					disk_bytes_freed: 838_860_800,
					rewrite_failure: null,
				},
			}),
		},
	);
	const last = await findByTestId('settings-run-log-last');
	expect(last.textContent).toBe(
		'Last compaction: 1 run · 1.9 GB of log text trimmed · 800.0 MB returned to disk.',
	);
});

test('a rewrite that stopped names the table and the reason', async () => {
	const { findByTestId } = renderCard(
		{ backend: 'external', display: 'postgres://••••:••••@h/db' },
		{
			usage: usageWith({
				backend: 'external',
				database_bytes: null,
				last: {
					kind: RunLogPassKind.Reclaim,
					finished_at: new Date().toISOString(),
					disk_bytes_freed: 0,
					rewrite_failure: {
						reason: RunLogRewriteFailureReason.Busy,
						table: 'heartbeat_run_log_chunks',
						message: null,
					},
				},
			}),
		},
	);
	const last = await findByTestId('settings-run-log-last');
	// Nothing was freed, so there is no "0 B returned" line, only the reason.
	expect(last.textContent).toBe(
		'Hezo could not return space to disk: the heartbeat_run_log_chunks table was in use each time it tried. Try again when fewer agents are running.',
	);
});

test('the card renders in the instance language', async () => {
	localStorage.setItem(
		'locale',
		JSON.stringify({ ...DEFAULT_LOCALE_SETTINGS, language: Language.De }),
	);
	try {
		const { findByTestId } = renderCard(
			{ backend: 'external', display: 'postgres://••••:••••@h/db' },
			{
				usage: usageWith({
					backend: 'external',
					database_bytes: null,
					free_bytes: 1_073_741_824,
					compactable_run_count: 0,
				}),
			},
		);
		expect((await findByTestId('settings-database-backend')).textContent).toBe('Externes Postgres');
		expect((await findByTestId('settings-run-log-free')).textContent).toBe(
			'Davon sind etwa 1.0 GB freier Speicher.',
		);
		expect((await findByTestId('settings-reclaim-button')).textContent).toBe(
			'Speicher zurückgeben',
		);
	} finally {
		localStorage.removeItem('locale');
	}
});

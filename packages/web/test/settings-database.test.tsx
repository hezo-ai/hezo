import { DEFAULT_LOG_COMPACTION_RETENTION_DAYS } from '@hezo/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render } from '@testing-library/react';
import { expect, test } from 'vitest';
import { DatabaseSection } from '../src/components/database-section';
import type { DatabaseInfo } from '../src/hooks/use-database-info';
import type { RunLogUsage } from '../src/hooks/use-run-log-compaction';
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
		reclaimable_bytes: 0,
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
			<DatabaseSection />
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

test('reclaimable estimate + trim count show for the chosen window', async () => {
	const { findByTestId } = renderCard(
		{ backend: 'embedded', display: '/root/.hezo/pgdata' },
		{ usage: usageWith({ reclaimable_bytes: 1_073_741_824, compactable_run_count: 900 }) },
	);
	const line = await findByTestId('settings-compact-reclaimable');
	expect(line.textContent).toContain('1.0 GB');
	expect(line.textContent).toContain('trims 900 runs');
});

test('embedded can still reclaim bloat when nothing is old enough to trim', async () => {
	const { findByTestId } = renderCard(
		{ backend: 'embedded', display: '/root/.hezo/pgdata' },
		{ usage: usageWith({ reclaimable_bytes: 800_000_000, compactable_run_count: 0 }) },
	);
	// The button stays enabled (VACUUM reclaims bloat regardless of run age)...
	const button = (await findByTestId('settings-compact-button')) as HTMLButtonElement;
	expect(button.disabled).toBe(false);
	// ...and the copy says so.
	const line = await findByTestId('settings-compact-reclaimable');
	expect(line.textContent).toContain('reclaims storage bloat');
});

test('external Postgres with nothing to trim disables the button', async () => {
	const { findByTestId } = renderCard(
		{ backend: 'external', display: 'postgres://••••:••••@h/db' },
		{ usage: usageWith({ backend: 'external', database_bytes: null, compactable_run_count: 0 }) },
	);
	const button = (await findByTestId('settings-compact-button')) as HTMLButtonElement;
	expect(button.disabled).toBe(true);
});

test('the compact button opens a confirm dialog explaining what is kept', async () => {
	const { findByTestId, findByText } = renderCard(
		{ backend: 'embedded', display: '/root/.hezo/pgdata' },
		{ usage: usageWith({ reclaimable_bytes: 500_000_000, compactable_run_count: 120 }) },
	);
	fireEvent.click(await findByTestId('settings-compact-button'));
	await findByText('Compact run logs older than 30 days?');
	// Phrases unique to the dialog (the help paragraph is worded differently), so
	// findByText resolves to a single element.
	await findByText(/full command that launched each run is kept/);
	await findByText(/clearly marked as compacted, and status/);
	await findByText(/permanently discarded and can.t be recovered/);
});

test('while a pass is running the button is disabled and progress shows', async () => {
	const { findByTestId } = renderCard(
		{ backend: 'embedded', display: '/root/.hezo/pgdata' },
		{
			usage: usageWith({
				compaction: {
					started_at: new Date().toISOString(),
					older_than_days: 30,
					total: 2740,
					processed: 1200,
					bytes_reclaimed: 640_000_000,
				},
			}),
		},
	);
	const button = (await findByTestId('settings-compact-button')) as HTMLButtonElement;
	expect(button.disabled).toBe(true);
	const progress = await findByTestId('settings-compact-progress');
	expect(progress.textContent).toContain('1,200 / 2,740 runs');
});

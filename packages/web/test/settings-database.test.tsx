import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render } from '@testing-library/react';
import { expect, test } from 'vitest';
import { DatabaseSection } from '../src/components/database-section';
import type { DatabaseInfo } from '../src/hooks/use-database-info';
import { queryKeys } from '../src/lib/query-keys';
import { renderApp } from './helpers/render';

// Full-route render against the real in-process backend: the embedded variant
// is what a test server actually runs, and placement (before the Version
// section) is part of the requirement.
test('general settings shows the embedded database card just before the Version section', async () => {
	const { findByTestId } = await renderApp({ initialPath: '/settings' });

	// findByTestId auto-waits — anchor on the data-driven rows so the query has
	// resolved before asserting content.
	const backend = await findByTestId('settings-database-backend');
	expect(backend.textContent).toBe('Embedded (PGlite)');
	const display = await findByTestId('settings-database-display');
	expect(display.textContent).toContain('pgdata');

	const section = await findByTestId('settings-database');
	const version = await findByTestId('settings-version');
	// The Database section renders BEFORE the Version section.
	expect(section.compareDocumentPosition(version) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
});

// Isolated-component render with a seeded cache — no real external Postgres or
// on-disk snapshots needed, and it proves the client renders exactly the
// pre-redacted string it was given (no reveal affordance, no raw URL).
function renderCard(
	info: DatabaseInfo,
	opts: { superuser?: boolean; superseded?: { count: number; bytes: number } } = {},
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

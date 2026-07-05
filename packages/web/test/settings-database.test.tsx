import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render } from '@testing-library/react';
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

// Isolated-component render with a seeded cache for the external variant — no
// real external Postgres needed, and it proves the client renders exactly the
// pre-redacted string it was given (no reveal affordance, no raw URL).
function renderExternal(info: DatabaseInfo, opts: { superuser?: boolean } = {}) {
	// staleTime: Infinity keeps the seeded cache authoritative — the file-level
	// renderApp beforeEach reroutes fetch into the real in-process backend, and
	// a mount refetch would overwrite the seeded external payload with the test
	// server's embedded one.
	const qc = new QueryClient({
		defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } },
	});
	qc.setQueryData(queryKeys.me(), { type: 'admin', is_superuser: opts.superuser ?? true });
	qc.setQueryData(queryKeys.databaseInfo(), info);
	return render(
		<QueryClientProvider client={qc}>
			<DatabaseSection />
		</QueryClientProvider>,
	);
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

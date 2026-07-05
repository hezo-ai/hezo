import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render } from '@testing-library/react';
import { expect, test } from 'vitest';
import { AssetStorageSection } from '../src/components/asset-storage-section';
import type { AssetStorageInfo } from '../src/hooks/use-asset-storage-info';
import { queryKeys } from '../src/lib/query-keys';
import { renderApp } from './helpers/render';

// Full-route render against the real in-process backend: the local variant is
// what a test server actually runs, and placement (after the Database card,
// before the Version section) is part of the requirement.
test('general settings shows the local asset-storage card between Database and Version', async () => {
	const { findByTestId } = await renderApp({ initialPath: '/settings' });

	const backend = await findByTestId('settings-asset-storage-backend');
	expect(backend.textContent).toBe('Local filesystem');
	const display = await findByTestId('settings-asset-storage-display');
	expect(display.textContent).toContain('assets');

	const database = await findByTestId('settings-database');
	const section = await findByTestId('settings-asset-storage');
	const version = await findByTestId('settings-version');
	expect(database.compareDocumentPosition(section) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
	expect(section.compareDocumentPosition(version) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
});

// Isolated-component render with a seeded cache for the s3 variant — no real
// bucket needed, and it proves the client renders exactly the pre-redacted
// string it was given (no reveal affordance, no raw URL).
function renderS3(info: AssetStorageInfo, opts: { superuser?: boolean } = {}) {
	// staleTime: Infinity keeps the seeded cache authoritative — the file-level
	// renderApp beforeEach reroutes fetch into the real in-process backend, and
	// a mount refetch would overwrite the seeded s3 payload with the test
	// server's local one.
	const qc = new QueryClient({
		defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } },
	});
	qc.setQueryData(queryKeys.me(), { type: 'admin', is_superuser: opts.superuser ?? true });
	qc.setQueryData(queryKeys.assetStorageInfo(), info);
	return render(
		<QueryClientProvider client={qc}>
			<AssetStorageSection />
		</QueryClientProvider>,
	);
}

test('s3 variant renders the occluded storage URL, never credentials', async () => {
	const { findByTestId } = renderS3({
		backend: 's3',
		display: 's3://••••:••••@minio.internal:9000/hezo/assets?region=us-east-1&pathStyle=true',
	});

	const backend = await findByTestId('settings-asset-storage-backend');
	expect(backend.textContent).toBe('S3-compatible object storage');

	const display = await findByTestId('settings-asset-storage-display');
	expect(display.textContent).toContain('••••:••••@minio.internal:9000/hezo/assets');
	expect(display.textContent).toContain('pathStyle=true');
});

test('the card does not render for non-superusers', () => {
	const { queryByTestId } = renderS3(
		{ backend: 's3', display: 's3://••••:••••@h/bucket' },
		{ superuser: false },
	);
	expect(queryByTestId('settings-asset-storage')).toBeNull();
});

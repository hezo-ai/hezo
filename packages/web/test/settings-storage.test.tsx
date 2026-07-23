import { expect, test } from 'vitest';
import { renderApp } from './helpers/render';

// Full-route render against the real in-process backend: the embedded/local
// variants are what a test server actually runs. Asserts the two cards share a
// single "Storage" split view on the dedicated Storage subpage.
test('storage subpage shows database + asset storage as one split view', async () => {
	const { findByTestId, findByRole } = await renderApp({ initialPath: '/settings/storage' });

	// findByTestId auto-waits — anchor on the data-driven rows so both queries
	// have resolved before asserting layout.
	const dbBackend = await findByTestId('settings-database-backend');
	expect(dbBackend.textContent).toBe('Embedded (PGlite)');
	const assetBackend = await findByTestId('settings-asset-storage-backend');
	expect(assetBackend.textContent).toBe('Local filesystem');

	// One shared "Storage" heading fronts both cards.
	await findByRole('heading', { name: 'Storage' });

	const section = await findByTestId('settings-storage');
	const database = await findByTestId('settings-database');
	const asset = await findByTestId('settings-asset-storage');

	// Both cards live inside the single Storage section, database before asset.
	expect(section.contains(database)).toBe(true);
	expect(section.contains(asset)).toBe(true);
	expect(database.compareDocumentPosition(asset) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();

	// Each card renders an icon standing in for its storage type.
	expect(database.querySelector('svg')).not.toBeNull();
	expect(asset.querySelector('svg')).not.toBeNull();
});

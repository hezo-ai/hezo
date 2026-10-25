import { waitFor } from '@testing-library/react';
import { afterEach, expect, test } from 'vitest';
import { getTestContext, renderApp } from './helpers/render';

// A managed credential is written by its hosting plane on every boot, so the
// settings list offers only the choice of default, and names neither the model
// nor the CLI behind it.

const MODEL = 'vendor/one-model';

async function insertManaged(): Promise<void> {
	const { db } = getTestContext();
	await db.query(
		`INSERT INTO ai_provider_configs
		   (provider, label, encrypted_credential, default_model, status, metadata)
		 VALUES ('hezo_cloud', 'Base AI model', 'enc', $1, 'verified',
		         '{"base_url":"https://models.example/api"}'::jsonb)`,
		[MODEL],
	);
}

afterEach(async () => {
	await getTestContext().db.query(`DELETE FROM ai_provider_configs WHERE provider = 'hezo_cloud'`);
});

test('the managed credential shows no edit, verify or remove, and names no model or CLI', async () => {
	await insertManaged();
	const { findAllByText, queryByRole, getByRole, container } = await renderApp({
		initialPath: '/settings/ai-providers',
	});

	expect((await findAllByText('Base AI model')).length).toBeGreaterThan(0);
	await waitFor(() =>
		expect(getByRole('button', { name: 'Set Base AI model as default' })).toBeTruthy(),
	);
	expect(queryByRole('button', { name: 'Edit Base AI model' })).toBeNull();
	expect(queryByRole('button', { name: 'Verify Base AI model' })).toBeNull();
	expect(queryByRole('button', { name: 'Remove Base AI model' })).toBeNull();

	const row = [...container.querySelectorAll('tr')].find((tr) =>
		tr.textContent?.includes('Base AI model'),
	);
	expect(row).toBeDefined();
	expect(row?.textContent).not.toContain('Claude Code');
	expect(row?.textContent).not.toContain(MODEL);
	expect(row?.textContent).not.toContain('API Key');
});

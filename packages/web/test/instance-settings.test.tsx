import { waitFor } from '@testing-library/react';
import { expect, test } from 'vitest';
import { getTestContext, renderApp } from './helpers/render';

async function fetchBaseUrl(): Promise<string | null> {
	const { apiBase, token } = getTestContext();
	const res = await apiBase('/api/instance-settings', {
		headers: { Authorization: `Bearer ${token}` },
	});
	const body = (await res.json()) as { data: { base_url: string | null } };
	return body.data.base_url;
}

test('instance base URL saves from /settings and echoes the normalized origin', async () => {
	const { findByTestId, findByRole, user } = await renderApp({ initialPath: '/settings' });

	await findByRole('heading', { name: 'General' });
	const input = (await findByTestId('instance-base-url-input')) as HTMLInputElement;
	expect(input.value).toBe('');

	await user.type(input, 'https://Hezo.Example.com:8443/');
	await user.click(await findByTestId('instance-base-url-save'));

	// Response-driven: the input reflects the server-normalized origin.
	await waitFor(() => expect(input.value).toBe('https://hezo.example.com:8443'));
	expect(await fetchBaseUrl()).toBe('https://hezo.example.com:8443');
});

test('an invalid base URL shows an inline error and saves nothing', async () => {
	const { findByTestId, user } = await renderApp({ initialPath: '/settings' });

	const input = (await findByTestId('instance-base-url-input')) as HTMLInputElement;
	await user.type(input, 'https://x.example.com/some/path');
	await user.click(await findByTestId('instance-base-url-save'));

	const error = await findByTestId('instance-base-url-error');
	expect(error.textContent).toMatch(/http\(s\) origin/);
	// The typed value stays in place for correction; nothing was persisted.
	expect(input.value).toBe('https://x.example.com/some/path');
	expect(await fetchBaseUrl()).toBeNull();
});

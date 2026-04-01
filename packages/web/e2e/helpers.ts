import type { Page } from '@playwright/test';

const TEST_MASTER_KEY = 'e2e-test-master-key-0123456789abcdef0123456789abcdef';

export async function authenticate(page: Page) {
	const res = await page.request.post('/api/auth/token', {
		data: { master_key: TEST_MASTER_KEY },
	});
	const json = await res.json();
	const token = json.data?.token ?? json.token;

	await page.addInitScript((t: string) => {
		localStorage.setItem('hezo_token', t);
	}, token);

	await page.reload();
}

export { TEST_MASTER_KEY };

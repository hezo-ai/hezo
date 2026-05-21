import { expect, test } from './fixtures';
import { authenticate, getToken, setActiveTeamSlug, waitForPageLoad } from './helpers';

test.describe('Home onboarding', () => {
	test.use({ viewport: { width: 390, height: 844 } });

	test('shows requirements intake and progress on a new team', async ({ page }) => {
		await authenticate(page);
		const token = await getToken(page);
		const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

		const typesRes = await page.request.get('/api/team-templates', { headers });
		const types = (await typesRes.json()) as { data: Array<{ id: string; name: string }> };
		const blank = types.data.find((t) => t.name === 'Blank');
		expect(blank).toBeDefined();

		const uid = `${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
		const teamRes = await page.request.post('/api/teams', {
			headers,
			data: { name: `Onboard E2E ${uid}`, template_id: blank?.id },
		});
		expect(teamRes.ok()).toBe(true);
		const team = ((await teamRes.json()) as { data: { slug: string } }).data;

		await page.goto('/home');
		await waitForPageLoad(page);
		await setActiveTeamSlug(page, team.slug);
		await page.reload();
		await waitForPageLoad(page);

		await expect(page.getByTestId('home-welcome-card')).toBeVisible();
		await expect(page.getByTestId('onboarding-progress')).toBeVisible();
		await expect(page.getByTestId('onboarding-stage-requirements')).toBeVisible();

		const intakeRes = await page.request.get(
			`/api/teams/${team.slug}/requirements-intake?ensure=true`,
			{ headers },
		);
		expect(intakeRes.ok()).toBe(true);

		await page.reload();
		await waitForPageLoad(page);

		await expect(page.getByTestId('home-captain-intake')).toBeVisible({ timeout: 20_000 });
	});
});

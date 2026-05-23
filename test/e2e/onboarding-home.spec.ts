import { expect, test } from './fixtures';
import { authenticate, getToken, setActiveTeamSlug, waitForPageLoad } from './helpers';

test.describe('Home onboarding', () => {
	test.use({ viewport: { width: 390, height: 844 } });

	test('shows the welcome card with the intake stage pending until the user opts in', async ({
		page,
	}) => {
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
		await expect(page.getByTestId('onboarding-stage-intake')).toBeVisible();
	});

	test('renders the Captain chat panel once the onboarding-intake ticket exists', async ({
		page,
	}) => {
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
			data: { name: `Onboard Chat E2E ${uid}`, template_id: blank?.id },
		});
		const team = ((await teamRes.json()) as { data: { slug: string } }).data;

		const intakeRes = await page.request.get(
			`/api/teams/${team.slug}/onboarding-intake?ensure=true`,
			{ headers },
		);
		expect(intakeRes.ok()).toBe(true);

		await page.goto('/home');
		await waitForPageLoad(page);
		await setActiveTeamSlug(page, team.slug);
		await page.reload();
		await waitForPageLoad(page);

		await expect(page.getByTestId('home-captain-intake')).toBeVisible({ timeout: 20_000 });
		await expect(page.getByTestId('home-captain-intake-skip')).toBeVisible();
	});

	test('Skip-questions button posts a system comment and hides itself for the session', async ({
		page,
	}) => {
		await authenticate(page);
		const token = await getToken(page);
		const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };

		const typesRes = await page.request.get('/api/team-templates', { headers });
		const types = (await typesRes.json()) as { data: Array<{ id: string; name: string }> };
		const blank = types.data.find((t) => t.name === 'Blank');

		const uid = `${Date.now()}${Math.random().toString(36).slice(2, 6)}`;
		const teamRes = await page.request.post('/api/teams', {
			headers,
			data: { name: `Onboard Skip E2E ${uid}`, template_id: blank?.id },
		});
		const team = ((await teamRes.json()) as { data: { slug: string } }).data;

		const intakeRes = await page.request.get(
			`/api/teams/${team.slug}/onboarding-intake?ensure=true`,
			{ headers },
		);
		const intake = ((await intakeRes.json()) as { data: { task_identifier: string } }).data;

		await page.goto('/home');
		await waitForPageLoad(page);
		await setActiveTeamSlug(page, team.slug);
		await page.reload();
		await waitForPageLoad(page);

		const skipButton = page.getByTestId('home-captain-intake-skip');
		await expect(skipButton).toBeVisible();
		await skipButton.click();

		await expect
			.poll(async () => {
				const commentsRes = await page.request.get(
					`/api/teams/${team.slug}/tasks/${intake.task_identifier.toLowerCase()}/comments`,
					{ headers },
				);
				const body = (await commentsRes.json()) as {
					data: Array<{ content_type: string; content: { text?: string } }>;
				};
				return body.data.some(
					(c) =>
						c.content_type === 'system' && (c.content.text ?? '').toLowerCase().includes('skip'),
				);
			})
			.toBe(true);

		await expect(skipButton).toBeHidden();

		await page.reload();
		await waitForPageLoad(page);
		await expect(page.getByTestId('home-captain-intake')).toBeVisible({ timeout: 20_000 });
		await expect(page.getByTestId('home-captain-intake-skip')).toHaveCount(0);
	});
});

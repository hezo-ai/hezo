import { expect, test } from './fixtures';
import { authenticate, createTeamLight } from './helpers';

test('audit log page renders at the dedicated route', async ({ page }) => {
	await authenticate(page);
	const { team } = await createTeamLight(page);

	await page.goto(`/teams/${team.id}/settings/audit-log`);
	await expect(page.getByRole('heading', { name: 'Audit log' })).toBeVisible({ timeout: 20000 });
});

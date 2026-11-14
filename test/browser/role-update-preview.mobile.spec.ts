// The role update preview is a phone sheet below 640px: the dialog fills the
// screen, the diff wraps rather than scrolling sideways, and the two answers
// stack full width with Apply update on top. happy-dom has no viewport and no
// layout, so only a real browser at a real width can see any of that.

import { expect, test } from './fixtures';
import { waitForPageLoad } from './helpers';

test.describe('role update preview - mobile (390px)', () => {
	test('opens as a full-screen sheet with the answers stacked under the diff', async ({
		sharedPage: page,
		sharedWorkspace,
	}) => {
		const { projectSlug, token, agents } = sharedWorkspace;
		const agent = agents[0];
		const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
		const long =
			'Escalate a task you cannot resolve to the CEO first, and bring only decisions about strategy to the admin.';
		const created = await page.request.post(`/api/projects/${projectSlug}/approvals`, {
			headers,
			data: {
				type: 'role_update',
				requested_by_member_id: agent.id,
				payload: {
					member_id: agent.id,
					agent_title: agent.title,
					outcome: 'clean',
					content: `# ${agent.title}\n\n- ${long}\n`,
				},
			},
		});
		expect(created.status()).toBe(201);
		const cardId = ((await created.json()) as { data: { id: string } }).data.id;

		try {
			await page.goto(`/projects/${projectSlug}/inbox`);
			await waitForPageLoad(page);
			await page.getByTestId('role-update-preview-open').first().click({ timeout: 20_000 });

			const dialog = page.getByTestId('role-update-preview');
			await expect(dialog.getByTestId('role-update-diff')).toBeVisible({ timeout: 20_000 });

			// The sheet covers the screen edge to edge.
			const sheet = await dialog.boundingBox();
			expect(sheet?.x).toBe(0);
			expect(sheet?.width).toBe(390);

			// A long line wraps inside the diff instead of pushing the sheet wider.
			const overflow = await dialog
				.getByTestId('role-update-diff')
				.evaluate((el) => el.scrollWidth - el.clientWidth);
			expect(overflow).toBeLessThanOrEqual(0);
			await expect(dialog.getByText(long)).toBeVisible();

			// Both answers span the sheet, Apply update above Keep current, and each
			// takes the full touch target once a consumer opts into touch density, as
			// the hosted dashboard does. Hezo itself stays at desktop density.
			await page.evaluate(() => {
				document.documentElement.dataset.density = 'touch';
			});
			const apply = dialog.getByTestId('role-update-apply');
			const keep = dialog.getByTestId('role-update-keep');
			await apply.scrollIntoViewIfNeeded();
			const a = await apply.boundingBox();
			const k = await keep.boundingBox();
			expect(a && k).toBeTruthy();
			if (!a || !k) return;
			expect(a.y).toBeLessThan(k.y);
			expect(a.width).toBeGreaterThan(300);
			expect(Math.round(a.width)).toBe(Math.round(k.width));
			expect(a.height).toBeGreaterThanOrEqual(44);
			expect(k.height).toBeGreaterThanOrEqual(44);
		} finally {
			// Closed with no side effect, so the shared workspace keeps an empty inbox.
			await page.request.post(`/api/approvals/${cardId}/resolve`, {
				headers,
				data: { status: 'denied' },
			});
		}
	});
});

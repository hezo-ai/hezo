// Browser-only because the assertions need real layout (rule #1: the standalone
// preview iframe filling the viewport via h-screen) and a real popup tab opened
// by window.open, neither of which the component harness can produce.
import { expect, test } from './fixtures';
import { createProjectAndClearPlanning, uniqueName } from './helpers';

const HTML_BODY =
	'<!DOCTYPE html><html><head><style>h1{color:teal}</style></head><body><h1>Popped-out mockup</h1></body></html>';

test('pop-out button opens the document full-page in a new tab with no app chrome', async ({
	sharedPage: page,
	sharedWorkspace,
}) => {
	const { team, token } = sharedWorkspace;
	const project = await createProjectAndClearPlanning(page, team.id, token, {
		name: uniqueName('Popout'),
	});
	await page.request.put(`/api/teams/${team.id}/projects/${project.slug}/docs/ui-mockups.html`, {
		headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
		data: { content: HTML_BODY },
	});

	await page.goto(`/teams/${team.slug}/projects/${project.slug}/documents?file=ui-mockups.html`);

	// Clicking the pop-out button opens a real second tab.
	const popoutButton = page.getByTestId('doc-popout');
	await expect(popoutButton).toBeVisible();
	const [popup] = await Promise.all([page.context().waitForEvent('page'), popoutButton.click()]);
	await popup.waitForLoadState();

	await expect(popup).toHaveURL(
		new RegExp(`/preview/${team.slug}/${project.slug}/ui-mockups\\.html$`),
	);
	// No team rail / sidebar in the bare preview tab.
	await expect(popup.getByTestId('sidebar-toggle')).toHaveCount(0);

	// The sandboxed iframe fills the viewport (real layout — happy-dom can't show this).
	const iframe = popup.locator('iframe');
	await expect(iframe).toHaveAttribute('sandbox', 'allow-scripts');
	const viewport = popup.viewportSize();
	const box = await iframe.boundingBox();
	expect(box).not.toBeNull();
	if (box && viewport) {
		expect(box.height).toBeGreaterThan(viewport.height * 0.9);
	}
	await popup.close();
});

// Folder-tab "notch": the active tab must merge into the panel below — its
// bottom border painted the panel's own background colour so it covers the tab
// strip's baseline border, rather than reading as a closed box with a grey
// bottom edge. This has to run in a real browser (criterion #1 — real CSS): the
// active tab's bottom-border colour only lands because it uses an important
// utility (`border-b-bg!`) that beats the global unlayered
// `* { border-color: var(--border) }` reset in index.css — a real-cascade
// outcome (important vs. unlayered-normal) happy-dom's getComputedStyle doesn't
// resolve, so a component test would pass while the real UI stayed broken.

import { expect, test } from './fixtures';

test('active folder tab merges into the panel (bottom border = surface, not the grey strip baseline)', async ({
	sharedPage,
	sharedWorkspace,
}) => {
	const { projectSlug, agents } = sharedWorkspace;
	const agent = agents[0];

	// Land on the Executions tab so it is the active (raised) folder tab.
	await sharedPage.goto(`/projects/${projectSlug}/agents/${agent.id}/executions`);

	const activeTab = sharedPage.getByRole('link', { name: 'Executions' });
	await expect(activeTab).toBeVisible({ timeout: 15000 });

	const colors = await sharedPage.evaluate(() => {
		const active = Array.from(document.querySelectorAll('a')).find(
			(a) => a.textContent?.trim() === 'Executions',
		);
		const strip = active?.closest('nav');
		return {
			activeBottom: active ? getComputedStyle(active).borderBottomColor : null,
			stripBottom: strip ? getComputedStyle(strip).borderBottomColor : null,
			panelBg: getComputedStyle(document.body).backgroundColor,
		};
	});

	// The active tab's bottom border matches the panel it opens into…
	expect(colors.activeBottom).toBe(colors.panelBg);
	// …and is distinctly NOT the strip's grey baseline. Before the fix the
	// unlayered reset forced these equal, so the tab read as a closed box.
	expect(colors.activeBottom).not.toBe(colors.stripBottom);
});

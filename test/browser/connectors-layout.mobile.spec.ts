// Decision-tree item 2: the connector row header is viewport-conditional —
// on mobile the title/URL block and the action buttons stack vertically
// (`flex-col` → `sm:flex-row`), so the title gets full width instead of being
// truncated to an unreadable fragment while the buttons crowd it. happy-dom
// can't run the media query or report real layout boxes, so this needs real
// Chromium + setViewportSize + boundingBox.
import { expect, test } from './fixtures';
import { createProjectAndClearPlanning, uniqueName, waitForPageLoad } from './helpers';

test.describe('Connector row responsive layout', () => {
	test('the header stacks (buttons below title) on mobile and sits inline on desktop', async ({
		page,
		sharedWorkspace,
	}) => {
		const { token } = sharedWorkspace;
		const headers = { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' };
		const project = await createProjectAndClearPlanning(page, '', token, {
			name: uniqueName('Connector Layout'),
			description: 'E2E connector row responsiveness.',
		});

		// A pending MCP connector with a long URL renders the Connect + API-key
		// buttons alongside the title — the pair that used to squeeze the title
		// down to "typeful…" on a 375px screen.
		const connectorRes = await page.request.post(`/api/projects/${project.slug}/connectors`, {
			headers,
			data: {
				name: 'typefully',
				kind: 'saas',
				config: { url: 'https://mcp.typefully.com/some/fairly/long/path/mcp' },
			},
		});
		expect(connectorRes.ok()).toBeTruthy();
		const connectorId = ((await connectorRes.json()) as { data: { id: string } }).data.id;

		const row = page.locator(`[data-testid="connector-row"][data-connector-id="${connectorId}"]`);
		const title = row.locator('h2');
		const actions = row.getByTestId('connector-actions');

		// --- Mobile: title above, actions on their own line below. ---
		await page.setViewportSize({ width: 375, height: 800 });
		await page.goto(`/projects/${project.slug}/connectors`);
		await waitForPageLoad(page);
		await expect(row).toBeVisible({ timeout: 15000 });

		const rowBoxM = await row.boundingBox();
		const titleBoxM = await title.boundingBox();
		const actionsBoxM = await actions.boundingBox();
		if (!rowBoxM || !titleBoxM || !actionsBoxM) throw new Error('Missing layout box');

		// Actions sit strictly below the title (stacked), not to its right.
		expect(actionsBoxM.y).toBeGreaterThanOrEqual(titleBoxM.y + titleBoxM.height - 1);
		// And the whole action group stays inside the card — no horizontal overflow.
		expect(actionsBoxM.x).toBeGreaterThanOrEqual(rowBoxM.x - 1);
		expect(actionsBoxM.x + actionsBoxM.width).toBeLessThanOrEqual(rowBoxM.x + rowBoxM.width + 1);

		// --- Desktop: title and actions share a row (actions to the right). ---
		await page.setViewportSize({ width: 1280, height: 900 });
		const titleBoxD = await title.boundingBox();
		const actionsBoxD = await actions.boundingBox();
		if (!titleBoxD || !actionsBoxD) throw new Error('Missing layout box');
		// Same row: vertically overlapping, actions right of the title.
		expect(Math.abs(actionsBoxD.y - titleBoxD.y)).toBeLessThan(
			actionsBoxD.height + titleBoxD.height,
		);
		expect(actionsBoxD.x).toBeGreaterThan(titleBoxD.x);
	});
});

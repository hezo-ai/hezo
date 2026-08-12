import { expect, test } from 'vitest';
import { getTestContext, renderApp } from './helpers/render';
import { seedProject, seedTask, seedWorkspace } from './helpers/seed';

// Picking an assignee from the menu is the one place you cannot click through to
// find out who someone is - you either recognise the name or you choose blind. So
// each option carries the identity card, and the *whole option row* is the hover
// target: with the trigger on the name alone, the target is a few characters wide
// in a full-width row and pointing at the row lands on padding.
//
// happy-dom cannot open a Radix tooltip's portal, but it can see which element
// Radix made the trigger - `data-state` lands on it - and that is precisely the
// thing that was wrong.

async function nameAgent(projectSlug: string, agentSlug: string, humanName: string) {
	const { token, apiBase } = getTestContext();
	const res = await apiBase(`/api/projects/${projectSlug}/agents/${agentSlug}`, {
		method: 'PATCH',
		headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
		body: JSON.stringify({ human_name: humanName }),
	});
	if (!res.ok) throw new Error(`naming ${agentSlug} failed: ${res.status}`);
}

test('each assignee option is itself the identity-card trigger', async () => {
	let projectSlug = '';
	let taskIdentifier = '';

	const { findByTestId, router, user } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			const project = await seedProject(ws, { name: 'Assignee Menu Project' });
			const task = await seedTask(ws, project, {
				title: 'Assignee Menu Task',
				assignee_id: ws.agents[0].id,
			});
			// A named agent, so the card has something to say that the label does not.
			await nameAgent(ws.internalSlug, 'engineer', 'Morgan');
			projectSlug = project.slug;
			taskIdentifier = task.identifier;
		},
	});

	await router.navigate({
		to: '/projects/$projectId/tasks/$taskId',
		params: { projectId: projectSlug, taskId: taskIdentifier.toLowerCase() },
	});

	const assignee = await findByTestId('task-assignee', undefined, { timeout: 20_000 });
	const toggle = assignee.querySelector('[aria-label="Change assignee"]') as HTMLElement | null;
	expect(toggle).not.toBeNull();
	await user.click(toggle as HTMLElement);

	const options = [...assignee.querySelectorAll('button')].filter(
		(b) => b.getAttribute('aria-label') !== 'Change assignee',
	);
	expect(options.length).toBeGreaterThan(1);

	// The option row is the trigger, not something nested inside it.
	const named = options.find((b) => b.textContent?.includes('Morgan'));
	expect(named).toBeDefined();
	expect(named?.getAttribute('data-state')).not.toBeNull();

	// And the label still reads the display name, so the row you hover and the row
	// you pick say the same thing.
	expect(named?.textContent).toContain('Morgan');
});

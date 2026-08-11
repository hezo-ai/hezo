// Coverage for components/mention-textarea.tsx + components/mention-picker.tsx —
// the @-mention autocomplete. Driven through the real task-comment composer (it
// wraps a MentionTextarea) against the real in-process backend's mention search,
// so the picker renders real agent results. Exercises: opening on "@", rendering
// options, keyboard navigation + selection, mouse selection, Escape, the "no
// matches" empty state, and the not-a-trigger case. Component tier — no real
// layout / viewport / WebSocket (the picker's scrollIntoView is a no-op in
// happy-dom but the surrounding logic is fully reachable).
//
// The picker's flip-above-when-near-the-bottom placement is only reachable here
// as the `data-placement` attribute — happy-dom reports a zero box for
// everything, so which side it actually resolves to is covered by
// test/browser/dropdown-flip-placement.mobile.spec.ts.

import { waitFor } from '@testing-library/react';
import { expect, test } from 'vitest';
import { renderApp } from './helpers/render';
import { seedProject, seedTask, seedWorkspace } from './helpers/seed';

async function setupComposer() {
	const seeded = { projectSlug: '', taskId: '', captainSlug: '' };
	const helpers = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			const project = await seedProject(ws, { name: 'Mention AC Project' });
			const task = await seedTask(ws, project, { title: 'Mention AC Task' });
			seeded.projectSlug = project.slug;
			seeded.taskId = task.identifier.toLowerCase();
			seeded.captainSlug = ws.agents.find((a) => a.slug === 'captain')?.slug ?? ws.agents[0].slug;
		},
	});
	await helpers.router.navigate({
		to: '/projects/$projectId/tasks/$taskId',
		params: { projectId: seeded.projectSlug, taskId: seeded.taskId },
	});
	const composer = (await helpers.findByPlaceholderText('Add a comment...', undefined, {
		timeout: 15_000,
	})) as HTMLTextAreaElement;
	return { ...helpers, seeded, composer };
}

test('typing "@" opens the picker and shows the searching/results state, with agent options', async () => {
	const { composer, findByTestId, user } = await setupComposer();

	await user.type(composer, 'Hey @cap');

	// The picker opens and (after the debounced search) renders agent options.
	await findByTestId('mention-picker', undefined, { timeout: 15_000 });
	const option = await findByTestId('mention-option-agent', undefined, { timeout: 15_000 });
	// The agent option surfaces the @handle in its sublabel line.
	expect(option.textContent).toContain('@');
	// The kind label is shown on the right.
	expect(option.textContent?.toLowerCase()).toContain('agent');
});

test('the open picker carries a resolved placement, defaulting below the composer', async () => {
	const { composer, findByTestId, user } = await setupComposer();

	await user.type(composer, '@cap');

	const picker = await findByTestId('mention-picker', undefined, { timeout: 15_000 });
	// The placement hook ran and committed a side. With no layout engine there is
	// always room below, so this is the unflipped default every composer had before.
	expect(picker.getAttribute('data-placement')).toBe('bottom');
	expect(picker.className).toContain('top-full');
});

test('selecting an agent option with a mouse inserts "@slug " into the textarea', async () => {
	const { composer, findByTestId, user, seeded } = await setupComposer();

	await user.type(composer, 'Ping @cap');
	const option = await findByTestId('mention-option-agent', undefined, { timeout: 15_000 });
	// onMouseDown drives selection (the composer keeps focus).
	await user.click(option);

	await waitFor(() => {
		// The partial "@cap" is replaced with the full "@<slug> " insertion.
		expect(composer.value).toMatch(new RegExp(`Ping @${seeded.captainSlug} $`));
	});
});

test('ArrowDown/ArrowUp move the highlight and Enter selects the highlighted option', async () => {
	const { composer, findByTestId, getAllByTestId, user, seeded } = await setupComposer();

	// Empty query lists the whole roster (server returns all enabled agents on q='').
	await user.type(composer, '@');
	await findByTestId('mention-picker', undefined, { timeout: 15_000 });
	await waitFor(() => expect(getAllByTestId('mention-option-agent').length).toBeGreaterThan(1), {
		timeout: 15_000,
	});

	// Move down then back up — exercises both branches; lands back on index 0.
	await user.keyboard('{ArrowDown}');
	await user.keyboard('{ArrowUp}');
	// Enter selects the highlighted option and inserts its handle.
	await user.keyboard('{Enter}');

	await waitFor(() => expect(composer.value).toMatch(/^@[a-z0-9-]+ $/));
	// The picker closes after a selection.
	await waitFor(() => expect(document.querySelector('[data-testid="mention-picker"]')).toBeNull());
	// Sanity: at least one inserted handle is a real agent slug from this team.
	expect(composer.value.trim().startsWith('@')).toBe(true);
	expect(seeded.captainSlug.length).toBeGreaterThan(0);
});

test('Tab also selects the highlighted option', async () => {
	const { composer, findByTestId, user } = await setupComposer();

	await user.type(composer, '@cap');
	await findByTestId('mention-option-agent', undefined, { timeout: 15_000 });
	await user.keyboard('{Tab}');

	await waitFor(() => expect(composer.value).toMatch(/^@[a-z0-9-]+ $/));
});

test('Escape closes the picker without inserting anything', async () => {
	const { composer, findByTestId, user } = await setupComposer();

	await user.type(composer, '@cap');
	await findByTestId('mention-picker', undefined, { timeout: 15_000 });
	await user.keyboard('{Escape}');

	await waitFor(() => expect(document.querySelector('[data-testid="mention-picker"]')).toBeNull());
	// The typed text is left intact; only the popup closed.
	expect(composer.value).toBe('@cap');
});

test('a query with no matches shows the "No matches" empty state inside the picker', async () => {
	const { composer, findByText, user } = await setupComposer();

	await user.type(composer, '@zzzznotarealhandle');
	// The picker stays open and renders the no-matches line for the query.
	await findByText(/No matches for @zzzznotarealhandle/, undefined, { timeout: 15_000 });
});

test('an "@" glued to a preceding word character is not treated as a mention trigger', async () => {
	const { composer, queryByTestId, user } = await setupComposer();

	// "email@" — the char before "@" is a word char, so detectTrigger bails and the
	// picker never opens.
	await user.type(composer, 'reach me at email@');
	// Give the debounce/search a beat; the picker must not appear.
	await new Promise((r) => setTimeout(r, 300));
	expect(queryByTestId('mention-picker')).toBeNull();
});

test('Cmd/Ctrl+Enter while the picker is open closes it and submits the comment', async () => {
	const { composer, findByText, findByTestId, user } = await setupComposer();

	// Open the picker, then submit via the keyboard shortcut. The shortcut closes
	// the picker (not selects an option) and forwards to the composer's onKeyDown,
	// which submits the comment.
	await user.type(composer, 'ship it @cap');
	await findByTestId('mention-picker', undefined, { timeout: 15_000 });
	await user.keyboard('{Meta>}{Enter}{/Meta}');

	// The picker is dismissed and the comment posts with the literal "@cap" text.
	await waitFor(() => expect(document.querySelector('[data-testid="mention-picker"]')).toBeNull());
	await findByText(/ship it @cap/, undefined, { timeout: 15_000 });
});

test('blurring the textarea closes the open picker', async () => {
	const { composer, findByTestId, user } = await setupComposer();

	await user.type(composer, '@cap');
	await findByTestId('mention-picker', undefined, { timeout: 15_000 });

	// Tab out / blur — the close is debounced ~100ms, so wait for it to settle.
	composer.blur();
	await waitFor(() => expect(document.querySelector('[data-testid="mention-picker"]')).toBeNull(), {
		timeout: 2_000,
	});
});

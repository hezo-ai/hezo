import type { SearchResult } from '@hezo/shared';
import { api } from '@hezo/web/lib/api';
import { screen, waitFor } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { renderApp } from './helpers/render';
import { seedProject, seedTask, seedWorkspace } from './helpers/seed';

afterEach(() => {
	vi.restoreAllMocks();
});

const dialogGone = () =>
	waitFor(() => expect(screen.queryByTestId('global-search-dialog')).toBeNull());

test('Cmd+K opens the search palette and Escape closes it', async () => {
	const { user } = await renderApp({ initialPath: '/home' });
	await screen.findByTestId('app-header');

	await user.keyboard('{Meta>}k{/Meta}');
	expect(await screen.findByTestId('global-search-dialog')).toBeTruthy();

	await user.keyboard('{Escape}');
	await dialogGone();
});

test('the header search button opens the palette', async () => {
	const { user } = await renderApp({ initialPath: '/home' });
	await user.click(await screen.findByTestId('app-header-search'));
	expect(await screen.findByTestId('global-search-dialog')).toBeTruthy();
});

test('shows the model-loading message while embeddings are unavailable', async () => {
	const { user } = await renderApp({ initialPath: '/home' });
	await user.click(await screen.findByTestId('app-header-search'));
	// The transformers model is never loaded in component tests, so the real
	// backend answers with the loading message rather than results.
	await user.type(await screen.findByTestId('global-search-input'), 'login');
	expect(await screen.findByTestId('search-model-loading')).toBeTruthy();
});

test('renders per-type tabs with counts, deep-links comments, and closes on select', async () => {
	let projectSlug = '';
	let identifier = '';
	const { user } = await renderApp({
		initialPath: '/home',
		seed: async () => {
			const ws = await seedWorkspace();
			const project = await seedProject(ws, { name: 'Ops' });
			const task = await seedTask(ws, project, { title: 'Fix login' });
			projectSlug = project.slug;
			identifier = task.identifier;
		},
	});

	const fixtures: SearchResult[] = [
		{
			type: 'task',
			id: 't1',
			title: `${identifier} — Fix login`,
			snippet: 'login bug',
			score: 0.9,
			projectSlug,
			taskIdentifier: identifier,
		},
		{
			type: 'comment',
			id: 'c1',
			title: `${identifier} — Fix login`,
			snippet: 'retry webhooks',
			score: 0.8,
			projectSlug,
			taskIdentifier: identifier,
			commentPublicId: '20261009112345',
		},
		{
			type: 'comment',
			id: 'c2',
			title: `${identifier} — Fix login`,
			snippet: 'invoice parsing',
			score: 0.7,
			projectSlug,
			taskIdentifier: identifier,
			commentPublicId: '20261009112400',
		},
		{
			type: 'project_doc',
			id: 'd1',
			title: 'spec.md',
			snippet: 'product spec',
			score: 0.6,
			projectSlug,
			docSlug: 'spec.md',
		},
		{ type: 'skill', id: 's1', title: 'Deploy Skill', snippet: 'how to deploy', score: 0.5 },
	];

	const realGet = api.get.bind(api);
	vi.spyOn(api, 'get').mockImplementation(((
		path: string,
		params?: Record<string, string | undefined>,
	) => {
		if (path === '/api/search') return Promise.resolve({ results: fixtures });
		return realGet(path, params);
	}) as typeof api.get);

	await user.click(await screen.findByTestId('app-header-search'));
	await user.type(await screen.findByTestId('global-search-input'), 'login');

	// One tab per type, each with its count.
	const commentTab = await screen.findByTestId('search-tab-comment');
	expect(commentTab.textContent).toContain('Comments');
	expect(commentTab.textContent).toContain('(2)');
	expect((await screen.findByTestId('search-tab-task')).textContent).toContain('(1)');
	expect((await screen.findByTestId('search-tab-project_doc')).textContent).toContain('Docs');
	expect((await screen.findByTestId('search-tab-skill')).textContent).toContain('Skills');

	// Default tab is tasks.
	expect(await screen.findByTestId('search-result-task')).toBeTruthy();

	// Switching to the comments tab shows both comments; the first deep-links to
	// its task with a #comment-<public_id> hash.
	await user.click(commentTab);
	const commentRows = await screen.findAllByTestId('search-result-comment');
	expect(commentRows).toHaveLength(2);
	const href = commentRows[0].getAttribute('href') ?? '';
	expect(href).toContain(`/projects/${projectSlug}/tasks/${identifier.toLowerCase()}`);
	expect(href).toContain('#comment-20261009112345');

	// Selecting a result closes the palette.
	await user.click(commentRows[0]);
	await dialogGone();
});

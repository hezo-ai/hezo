import type { SearchResult } from '@hezo/shared';
import { api } from '@hezo/web/lib/api';
import { screen, waitFor } from '@testing-library/react';
import { afterEach, expect, test, vi } from 'vitest';
import { renderApp } from './helpers/render';
import { seedProject, seedWorkspace } from './helpers/seed';

// Component tier (happy-dom). Exercises the SearchResults branches that
// global-search.test.tsx doesn't: the project_doc and skill row link targets,
// tab switching to a non-default tab, and the empty-results (no tabs) null
// render. Pure content + link rendering — none of the Playwright 1-6 apply.

afterEach(() => {
	vi.restoreAllMocks();
});

function mockSearch(fixtures: SearchResult[]) {
	const realGet = api.get.bind(api);
	vi.spyOn(api, 'get').mockImplementation(((
		path: string,
		params?: Record<string, string | undefined>,
	) => {
		if (path === '/api/search') return Promise.resolve({ results: fixtures });
		return realGet(path, params);
	}) as typeof api.get);
}

test('a project_doc result links to the documents page with the file search param', async () => {
	let projectSlug = '';
	const { user } = await renderApp({
		initialPath: '/home',
		seed: async () => {
			const ws = await seedWorkspace();
			const project = await seedProject(ws, { name: 'Docs Ops' });
			projectSlug = project.slug;
		},
	});

	mockSearch([
		{
			type: 'project_doc',
			id: 'd1',
			title: 'architecture.md',
			snippet: 'system overview',
			score: 0.9,
			projectSlug,
			docSlug: 'architecture.md',
		},
	]);

	await user.click(await screen.findByTestId('app-header-search'));
	await user.type(await screen.findByTestId('global-search-input'), 'arch');

	const row = await screen.findByTestId('search-result-project_doc');
	const href = row.getAttribute('href') ?? '';
	expect(href).toContain(`/projects/${projectSlug}/documents`);
	expect(href).toContain('file=architecture.md');
	expect(row.textContent).toContain('system overview');
});

test('a skill result links to the global skills settings page', async () => {
	const { user } = await renderApp({
		initialPath: '/home',
		seed: async () => {
			const ws = await seedWorkspace();
			await seedProject(ws, { name: 'Skill Ops' });
		},
	});

	mockSearch([
		{ type: 'skill', id: 's1', title: 'Deploy Skill', snippet: 'how to deploy', score: 0.8 },
	]);

	await user.click(await screen.findByTestId('app-header-search'));
	await user.type(await screen.findByTestId('global-search-input'), 'deploy');

	const row = await screen.findByTestId('search-result-skill');
	expect(row.getAttribute('href')).toBe('/settings/skills');
	expect(row.textContent).toContain('Deploy Skill');
});

test('clicking a non-default tab switches the visible result type', async () => {
	let projectSlug = '';
	const { user } = await renderApp({
		initialPath: '/home',
		seed: async () => {
			const ws = await seedWorkspace();
			const project = await seedProject(ws, { name: 'Tab Ops' });
			projectSlug = project.slug;
		},
	});

	mockSearch([
		{
			type: 'task',
			id: 't1',
			title: 'A task',
			snippet: 'task body',
			score: 0.9,
			projectSlug,
			taskIdentifier: 'OPS-1',
		},
		{ type: 'skill', id: 's1', title: 'Skill One', snippet: 'skill body', score: 0.5 },
	]);

	await user.click(await screen.findByTestId('app-header-search'));
	await user.type(await screen.findByTestId('global-search-input'), 'one');

	// Default tab is task; the skill tab is selectable and not yet active.
	const skillTab = await screen.findByTestId('search-tab-skill');
	expect(skillTab.getAttribute('aria-selected')).toBe('false');
	expect(await screen.findByTestId('search-result-task')).toBeTruthy();

	await user.click(skillTab);
	await waitFor(() => expect(skillTab.getAttribute('aria-selected')).toBe('true'));
	expect(await screen.findByTestId('search-result-skill')).toBeTruthy();
	// The task row is no longer mounted (only the active tab's rows render).
	expect(screen.queryByTestId('search-result-task')).toBeNull();
});

test('an empty result set renders no tabs and no list (the null branch)', async () => {
	const { user } = await renderApp({
		initialPath: '/home',
		seed: async () => {
			const ws = await seedWorkspace();
			await seedProject(ws, { name: 'Empty Ops' });
		},
	});

	mockSearch([]);

	await user.click(await screen.findByTestId('app-header-search'));
	await user.type(await screen.findByTestId('global-search-input'), 'nothing-matches');

	// SearchResults returns null when there are no non-empty tabs — the results
	// list never mounts. (The palette shows its own no-results copy instead.)
	await waitFor(() => {
		expect(screen.queryByTestId('search-results-list')).toBeNull();
		expect(screen.queryByTestId('search-tab-task')).toBeNull();
	});
});

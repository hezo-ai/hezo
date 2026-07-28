import { waitFor } from '@testing-library/react';
import { expect, test, vi } from 'vitest';
import { downloadTextFile } from '../src/lib/download-file';
import { renderApp } from './helpers/render';
import { seedWorkspace } from './helpers/seed';

// The actual Blob + <a download> plumbing lives in downloadTextFile and is
// exercised elsewhere; here we assert the Export team flow calls it with the
// right filename and a valid bundle body, after the explain-first dialog.
vi.mock('../src/lib/download-file', () => ({ downloadTextFile: vi.fn() }));

test('Export team explains the bundle, then downloads it', async () => {
	let projectSlug = '';
	const { findByTestId, findByText, getByTestId, router, user } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			projectSlug = ws.internalSlug;
		},
	});

	await router.navigate({
		to: '/projects/$projectId/agents',
		params: { projectId: projectSlug },
	});

	// The button sits beside "Hire agent" on the Team page.
	const exportBtn = await findByTestId('export-team-button');
	await user.click(exportBtn);

	// The dialog explains what's about to happen before anything downloads.
	await findByTestId('export-team-dialog');
	await findByText("What's included");
	const githubLink = await findByText('GitHub');
	expect(githubLink.getAttribute('href')).toContain('github.com/hezo-ai/hezo');
	expect(downloadTextFile).not.toHaveBeenCalled();

	await user.click(getByTestId('export-team-confirm'));

	await waitFor(() => expect(downloadTextFile).toHaveBeenCalledTimes(1));
	const [filename, content, mime] = (downloadTextFile as ReturnType<typeof vi.fn>).mock.calls[0];
	expect(filename).toMatch(/-team-bundle\.json$/);
	expect(mime).toBe('application/json');
	// The body is the real bundle fetched from the backend.
	const bundle = JSON.parse(content as string);
	expect(bundle.name).toBe('Demo Team');
	expect(bundle.roster.length).toBeGreaterThan(0);
	expect(bundle.captain.system_prompt).toContain('{{team_name}}');
});

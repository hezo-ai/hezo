import { api } from '@hezo/web/lib/api';
import { waitFor } from '@testing-library/react';
import { expect, test, vi } from 'vitest';
import { getTestContext, renderApp } from './helpers/render';
import { seedProject, seedWorkspace } from './helpers/seed';

/**
 * Behavioural coverage for drag-to-reorder in the project rail. happy-dom has no
 * layout engine and no pointer capture, so the pointer-drag geometry lives in
 * `test/browser/project-rail-reorder*.spec.ts`; what is asserted here is the
 * ordering contract, the keyboard path, the superuser gate, and rollback.
 */

interface RailProject {
	slug: string;
	name: string;
	id: string;
}

/** Three projects, each in its own team (a team backs exactly one project). */
async function seedThreeProjects(): Promise<RailProject[]> {
	const out: RailProject[] = [];
	for (const name of ['Alpha', 'Beta', 'Gamma']) {
		const ws = await seedWorkspace();
		const project = await seedProject(ws, { name });
		out.push({ slug: project.slug, name, id: project.id });
	}
	return out;
}

/** Force an explicit rail order, bypassing whatever creation produced. */
async function setDisplayOrder(ids: string[]): Promise<void> {
	const { db } = getTestContext();
	for (const [i, id] of ids.entries()) {
		await db.query('UPDATE projects SET display_order = $1 WHERE id = $2', [i + 1, id]);
	}
}

/** The rail's avatar slugs, in rendered document order. */
function railSlugs(): string[] {
	return Array.from(document.querySelectorAll('[data-testid^="project-rail-avatar-"]')).map(
		(el) => el.getAttribute('data-testid')?.replace('project-rail-avatar-', '') ?? '',
	);
}

test('the rail renders projects in display_order, not creation order', async () => {
	let projects: RailProject[] = [];
	const { findByTestId } = await renderApp({
		initialPath: '/home',
		seed: async () => {
			projects = await seedThreeProjects();
			// Deliberately the reverse of what creation order would give.
			await setDisplayOrder([projects[0].id, projects[1].id, projects[2].id]);
		},
	});

	await findByTestId(`project-rail-avatar-${projects[2].slug}`, undefined, { timeout: 15_000 });
	await waitFor(() =>
		expect(railSlugs()).toEqual([projects[0].slug, projects[1].slug, projects[2].slug]),
	);
});

test('Alt+ArrowDown moves a project down the rail, persists it, and announces the move', async () => {
	let projects: RailProject[] = [];
	const { findByTestId, user } = await renderApp({
		initialPath: '/home',
		seed: async () => {
			projects = await seedThreeProjects();
			await setDisplayOrder([projects[0].id, projects[1].id, projects[2].id]);
		},
	});

	const [alpha, beta, gamma] = projects;
	const first = await findByTestId(`project-rail-avatar-${alpha.slug}`, undefined, {
		timeout: 15_000,
	});
	await waitFor(() => expect(railSlugs()).toEqual([alpha.slug, beta.slug, gamma.slug]));

	first.focus();
	await user.keyboard('{Alt>}{ArrowDown}{/Alt}');

	// Optimistic: the rail settles before the server confirms.
	await waitFor(() => expect(railSlugs()).toEqual([beta.slug, alpha.slug, gamma.slug]));

	const status = await findByTestId('project-rail-reorder-status');
	expect(status.textContent).toBe('Alpha moved to position 2 of 3');

	// And it is the server's order too — reload the index from the API.
	await waitFor(async () => {
		const { apiBase, token } = getTestContext();
		const res = await apiBase('/api/projects', { headers: { Authorization: `Bearer ${token}` } });
		const body = (await res.json()) as { data: Array<{ id: string; is_internal?: boolean }> };
		expect(body.data.filter((p) => !p.is_internal).map((p) => p.id)).toEqual([
			beta.id,
			alpha.id,
			gamma.id,
		]);
	});
});

test('Alt+ArrowUp at the top of the rail does nothing', async () => {
	let projects: RailProject[] = [];
	const { findByTestId, user } = await renderApp({
		initialPath: '/home',
		seed: async () => {
			projects = await seedThreeProjects();
			await setDisplayOrder([projects[0].id, projects[1].id, projects[2].id]);
		},
	});

	const [alpha, beta, gamma] = projects;
	const first = await findByTestId(`project-rail-avatar-${alpha.slug}`, undefined, {
		timeout: 15_000,
	});
	await waitFor(() => expect(railSlugs()).toEqual([alpha.slug, beta.slug, gamma.slug]));

	const put = vi.spyOn(api, 'put');
	first.focus();
	await user.keyboard('{Alt>}{ArrowUp}{/Alt}');

	expect(put).not.toHaveBeenCalled();
	expect(railSlugs()).toEqual([alpha.slug, beta.slug, gamma.slug]);
	put.mockRestore();
});

test('a rejected reorder rolls the rail back', async () => {
	let projects: RailProject[] = [];
	const { findByTestId, findByText, user } = await renderApp({
		initialPath: '/home',
		seed: async () => {
			projects = await seedThreeProjects();
			await setDisplayOrder([projects[0].id, projects[1].id, projects[2].id]);
		},
	});

	const [alpha, beta, gamma] = projects;
	const first = await findByTestId(`project-rail-avatar-${alpha.slug}`, undefined, {
		timeout: 15_000,
	});
	await waitFor(() => expect(railSlugs()).toEqual([alpha.slug, beta.slug, gamma.slug]));

	const put = vi.spyOn(api, 'put').mockRejectedValue(new Error('nope'));
	first.focus();
	await user.keyboard('{Alt>}{ArrowDown}{/Alt}');

	// The optimistic order is restored once the mutation fails, and the user is told.
	await waitFor(() => expect(railSlugs()).toEqual([alpha.slug, beta.slug, gamma.slug]));
	await findByText(/Failed to reorder projects/);
	put.mockRestore();
});

test('a non-superuser gets an inert rail — no reorder handlers, no keyboard move', async () => {
	let projects: RailProject[] = [];
	const { findByTestId, user } = await renderApp({
		initialPath: '/home',
		seed: async (ctx) => {
			projects = await seedThreeProjects();
			await setDisplayOrder([projects[0].id, projects[1].id, projects[2].id]);
			await ctx.db.query('UPDATE users SET is_superuser = false');
		},
	});

	const [alpha, beta, gamma] = projects;
	const first = await findByTestId(`project-rail-avatar-${alpha.slug}`, undefined, {
		timeout: 15_000,
	});
	await waitFor(() => expect(railSlugs()).toEqual([alpha.slug, beta.slug, gamma.slug]));

	const put = vi.spyOn(api, 'put');
	first.focus();
	await user.keyboard('{Alt>}{ArrowDown}{/Alt}');

	expect(put).not.toHaveBeenCalled();
	expect(railSlugs()).toEqual([alpha.slug, beta.slug, gamma.slug]);
	put.mockRestore();
});

import { waitFor } from '@testing-library/react';
import { expect, test } from 'vitest';
import { renderApp } from './helpers/render';
import { type SeededWorkspace, seedProject, seedWorkspace } from './helpers/seed';

// The project's own Concurrency page: two "empty means inherit" overrides for
// the run limit and the container memory cap.

function uniqueName(base: string): string {
	return `${base} ${Math.random().toString(36).slice(2, 8)}`;
}

async function openConcurrencyPage(description: string) {
	let ws!: SeededWorkspace;
	let projectSlug = '';
	let projectId = '';

	const rendered = await renderApp({
		initialPath: '/',
		seed: async () => {
			ws = await seedWorkspace();
			const project = await seedProject(ws, { name: uniqueName(description), description });
			projectSlug = project.slug;
			projectId = project.id;
		},
	});

	await rendered.router.navigate({
		to: '/projects/$projectId/concurrency',
		params: { projectId: projectSlug },
	});

	return { ...rendered, projectId };
}

test('shows the inherited global defaults until the project overrides them', async () => {
	const { findByTestId, projectId, ctx } = await openConcurrencyPage('Inheriting project');

	const runsInput = (await findByTestId('project-max-runs-input', undefined, {
		timeout: 8_000,
	})) as HTMLInputElement;
	const memoryInput = (await findByTestId('memory-limit-gib-input')) as HTMLInputElement;

	// Empty field + the global value as the placeholder, so the effective number
	// is visible without the row claiming to be an override.
	expect(runsInput.value).toBe('');
	expect(runsInput.placeholder).toContain('3');
	expect(memoryInput.value).toBe('');
	expect(memoryInput.placeholder).toContain('1');

	const runsValue = await findByTestId('project-max-runs-value');
	expect(runsValue.textContent).toContain('3');

	const row = await ctx.db.query<{
		max_concurrent_runs: number | null;
		memory_limit_gib: number | null;
	}>('SELECT max_concurrent_runs, memory_limit_gib FROM projects WHERE id = $1', [projectId]);
	expect(row.rows[0]?.max_concurrent_runs).toBeNull();
	expect(row.rows[0]?.memory_limit_gib).toBeNull();
});

test('saves a run-limit override and clears it back to inherit', async () => {
	const { findByTestId, projectId, ctx, user } = await openConcurrencyPage('Run limit project');

	const input = (await findByTestId('project-max-runs-input', undefined, {
		timeout: 8_000,
	})) as HTMLInputElement;
	await user.clear(input);
	await user.type(input, '7');
	await user.click(await findByTestId('project-max-runs-save'));

	await waitFor(
		async () => {
			const row = await ctx.db.query<{ max_concurrent_runs: number | null }>(
				'SELECT max_concurrent_runs FROM projects WHERE id = $1',
				[projectId],
			);
			expect(row.rows[0]?.max_concurrent_runs).toBe(7);
		},
		{ timeout: 8_000 },
	);

	// Emptying the field writes NULL, so the project tracks the global default
	// again rather than freezing a copy of today's value.
	await user.clear(input);
	await user.click(await findByTestId('project-max-runs-save'));

	await waitFor(
		async () => {
			const row = await ctx.db.query<{ max_concurrent_runs: number | null }>(
				'SELECT max_concurrent_runs FROM projects WHERE id = $1',
				[projectId],
			);
			expect(row.rows[0]?.max_concurrent_runs).toBeNull();
		},
		{ timeout: 8_000 },
	);
});

test('saves a fractional container memory override and clears it', async () => {
	const { findByTestId, projectId, ctx, user } = await openConcurrencyPage('Memory cap project');

	const input = (await findByTestId('memory-limit-gib-input', undefined, {
		timeout: 8_000,
	})) as HTMLInputElement;
	await user.clear(input);
	await user.type(input, '0.5');
	await user.click(await findByTestId('memory-limit-gib-save'));

	await waitFor(
		async () => {
			const row = await ctx.db.query<{ memory_limit_gib: number | null }>(
				'SELECT memory_limit_gib FROM projects WHERE id = $1',
				[projectId],
			);
			expect(row.rows[0]?.memory_limit_gib).toBe(0.5);
		},
		{ timeout: 8_000 },
	);

	await user.clear(input);
	await user.click(await findByTestId('memory-limit-gib-save'));

	await waitFor(
		async () => {
			const row = await ctx.db.query<{ memory_limit_gib: number | null }>(
				'SELECT memory_limit_gib FROM projects WHERE id = $1',
				[projectId],
			);
			expect(row.rows[0]?.memory_limit_gib).toBeNull();
		},
		{ timeout: 8_000 },
	);
});

test('rejects an out-of-range value client-side without writing it', async () => {
	const { findByTestId, projectId, ctx, user } = await openConcurrencyPage('Range check project');

	const input = (await findByTestId('memory-limit-gib-input', undefined, {
		timeout: 8_000,
	})) as HTMLInputElement;
	await user.clear(input);
	await user.type(input, '0.2'); // below the 0.5 floor
	await user.click(await findByTestId('memory-limit-gib-save'));

	const error = await findByTestId('memory-limit-gib-error');
	expect(error.textContent).toContain('0.5');

	const row = await ctx.db.query<{ memory_limit_gib: number | null }>(
		'SELECT memory_limit_gib FROM projects WHERE id = $1',
		[projectId],
	);
	expect(row.rows[0]?.memory_limit_gib).toBeNull();
});

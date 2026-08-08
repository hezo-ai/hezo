import { expect, test, vi } from 'vitest';

// The build state arrives over a WebSocket the component harness stubs to a
// no-op, so drive `useAnyImageBuild` directly. A hoisted holder lets each test
// set the building snapshot the mocked hook returns.
//
// The card lives on the **global** Containers page rather than on a project's,
// because a base image is shared: one building holds up every container that
// needs the fresh image, so the page that answers "why is nothing starting" is
// the instance-wide one.
const buildState = vi.hoisted(() => ({
	current: null as null | {
		image: string;
		status: string;
		building: boolean;
		percent: number;
		step: number | null;
		totalSteps: number | null;
		label: string | null;
	},
}));

vi.mock('@hezo/web/hooks/use-image-build', () => ({
	useImageBuild: () => null,
	useAnyImageBuild: () => buildState.current,
}));

import { renderApp } from './helpers/render';

test('a base image being rebuilt shows above the container list, with its step and progress', async () => {
	buildState.current = {
		image: 'hezo/agent-base:latest',
		status: 'building',
		building: true,
		percent: 42,
		step: 3,
		totalSteps: 7,
		label: 'RUN bun install',
	};

	const { findByTestId, getByRole } = await renderApp({
		initialPath: '/settings/containers',
	});

	const card = await findByTestId('image-build-progress', undefined, { timeout: 20_000 });
	const bar = getByRole('progressbar');
	expect(bar.getAttribute('aria-valuenow')).toBe('42');
	expect(card.textContent ?? '').toContain('Rebuilding base image');
	// The image is named: an instance can hold projects on different base images,
	// and "a base image is building" without saying which is not actionable.
	expect(card.textContent ?? '').toContain('hezo/agent-base:latest');
	expect(card.textContent ?? '').toContain('Step 3/7');
	expect(card.textContent ?? '').toContain('RUN bun install');
});

test('no card is shown when nothing is building', async () => {
	buildState.current = null;

	const { findByTestId, queryByTestId } = await renderApp({
		initialPath: '/settings/containers',
	});

	// The list renders, so the absent card is a decision rather than a slow load.
	await findByTestId('containers-list', undefined, { timeout: 20_000 });
	expect(queryByTestId('image-build-progress')).toBeNull();
});

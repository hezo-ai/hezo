import {
	createMemoryHistory,
	createRootRoute,
	createRoute,
	createRouter,
	Outlet,
	RouterProvider,
} from '@tanstack/react-router';
import { render } from '@testing-library/react';
import type { ReactNode } from 'react';
import { expect, test } from 'vitest';
import { HqContainerNotice } from '../src/components/hq-container-notice';
import type { ContainerHealth } from '../src/hooks/use-container-health';

// Component tier (happy-dom). HqContainerNotice uses a router <Link>, so it
// renders inside a minimal standalone RouterProvider (it does not depend on the
// app's query layer). Covers every non-healthy `ContainerHealth` variant the
// `noticeTitle` switch maps, plus the pending (spinner) vs non-pending
// (alert icon) branch and the container link target.

function renderInRouter(ui: ReactNode) {
	const rootRoute = createRootRoute({ component: Outlet });
	const indexRoute = createRoute({
		getParentRoute: () => rootRoute,
		path: '/',
		component: () => <>{ui}</>,
	});
	const router = createRouter({
		routeTree: rootRoute.addChildren([indexRoute]),
		history: createMemoryHistory({ initialEntries: ['/'] }),
	});
	return render(<RouterProvider router={router} />);
}

type NonHealthy = Exclude<ContainerHealth, { kind: 'healthy' }>;

async function renderNotice(health: NonHealthy) {
	const utils = renderInRouter(
		<HqContainerNotice health={health} slug="hq-team" description="Some description here." />,
	);
	await utils.findByTestId('hq-container-notice');
	return utils;
}

test('rebuilding shows the spinner and the rebuilding title', async () => {
	const { getByTestId, getByText } = await renderNotice({ kind: 'rebuilding', percent: 40 });
	const notice = getByTestId('hq-container-notice');
	expect(notice.querySelector('.animate-spin')).toBeTruthy();
	expect(getByText('Rebuilding the HQ container…')).toBeTruthy();
});

test('provisioning/creating shows the spinner and the starting title', async () => {
	const { getByTestId, getByText } = await renderNotice({
		kind: 'provisioning',
		transient: 'creating',
	});
	expect(getByTestId('hq-container-notice').querySelector('.animate-spin')).toBeTruthy();
	expect(getByText('Starting the HQ container…')).toBeTruthy();
});

test('provisioning/stopping shows the stopping title', async () => {
	const { getByText } = await renderNotice({ kind: 'provisioning', transient: 'stopping' });
	expect(getByText('Stopping the HQ container…')).toBeTruthy();
});

test('stopped is non-pending: alert icon, not a spinner', async () => {
	const { getByTestId, getByText } = await renderNotice({ kind: 'stopped' });
	const notice = getByTestId('hq-container-notice');
	expect(notice.querySelector('.animate-spin')).toBeNull();
	expect(getByText('The HQ container isn’t running')).toBeTruthy();
});

test('error variant renders the error title', async () => {
	const { getByText } = await renderNotice({ kind: 'error' });
	expect(getByText('The HQ container has an error')).toBeTruthy();
});

test('always renders the description and a container link pointing at the slug', async () => {
	const { getByText, getByTestId } = await renderNotice({ kind: 'stopped' });
	expect(getByText('Some description here.')).toBeTruthy();
	const link = getByTestId('hq-container-notice-link') as HTMLAnchorElement;
	expect(link.getAttribute('href')).toContain('/projects/hq-team/container');
});

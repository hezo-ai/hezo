// Branch-coverage for LogViewer's presentational logic: the formattable
// switcher + viewMode branches, the copy button (disabled-when-empty, success
// → Check icon), the auto-scroll toggle, the empty-state ternary
// (custom vs default), the raw stdout/stderr colour branch, the formatted-view
// branch (delegates to FormattedLogView), and the expand → fullscreen Dialog
// portal branch.
//
// SKIPPED (need real layout, not happy-dom): the auto-scroll effect and
// toggleExpanded's scroll-offset preservation read scrollHeight/clientHeight/
// scrollTop, which happy-dom reports as 0. Those are exercised by Playwright.
//
// copyToClipboard is mocked so the copy-success path is deterministic without a
// real Clipboard API in happy-dom.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
	createMemoryHistory,
	createRootRoute,
	createRouter,
	RouterProvider,
} from '@tanstack/react-router';
import { render, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type React from 'react';
import { expect, test, vi } from 'vitest';
import { withI18n } from './helpers/i18n';

const copyMock = vi.fn(async (_text: string) => true);
vi.mock('../src/lib/clipboard', () => ({
	copyToClipboard: (text: string) => copyMock(text),
}));

import { LogViewer, type LogViewerLine } from '../src/components/log-viewer';

function makeLines(...parts: [string, 'stdout' | 'stderr'][]): LogViewerLine[] {
	return parts.map(([text, stream], i) => ({ id: i, stream, text }));
}

async function renderViewer(props: React.ComponentProps<typeof LogViewer>) {
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	const rootRoute = createRootRoute({ component: () => <LogViewer {...props} /> });
	const router = createRouter({
		routeTree: rootRoute,
		history: createMemoryHistory({ initialEntries: ['/'] }),
	});
	const utils = render(
		withI18n(
			<QueryClientProvider client={qc}>
				{/* biome-ignore lint/suspicious/noExplicitAny: opaque router type at the test boundary. */}
				<RouterProvider router={router as any} />
			</QueryClientProvider>,
		),
	);
	// RouterProvider resolves its pending route on a microtask.
	await waitFor(() =>
		expect(utils.getByRole('button', { name: 'Copy logs to clipboard' })).toBeTruthy(),
	);
	return utils;
}

test('non-formattable viewer: no Formatted/Raw switcher, lines render raw, line count shows', async () => {
	const { queryByLabelText, getByText } = await renderViewer({
		lines: makeLines(['out line', 'stdout'], ['err line', 'stderr']),
		testId: 'lv',
	});
	// The switcher buttons only mount when formattable.
	expect(queryByLabelText('Formatted view')).toBeNull();
	expect(queryByLabelText('Raw logs')).toBeNull();
	// Line count.
	expect(getByText('2 lines')).toBeTruthy();
});

test('raw view colours stderr lines danger and stdout lines text-1', async () => {
	const { getByText } = await renderViewer({
		lines: makeLines(['normal', 'stdout'], ['boom', 'stderr']),
		testId: 'lv',
	});
	expect(getByText('normal').className).toContain('text-text-1');
	const err = getByText('boom');
	expect(err.className).toContain('text-danger');
	expect(err.className).not.toContain('text-text-1');
});

test('empty viewer: default "No output." shows, custom emptyState overrides it, and copy is disabled', async () => {
	const def = await renderViewer({ lines: [], testId: 'lv' });
	expect(def.getByText('No output.')).toBeTruthy();
	const copyBtn = def.getByRole('button', { name: 'Copy logs to clipboard' });
	expect((copyBtn as HTMLButtonElement).disabled).toBe(true);

	const custom = await renderViewer({ lines: [], emptyState: 'Nothing streamed yet' });
	expect(custom.getByText('Nothing streamed yet')).toBeTruthy();
});

test('liveLabel renders in the header when provided', async () => {
	const { getByText } = await renderViewer({
		lines: makeLines(['x', 'stdout']),
		liveLabel: <span>LIVE</span>,
	});
	expect(getByText('LIVE')).toBeTruthy();
});

test('copy button: success flips the icon to a Check then is enabled for non-empty logs', async () => {
	const { getByRole, container } = await renderViewer({ lines: makeLines(['line a', 'stdout']) });
	const copyBtn = getByRole('button', { name: 'Copy logs to clipboard' });
	expect((copyBtn as HTMLButtonElement).disabled).toBe(false);
	await userEvent.setup({ delay: null }).click(copyBtn);
	expect(copyMock).toHaveBeenCalledWith('line a');
	// On success the lucide "check" icon replaces "copy" (lucide tags the svg).
	const svg = copyBtn.querySelector('svg');
	expect(svg?.classList.contains('lucide-check')).toBe(true);
});

test('auto-scroll toggle flips aria-pressed', async () => {
	const { getByRole } = await renderViewer({ lines: makeLines(['x', 'stdout']) });
	const btn = getByRole('button', { name: 'Toggle auto-scroll' });
	// Defaults on.
	expect(btn.getAttribute('aria-pressed')).toBe('true');
	await userEvent.setup({ delay: null }).click(btn);
	expect(btn.getAttribute('aria-pressed')).toBe('false');
});

test('formattable viewer defaults to formatted view, hides [tool] prefix, toggles to raw and back', async () => {
	const user = userEvent.setup({ delay: null });
	const { getByLabelText, getByTestId, getByText } = await renderViewer({
		formattable: true,
		testId: 'lv-body',
		lines: makeLines(['[tool] Bash(command=ls)', 'stdout'], ['[tool-result] done', 'stdout']),
	});
	// Formatted view button is pressed by default.
	expect(getByLabelText('Formatted view').getAttribute('aria-pressed')).toBe('true');
	expect(getByLabelText('Raw logs').getAttribute('aria-pressed')).toBe('false');
	// Formatted: the tool name shows without its raw prefix.
	expect(getByText('Bash')).toBeTruthy();
	expect(getByTestId('lv-body').textContent).not.toContain('[tool]');

	// Switch to Raw: literal prefixed line appears.
	await user.click(getByLabelText('Raw logs'));
	expect(getByTestId('lv-body').textContent).toContain('[tool] Bash(command=ls)');
	expect(getByLabelText('Raw logs').getAttribute('aria-pressed')).toBe('true');

	// Back to Formatted.
	await user.click(getByLabelText('Formatted view'));
	expect(getByTestId('lv-body').textContent).not.toContain('[tool]');
});

test('expanding a formattable viewer focuses the dialog itself, not the Formatted-view button', async () => {
	const user = userEvent.setup({ delay: null });
	const { getByRole } = await renderViewer({
		formattable: true,
		lines: makeLines(['[tool] Bash(command=ls)', 'stdout']),
	});
	await user.click(getByRole('button', { name: 'Expand log viewer' }));
	const dialog = document.body.querySelector('[data-testid="log-viewer-fullscreen"]');
	expect(dialog).not.toBeNull();
	// Radix's dialog would otherwise auto-focus the first tabbable element —
	// the Formatted-view button — popping its tooltip open over the expanded
	// viewer.
	expect(document.activeElement).toBe(dialog);
	expect(document.activeElement).not.toBe(getByRole('button', { name: 'Formatted view' }));
});

test('headerAction / headerActionLeading slots render in the header', async () => {
	const { getByText } = await renderViewer({
		lines: makeLines(['x', 'stdout']),
		headerAction: <span>TRAILING</span>,
		headerActionLeading: <span>LEADING</span>,
	});
	expect(getByText('TRAILING')).toBeTruthy();
	expect(getByText('LEADING')).toBeTruthy();
});

test('expand opens the fullscreen Dialog portal and the collapse toggle closes it', async () => {
	const user = userEvent.setup({ delay: null });
	const { getByRole } = await renderViewer({ lines: makeLines(['payload', 'stdout']) });

	// Expand → fullscreen dialog mounts in a body portal.
	await user.click(getByRole('button', { name: 'Expand log viewer' }));
	const dialog = document.body.querySelector('[data-testid="log-viewer-fullscreen"]');
	expect(dialog).not.toBeNull();
	// The expanded header now offers a Collapse affordance.
	const collapse = within(dialog as HTMLElement).getByRole('button', {
		name: 'Collapse log viewer',
	});
	await user.click(collapse);
	expect(document.body.querySelector('[data-testid="log-viewer-fullscreen"]')).toBeNull();
});

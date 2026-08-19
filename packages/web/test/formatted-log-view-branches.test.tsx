// Branch-coverage for FormattedLogView's per-block-type rendering and the
// conditional sub-branches inside each block view. It depends on the router
// (Markdown/comment-ref links) and a QueryClient (MarkdownProse fans out
// mention-resolution queries), so it's rendered in a minimal root-route +
// query harness. Each `lines` array drives parseAgentLog into a specific block
// shape; the assertions then exercise the view branches.

import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
	createMemoryHistory,
	createRootRoute,
	createRouter,
	RouterProvider,
} from '@tanstack/react-router';
import { render, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type React from 'react';
import { expect, test } from 'vitest';
import { FormattedLogView } from '../src/components/formatted-log-view';

interface Line {
	id: number;
	stream: 'stdout' | 'stderr';
	text: string;
}

function lines(...texts: (string | [string, 'stdout' | 'stderr'])[]): Line[] {
	return texts.map((t, i) =>
		Array.isArray(t)
			? { id: i, stream: t[1], text: t[0] }
			: { id: i, stream: 'stdout' as const, text: t },
	);
}

async function renderLog(props: React.ComponentProps<typeof FormattedLogView>) {
	const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
	const rootRoute = createRootRoute({ component: () => <FormattedLogView {...props} /> });
	const router = createRouter({
		routeTree: rootRoute,
		history: createMemoryHistory({ initialEntries: ['/'] }),
	});
	const utils = render(
		<QueryClientProvider client={qc}>
			{/* biome-ignore lint/suspicious/noExplicitAny: opaque router type at the test boundary. */}
			<RouterProvider router={router as any} />
		</QueryClientProvider>,
	);
	// RouterProvider resolves its pending route on a microtask.
	await waitFor(() => expect(utils.container.querySelector('div')).not.toBeNull());
	return utils;
}

test('session block shows the model, and the "· N tools" suffix only when toolCount is present', async () => {
	const { getByText, queryByText } = await renderLog({
		lines: lines('[session] model=claude-opus tools=42'),
	});
	expect(getByText('claude-opus')).toBeTruthy();
	expect(getByText('· 42 tools')).toBeTruthy();
});

test('session block omits the tools suffix when no tools= token is present', async () => {
	const { getByText, queryByText } = await renderLog({
		lines: lines('[session] model=gpt-5'),
	});
	expect(getByText('gpt-5')).toBeTruthy();
	expect(queryByText(/tools/)).toBeNull();
});

test('text block (stdout) renders as markdown prose; stderr text renders as a danger <pre>', async () => {
	const { getByText, container } = await renderLog({
		lines: lines('Hello **world**', ['traceback: boom', 'stderr']),
	});
	// stdout markdown → bold node.
	expect(getByText('world').tagName.toLowerCase()).toBe('strong');
	// stderr → monospace danger pre.
	const pre = getByText(/traceback: boom/);
	expect(pre.tagName.toLowerCase()).toBe('pre');
	expect(pre.className).toContain('text-danger-soft-fg');
});

test('thinking block renders the Thinking header and reflowed prose', async () => {
	const { getByText } = await renderLog({
		lines: lines('[thinking] My plan: 1. First 2. Second 3. Third'),
	});
	expect(getByText('Thinking')).toBeTruthy();
	const item = getByText('First');
	expect(item.closest('li')).not.toBeNull();
});

test('consecutive [thinking] lines coalesce into one block rendered as separate paragraphs', async () => {
	const { getByText, container } = await renderLog({
		lines: lines(
			'[thinking] First, understand the picture.',
			'[thinking]',
			'[thinking] Then read the thread and decide.',
		),
	});
	// One Thinking header (a single coalesced block), not one per line.
	expect(container.querySelectorAll('[data-testid="thinking-block"]')).toHaveLength(1);
	// The bare `[thinking]` blank line becomes a paragraph break: two <p> elements,
	// each carrying one of the model's paragraphs, rather than one run-on line.
	const first = getByText('First, understand the picture.');
	const second = getByText('Then read the thread and decide.');
	expect(first.tagName.toLowerCase()).toBe('p');
	expect(second.tagName.toLowerCase()).toBe('p');
	expect(first).not.toBe(second);
});

test('thinking block renders whole with no Show more toggle when it does not overflow', async () => {
	// happy-dom reports 0 for scroll/clientHeight, so the clamp measurement never
	// detects overflow — the block degrades to its full content with no toggle and
	// no line-clamp. The clamp/expand behaviour itself is a real-browser concern
	// (see agent-run-logs.spec.ts).
	const long = Array.from({ length: 60 }, () => 'reasoning').join(' ');
	const { getByText, queryByTestId, getByTestId } = await renderLog({
		lines: lines(`[thinking] ${long}`),
	});
	expect(getByText('Thinking')).toBeTruthy();
	expect(getByText(new RegExp(long.slice(0, 40)))).toBeTruthy();
	expect(queryByTestId('thinking-toggle')).toBeNull();
	expect(getByTestId('thinking-content').className).not.toContain('line-clamp-3');
});

test('command block: a short command is non-interactive (no chevron, cursor-default)', async () => {
	const { getByRole, queryByText } = await renderLog({ lines: lines('$ ls -la') });
	const btn = getByRole('button');
	// Short command → aria-expanded undefined and default cursor.
	expect(btn.getAttribute('aria-expanded')).toBeNull();
	expect(btn.className).toContain('cursor-default');
});

test('command block: a long command is expandable and toggles between truncate and wrap', async () => {
	const long = `echo ${'x'.repeat(120)}`;
	const { getByRole, container } = await renderLog({ lines: lines(`$ ${long}`) });
	const btn = getByRole('button');
	expect(btn.getAttribute('aria-expanded')).toBe('false');
	// Collapsed: the text span is truncated.
	const span = container.querySelector('span.truncate');
	expect(span).not.toBeNull();
	await userEvent.setup({ delay: null }).click(btn);
	expect(btn.getAttribute('aria-expanded')).toBe('true');
	// Expanded: wraps instead of truncating.
	expect(container.querySelector('span.whitespace-pre-wrap')).not.toBeNull();
});

test('tool block: mcp__ name renders "server / tool" label; toggles to show args + result', async () => {
	const { getByText, queryByText, getByRole } = await renderLog({
		lines: lines('[tool] mcp__linear__create_issue(title=Fix bug)', '[tool-result] Created LIN-1'),
	});
	// mcp name → "linear / create_issue".
	expect(getByText('linear / create_issue')).toBeTruthy();
	// Collapsed: result hidden.
	expect(queryByText('Created LIN-1')).toBeNull();
	await userEvent.setup({ delay: null }).click(getByRole('button'));
	// Expanded: args preview and the success result both show.
	expect(getByText('Created LIN-1')).toBeTruthy();
});

test('tool block: a Bash tool with no result shows the "No result captured" placeholder on expand', async () => {
	const { getByText, getByRole } = await renderLog({ lines: lines('[tool] Bash(command=pwd)') });
	expect(getByText('Bash')).toBeTruthy();
	await userEvent.setup({ delay: null }).click(getByRole('button'));
	expect(getByText('No result captured.')).toBeTruthy();
});

test('tool block: an errored tool result renders the danger-tinted result pre on expand', async () => {
	const { getByText, getByRole } = await renderLog({
		lines: lines('[tool] Read(file=missing.txt)', '[tool-error] ENOENT no such file'),
	});
	await userEvent.setup({ delay: null }).click(getByRole('button'));
	const pre = getByText(/ENOENT no such file/);
	expect(pre.className).toContain('bg-danger-soft');
});

test('tool block: a bare mcp__ name (no tool segment) falls back to the raw name', async () => {
	const { getByText } = await renderLog({ lines: lines('[tool] mcp__server(arg=1)') });
	// parts.slice(2) is empty → label falls back to the full name.
	expect(getByText('mcp__server')).toBeTruthy();
});

test('tool block: a generic tool name (not Bash, not mcp__) renders the wrench-labelled name', async () => {
	const { getByText } = await renderLog({ lines: lines('[tool] Grep(pattern=foo)') });
	expect(getByText('Grep')).toBeTruthy();
});

test('result block (no matching pending tool): success result renders neutral, error renders danger', async () => {
	const ok = await renderLog({ lines: lines('[tool-result] orphan ok output') });
	const okPre = ok.getByText(/orphan ok output/);
	expect(okPre.className).toContain('bg-surface-3');

	const bad = await renderLog({ lines: lines('[tool-error] orphan error output') });
	const badPre = bad.getByText(/orphan error output/);
	expect(badPre.className).toContain('bg-danger-soft');
});

test('done block: success status renders a green badge with turns/duration/tokens/cost', async () => {
	const { getByText } = await renderLog({
		lines: lines('[done] success turns=5 duration=2500ms tokens=1200/3400 cost=$0.1234'),
	});
	expect(getByText('success')).toBeTruthy();
	expect(getByText('5 turns')).toBeTruthy();
	// 2500ms → "2.5s".
	expect(getByText('2.5s')).toBeTruthy();
	// tokens localized with separators.
	expect(getByText(/1,200 in/)).toBeTruthy();
	expect(getByText(/3,400 out/)).toBeTruthy();
	// cost toFixed(2).
	expect(getByText('$0.12')).toBeTruthy();
});

test('done block: an error status renders the red badge and omits the optional metrics', async () => {
	const { getByText, queryByText } = await renderLog({ lines: lines('[done] error') });
	const badge = getByText('error');
	// Optional spans absent when their fields are null.
	expect(queryByText(/turns/)).toBeNull();
	expect(queryByText(/in \//)).toBeNull();
	expect(badge).toBeTruthy();
});

test('done block: an "error_during_xyz" status still classes as an error badge', async () => {
	const { getByText } = await renderLog({ lines: lines('[done] error_during_setup turns=1') });
	expect(getByText('error_during_setup')).toBeTruthy();
	expect(getByText('1 turns')).toBeTruthy();
});

test('done block: sub-second duration formats as ms; multi-minute formats as "Nm Ns"', async () => {
	const ms = await renderLog({ lines: lines('[done] success duration=750ms') });
	expect(ms.getByText('750ms')).toBeTruthy();

	const mins = await renderLog({ lines: lines('[done] success duration=125000ms') });
	// 125000ms = 2m 5s.
	expect(mins.getByText('2m 5s')).toBeTruthy();
});

test('done block: only input tokens present still renders the in/out span (out defaults to 0)', async () => {
	const { getByText } = await renderLog({ lines: lines('[done] success tokens=900/0') });
	expect(getByText(/900 in/)).toBeTruthy();
	expect(getByText(/0 out/)).toBeTruthy();
});

test('system block: stdout lines render text-3; stderr lines render danger, and consecutive same-stream lines coalesce', async () => {
	const { getByText } = await renderLog({
		lines: lines('[system] cloning repo', '[system] checkout done'),
	});
	const pre = getByText(/cloning repo/);
	expect(pre.tagName.toLowerCase()).toBe('pre');
	expect(pre.className).toContain('text-text-3');
	// Coalesced into one <pre> joined by newline.
	expect(pre.textContent).toContain('checkout done');
});

test('system block: a stderr system line renders the danger colour', async () => {
	const { getByText } = await renderLog({ lines: lines(['[system] disk full', 'stderr']) });
	const pre = getByText(/disk full/);
	expect(pre.className).toContain('text-danger-soft-fg');
});

test('renders nothing meaningful for an empty line set (no blocks)', async () => {
	const { container } = await renderLog({ lines: [], testId: 'empty-log' });
	const root = container.querySelector('[data-testid="empty-log"]');
	expect(root).not.toBeNull();
	expect(root?.children.length).toBe(0);
});

test('runner block: a line naming another run links it to that run in its own project', async () => {
	const { container } = await renderLog({
		lines: lines(
			'[runner] Waiting for [growth-analyst/HM-336](/projects/hezo-marketing/agents/growth-analyst/executions/run-hm-336) to finish with this credential.',
			'[runner] Credential free, starting the run.',
		),
	});
	const block = container.querySelector('[data-testid="log-runner-block"]');
	expect(block).not.toBeNull();
	const link = block?.querySelector('[data-testid="run-link"]');
	expect(link?.getAttribute('href')).toBe(
		'/projects/hezo-marketing/agents/growth-analyst/executions/run-hm-336',
	);
	expect(link?.textContent).toBe('growth-analyst/HM-336');
	// The sentence reads exactly as written around the link, and the plain line
	// stays plain.
	expect(block?.textContent).toContain(
		'Waiting for growth-analyst/HM-336 to finish with this credential.',
	);
	expect(block?.textContent).toContain('Credential free, starting the run.');
	expect(block?.querySelectorAll('[data-testid="run-link"]')).toHaveLength(1);
});

test('runner block: a markdown link to anything but a run stays verbatim text', async () => {
	const { container } = await renderLog({
		lines: lines('[runner] See [the docs](https://hezo.ai/docs) for details.'),
	});
	const block = container.querySelector('[data-testid="log-runner-block"]');
	expect(block?.textContent).toBe('See [the docs](https://hezo.ai/docs) for details.');
	expect(block?.querySelector('[data-testid="run-link"]')).toBeNull();
});

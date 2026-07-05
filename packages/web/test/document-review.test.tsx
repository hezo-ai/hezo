import { fireEvent, waitFor } from '@testing-library/react';
import { expect, test, vi } from 'vitest';
import { getTestContext, renderApp } from './helpers/render';
import {
	type SeededProject,
	type SeededWorkspace,
	seedDocument,
	seedProject,
	seedReviewComment,
	seedWorkspace,
} from './helpers/seed';

// Document review comments on the Documents tab (view mode): highlight
// rendering from seeded comments, the margin-icon editor flows, clear-review,
// the action-this-review handoff dialog, the help dialog, and the two creation
// paths (text selection → pill, hover-a-line → ghost icon).

function uniqueName(base: string): string {
	return `${base} ${Math.random().toString(36).slice(2, 8)}`;
}

const DOC_CONTENT = [
	'# Spec Title',
	'',
	'Alpha paragraph with target text inside.',
	'',
	'Beta paragraph repeats token foo bar foo here.',
].join('\n');

// A doc whose reviewable content is a GFM table — the structural case where the
// hast text stream (with "\n" nodes between rows/cells) diverges from the DOM
// text stream a selection walks, unless the highlight plugin skips them.
const TABLE_DOC_CONTENT = [
	'# Security Rules',
	'',
	'| Rule | Scope |',
	'| --- | --- |',
	'| Never use raw HTML | All components |',
	'| Export is static | utils/export.ts |',
].join('\n');

interface Setup {
	ws: SeededWorkspace;
	project: SeededProject;
	filename: string;
}

async function setupDocumentsPage(opts?: {
	content?: string;
	ready?: string;
	comments?: Array<{ quote: string; occurrence?: number; comment: string }>;
}) {
	let setup!: Setup;
	const content = opts?.content ?? DOC_CONTENT;
	const utils = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			const project = await seedProject(ws, { name: uniqueName('Review Project') });
			const filename = `spec-${Math.random().toString(36).slice(2, 8)}.md`;
			await seedDocument(ws, project, { filename, content });
			for (const c of opts?.comments ?? []) {
				await seedReviewComment(ws, project, filename, c);
			}
			setup = { ws, project, filename };
		},
	});
	await utils.router.navigate({
		to: '/projects/$projectId/documents',
		params: { projectId: setup.project.slug },
		search: { file: setup.filename },
	});
	await utils.findByText(opts?.ready ?? 'Alpha paragraph with target text inside.', {
		exact: false,
	});
	return { ...utils, ...setup };
}

async function reviewCommentRows(): Promise<
	Array<{ quote: string; occurrence: number; comment: string }>
> {
	const { db } = getTestContext();
	const res = await db.query<{ quote: string; occurrence: number; comment: string }>(
		'SELECT quote, occurrence, comment FROM document_review_comments ORDER BY created_at',
	);
	return res.rows;
}

test('renders seeded review comments as highlights with margin icons and a count chip', async () => {
	const { container, findByTestId } = await setupDocumentsPage({
		comments: [
			{ quote: 'target text', comment: 'Sharpen this phrase' },
			{ quote: 'foo', occurrence: 1, comment: 'Second foo only' },
		],
	});

	await waitFor(() => {
		expect(container.querySelectorAll('mark[data-review-id]').length).toBe(2);
	});
	const marks = Array.from(container.querySelectorAll('mark[data-review-id]'));
	const markTexts = marks.map((m) => m.textContent);
	expect(markTexts).toContain('target text');
	expect(markTexts).toContain('foo');

	// Occurrence disambiguation: the highlighted foo is the SECOND one — the
	// text before it in its paragraph still contains the first foo.
	const fooMark = marks.find((m) => m.textContent === 'foo');
	expect(fooMark?.previousSibling?.textContent).toContain('foo bar ');

	// Margin icons (one per comment) and the count chip.
	expect(container.querySelectorAll('[data-testid="review-margin-icon"]').length).toBe(2);
	expect((await findByTestId('review-count-chip')).textContent).toContain('2');
});

test('clicking the count chip scrolls to the first review comment in the document', async () => {
	const { container, findByTestId, user } = await setupDocumentsPage({
		comments: [
			// 'Spec Title' anchors into the H1 (topmost); 'target text' is lower in
			// the first paragraph. The chip must jump to the FIRST — the topmost.
			{ quote: 'target text', comment: 'lower comment' },
			{ quote: 'Spec Title', comment: 'top comment' },
		],
	});

	await waitFor(() => {
		expect(container.querySelectorAll('mark[data-review-id]').length).toBe(2);
	});
	const firstMark = container.querySelector('mark[data-review-id]');
	expect(firstMark?.textContent).toBe('Spec Title');

	// happy-dom's scrollIntoView is a no-op with no layout, so assert the wiring:
	// the chip scrolls the topmost highlight into view. Real scroll movement +
	// the sticky-header clearance are covered in test/browser/docs-actions-sticky.spec.ts.
	const scrolled: Element[] = [];
	const spy = vi.spyOn(Element.prototype, 'scrollIntoView').mockImplementation(function (
		this: Element,
	) {
		scrolled.push(this);
	});
	try {
		await user.click(await findByTestId('review-count-chip'));
		expect(scrolled).toHaveLength(1);
		expect(scrolled[0]).toBe(firstMark);
	} finally {
		spy.mockRestore();
	}
});

test('groups the review-comment controls in a bordered cluster, apart from the document actions', async () => {
	const { findByTestId, getByTestId, getByRole } = await setupDocumentsPage({
		comments: [{ quote: 'target text', comment: 'Group me' }],
	});

	// Wait for the comments query to resolve (count chip appears) so every review
	// control is mounted before we assert on the grouping.
	const chip = await findByTestId('review-count-chip');
	const toolbar = getByTestId('review-toolbar');

	// The review-comment controls — count, action-this-review, clear-review and
	// the "?" help — all live inside the one grouped cluster.
	expect(toolbar.contains(chip)).toBe(true);
	for (const testid of ['review-action-open', 'review-clear', 'review-help']) {
		expect(toolbar.querySelector(`[data-testid="${testid}"]`)).toBeTruthy();
	}

	// The cluster is visually contained (rounded, bordered, tinted background) so
	// it reads as one group distinct from the actions beside it.
	expect(toolbar.className).toContain('rounded-lg');
	expect(toolbar.className).toContain('border');
	expect(toolbar.className).toContain('bg-surface-2');

	// The document-level meta actions sit OUTSIDE the review cluster — that
	// separation is the whole point. In particular the trash inside the cluster
	// (clear the review) and the archive action beside it live in different
	// groups (active docs offer Archive; the hard delete only shows once
	// archived).
	const popout = getByTestId('doc-popout');
	const editButton = getByRole('button', { name: 'Edit' });
	const archiveDoc = getByRole('button', { name: 'Archive document' });
	expect(toolbar.contains(popout)).toBe(false);
	expect(toolbar.contains(editButton)).toBe(false);
	expect(toolbar.contains(archiveDoc)).toBe(false);
	// The clear-review trash, by contrast, is inside the cluster.
	expect(toolbar.contains(getByTestId('review-clear'))).toBe(true);
});

test('clicking a margin icon opens the editor and saving updates the comment', async () => {
	const { container, findByTestId, user } = await setupDocumentsPage({
		comments: [{ quote: 'target text', comment: 'Original comment' }],
	});

	await waitFor(() => {
		expect(container.querySelectorAll('[data-testid="review-margin-icon"]').length).toBe(1);
	});
	await user.click(container.querySelector('[data-testid="review-margin-icon"]') as HTMLElement);

	const textarea = (await findByTestId('review-editor-textarea')) as HTMLTextAreaElement;
	expect(textarea.value).toBe('Original comment');
	await user.clear(textarea);
	await user.type(textarea, 'Sharper wording please');
	await user.click(await findByTestId('review-editor-save'));

	await waitFor(async () => {
		const rows = await reviewCommentRows();
		expect(rows.length).toBe(1);
		expect(rows[0].comment).toBe('Sharper wording please');
	});
	expect(container.querySelector('[data-testid="review-editor"]')).toBeNull();
});

test('clicking a highlight opens the editor and delete removes the highlight', async () => {
	const { container, findByTestId, user } = await setupDocumentsPage({
		comments: [{ quote: 'target text', comment: 'To be deleted' }],
	});

	await waitFor(() => {
		expect(container.querySelectorAll('mark[data-review-id]').length).toBe(1);
	});
	await user.click(container.querySelector('mark[data-review-id]') as HTMLElement);
	await user.click(await findByTestId('review-editor-delete'));

	await waitFor(async () => {
		expect(container.querySelectorAll('mark[data-review-id]').length).toBe(0);
		expect((await reviewCommentRows()).length).toBe(0);
	});
});

test('clear review deletes every comment after confirmation', async () => {
	const { container, findByTestId, user } = await setupDocumentsPage({
		comments: [
			{ quote: 'target text', comment: 'one' },
			{ quote: 'Spec Title', comment: 'two' },
		],
	});

	await waitFor(() => {
		expect(container.querySelectorAll('mark[data-review-id]').length).toBe(2);
	});
	await user.click(await findByTestId('review-clear'));

	// The confirm dialog portals onto document.body; the portal mounts asynchronously.
	const confirm = await waitFor(() => {
		const el = document.body.querySelector('[data-testid="confirm-dialog-confirm"]');
		expect(el).toBeTruthy();
		return el as HTMLElement;
	});
	await user.click(confirm);

	await waitFor(async () => {
		expect(container.querySelectorAll('mark[data-review-id]').length).toBe(0);
		expect((await reviewCommentRows()).length).toBe(0);
	});
	expect(container.querySelector('[data-testid="review-count-chip"]')).toBeNull();
});

test('action dialog shows the agent handoff and copies it to the clipboard', async () => {
	const { findByTestId, filename, user } = await setupDocumentsPage({
		comments: [{ quote: 'target text', comment: 'Expand this' }],
	});

	const written: string[] = [];
	const originalDesc = Object.getOwnPropertyDescriptor(navigator, 'clipboard');
	Object.defineProperty(navigator, 'clipboard', {
		configurable: true,
		value: {
			writeText: async (t: string) => {
				written.push(t);
			},
		},
	});
	try {
		// The action button is disabled until the comments query resolves — the
		// count chip appearing means count > 0 and the button is clickable.
		await findByTestId('review-count-chip');
		await user.click(await findByTestId('review-action-open'));

		// Dialog portals onto document.body; the portal mounts asynchronously.
		const handoff = await waitFor(() => {
			const el = document.body.querySelector('[data-testid="action-review-handoff"]');
			expect(el).toBeTruthy();
			return el as HTMLElement;
		});
		expect(handoff.textContent).toContain(filename);
		expect(handoff.textContent).toContain('automatically deletes every review comment');

		const copy = document.body.querySelector('[data-testid="action-review-copy"]') as HTMLElement;
		await user.click(copy);
		await waitFor(() => {
			expect(written.length).toBe(1);
			expect(written[0]).toContain(filename);
			expect(copy.getAttribute('aria-label')).toBe('Copied');
		});
	} finally {
		if (originalDesc) Object.defineProperty(navigator, 'clipboard', originalDesc);
		else delete (navigator as { clipboard?: unknown }).clipboard;
	}
});

test('the ? help dialog explains that document updates wipe the review', async () => {
	const { findByTestId, user } = await setupDocumentsPage({
		comments: [{ quote: 'target text', comment: 'x' }],
	});

	await user.click(await findByTestId('review-help'));
	await waitFor(() => {
		expect(document.body.textContent).toContain(
			'automatically deletes all existing review comments',
		);
	});
});

test('selecting text raises the comment pill and saving creates an anchored comment', async () => {
	const { container, findByTestId, user } = await setupDocumentsPage();

	const para = Array.from(container.querySelectorAll('p')).find((p) =>
		p.textContent?.includes('target text'),
	) as HTMLElement;
	const textNode = para.firstChild as Text;
	const start = textNode.data.indexOf('target text');

	const range = document.createRange();
	range.setStart(textNode, start);
	range.setEnd(textNode, start + 'target text'.length);
	const selection = window.getSelection();
	selection?.removeAllRanges();
	selection?.addRange(range);
	document.dispatchEvent(new Event('selectionchange'));

	const pill = await findByTestId('review-selection-pill');
	fireEvent.mouseDown(pill);

	const editor = await findByTestId('review-editor');
	expect(editor.textContent).toContain('target text');
	await user.type(
		(await findByTestId('review-editor-textarea')) as HTMLTextAreaElement,
		'Needs a concrete example',
	);
	await user.click(await findByTestId('review-editor-save'));

	await waitFor(async () => {
		const rows = await reviewCommentRows();
		expect(rows.length).toBe(1);
		expect(rows[0].quote).toBe('target text');
		expect(rows[0].occurrence).toBe(0);
		expect(rows[0].comment).toBe('Needs a concrete example');
	});
	await waitFor(() => {
		const mark = container.querySelector('mark[data-review-id]');
		expect(mark?.textContent).toBe('target text');
	});
});

test('selecting across table cells anchors a comment that renders as a highlight', async () => {
	// Regression: a review comment left on a markdown table showed neither the
	// highlight nor the margin icon. The browser drops the whitespace-only "\n"
	// nodes between a table's rows/cells, so a cross-cell selection captured
	// "RuleScope" while the highlight plugin saw "Rule\nScope" and never matched.
	const { container, findByTestId, user } = await setupDocumentsPage({
		content: TABLE_DOC_CONTENT,
		ready: 'Never use raw HTML',
	});

	// Select from the start of the "Rule" header cell across into the "Scope" one.
	const headers = Array.from(container.querySelectorAll('th'));
	const ruleText = headers.find((th) => th.textContent === 'Rule')?.firstChild as Text;
	const scopeText = headers.find((th) => th.textContent === 'Scope')?.firstChild as Text;
	expect(ruleText).toBeTruthy();
	expect(scopeText).toBeTruthy();

	const range = document.createRange();
	range.setStart(ruleText, 0);
	range.setEnd(scopeText, 'Scope'.length);
	const selection = window.getSelection();
	selection?.removeAllRanges();
	selection?.addRange(range);
	document.dispatchEvent(new Event('selectionchange'));

	const pill = await findByTestId('review-selection-pill');
	fireEvent.mouseDown(pill);

	await user.type(
		(await findByTestId('review-editor-textarea')) as HTMLTextAreaElement,
		'These headers need clarifying',
	);
	await user.click(await findByTestId('review-editor-save'));

	// The DOM stream concatenates the two cells with no separator.
	await waitFor(async () => {
		const rows = await reviewCommentRows();
		expect(rows.length).toBe(1);
		expect(rows[0].quote).toBe('RuleScope');
		expect(rows[0].occurrence).toBe(0);
	});

	// The anchor resolves back to a highlight (one mark per spanned cell) AND a
	// margin icon — the two things the bug suppressed.
	await waitFor(() => {
		const marks = Array.from(container.querySelectorAll('mark[data-review-id]'));
		expect(marks.map((m) => m.textContent)).toEqual(['Rule', 'Scope']);
		expect(container.querySelectorAll('[data-testid="review-margin-icon"]').length).toBe(1);
	});
});

test('hovering a line raises the ghost icon and clicking comments on the whole line', async () => {
	const { container, findByTestId, user } = await setupDocumentsPage();

	const para = Array.from(container.querySelectorAll('p')).find((p) =>
		p.textContent?.includes('Alpha paragraph'),
	) as HTMLElement;
	fireEvent.mouseOver(para);

	await user.click(await findByTestId('review-line-ghost'));

	const editor = await findByTestId('review-editor');
	expect(editor.textContent).toContain('Alpha paragraph with target text inside.');
	await user.type(
		(await findByTestId('review-editor-textarea')) as HTMLTextAreaElement,
		'Rewrite this whole line',
	);
	await user.click(await findByTestId('review-editor-save'));

	await waitFor(async () => {
		const rows = await reviewCommentRows();
		expect(rows.length).toBe(1);
		expect(rows[0].quote).toBe('Alpha paragraph with target text inside.');
	});
	await waitFor(() => {
		const mark = container.querySelector('mark[data-review-id]');
		expect(mark?.textContent).toBe('Alpha paragraph with target text inside.');
	});
});

import { fireEvent, waitFor } from '@testing-library/react';
import { expect, test } from 'vitest';
import { getTestContext, renderApp } from './helpers/render';
import {
	archiveSeededAsset,
	type SeededAsset,
	type SeededProject,
	type SeededWorkspace,
	seedAsset,
	seedAssetReviewComment,
	seedProject,
	seedWorkspace,
} from './helpers/seed';

// The split-pane asset viewer (/projects/:slug/assets/view?file=…): per-type
// left-pane rendering, the document-style anchored review flow on text assets,
// whole-asset comments on non-text assets via the right panel, archived
// read-only mode, and the asset-flavored "Action this review" handoff.

const MD_CONTENT = [
	'# Launch Post',
	'',
	'Alpha paragraph with target text inside.',
	'',
	'Beta paragraph closes it out.',
].join('\n');

interface Setup {
	ws: SeededWorkspace;
	project: SeededProject;
	asset: SeededAsset;
}

async function setupViewer(input: {
	filename: string;
	contentType?: string;
	bytes?: Uint8Array;
	folder?: string;
	comments?: Array<{ quote?: string; occurrence?: number; comment: string }>;
	archived?: boolean;
}) {
	let setup!: Setup;
	const utils = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			const project = await seedProject(ws, { name: 'Viewer Project' });
			const asset = await seedAsset(ws, project, {
				filename: input.filename,
				contentType: input.contentType,
				bytes: input.bytes,
				folder: input.folder,
			});
			for (const c of input.comments ?? []) {
				await seedAssetReviewComment(ws, project, asset.id, c);
			}
			if (input.archived) await archiveSeededAsset(ws, project, asset.id, true);
			setup = { ws, project, asset };
		},
	});
	await utils.router.navigate({
		to: '/projects/$projectId/assets/view',
		params: { projectId: setup.project.slug },
		search: { file: setup.asset.original_filename },
	});
	await utils.findByTestId('asset-viewer');
	return { ...utils, ...setup };
}

async function assetReviewRows(): Promise<
	Array<{ quote: string | null; occurrence: number; comment: string }>
> {
	const { db } = getTestContext();
	const res = await db.query<{ quote: string | null; occurrence: number; comment: string }>(
		'SELECT quote, occurrence, comment FROM review_comments WHERE asset_id IS NOT NULL ORDER BY created_at',
	);
	return res.rows;
}

test('selecting text in a markdown asset creates an anchored comment, like a document', async () => {
	const { container, findByTestId, user } = await setupViewer({
		filename: 'post.md',
		contentType: 'text/markdown',
		bytes: new TextEncoder().encode(MD_CONTENT),
	});

	// The markdown body renders through the shared review surface.
	const rendered = await findByTestId('asset-viewer-rendered');
	await waitFor(() => expect(rendered.querySelector('h1')?.textContent).toBe('Launch Post'));

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
		const rows = await assetReviewRows();
		expect(rows.length).toBe(1);
		expect(rows[0].quote).toBe('target text');
		expect(rows[0].comment).toBe('Needs a concrete example');
	});
	// The highlight renders in the left pane and the comment lists in the panel.
	await waitFor(() => {
		expect(container.querySelector('mark[data-review-id]')?.textContent).toBe('target text');
	});
	const row = await findByTestId('asset-review-row');
	expect(row.textContent).toContain('Needs a concrete example');
	expect(row.textContent).toContain('target text');
});

test('a plain-text asset renders seeded quote anchors as highlights in its <pre>', async () => {
	const txt = 'first line of output\nsecond line with the flaky assertion\nthird line';
	const { container, findByTestId } = await setupViewer({
		filename: 'log.txt',
		contentType: 'text/plain',
		bytes: new TextEncoder().encode(txt),
		comments: [{ quote: 'flaky assertion', comment: 'This is the real bug' }],
	});

	const pre = await findByTestId('asset-plain-text');
	expect(pre.textContent).toBe(txt);
	await waitFor(() => {
		const mark = container.querySelector('mark[data-review-id]');
		expect(mark?.textContent).toBe('flaky assertion');
	});
	// Clicking the panel row activates its highlight.
	const row = await findByTestId('asset-review-row');
	(row.querySelector('button') as HTMLButtonElement).click();
	await waitFor(() => expect(row.getAttribute('data-active')).toBe('true'));
});

test('an image takes whole-asset comments from the panel composer, with edit and delete', async () => {
	const { findByTestId, queryByTestId, user } = await setupViewer({ filename: 'shot.png' });

	await findByTestId('asset-viewer-image');

	// Non-text assets compose whole-asset comments in the right panel.
	await user.click(await findByTestId('asset-review-composer-open'));
	await user.type(
		(await findByTestId('asset-review-composer')) as HTMLTextAreaElement,
		'The logo is off-center',
	);
	await user.click(await findByTestId('asset-review-composer-save'));

	const row = await findByTestId('asset-review-row');
	expect(row.textContent).toContain('Whole asset');
	expect(row.textContent).toContain('The logo is off-center');
	await waitFor(async () => {
		const rows = await assetReviewRows();
		expect(rows.length).toBe(1);
		expect(rows[0].quote).toBeNull();
	});

	// Inline edit.
	await user.click(await findByTestId('asset-review-edit'));
	const editArea = (await findByTestId('asset-review-edit-textarea')) as HTMLTextAreaElement;
	await user.clear(editArea);
	await user.type(editArea, 'Center the logo');
	await user.click(await findByTestId('asset-review-edit-save'));
	await waitFor(async () => {
		expect((await assetReviewRows())[0].comment).toBe('Center the logo');
	});

	// Delete empties the review.
	await user.click(await findByTestId('asset-review-delete'));
	await waitFor(async () => {
		expect((await assetReviewRows()).length).toBe(0);
	});
	expect(queryByTestId('asset-review-row')).toBeNull();
});

test('an html asset renders in a sandboxed iframe that permits user-initiated downloads', async () => {
	const { findByTestId } = await setupViewer({
		filename: 'mockup.html',
		contentType: 'text/html',
		bytes: new TextEncoder().encode('<h1>hi</h1>'),
	});

	const frame = (await findByTestId('asset-viewer-html')) as HTMLIFrameElement;
	const sandbox = frame.getAttribute('sandbox') ?? '';
	expect(sandbox).toContain('allow-scripts');
	// Without allow-downloads the browser silently blocks an in-page "Download"
	// button; it must stay in lockstep with the serve-side sandbox CSP.
	expect(sandbox).toContain('allow-downloads');
});

test('a PDF renders the metadata card with an open-raw link', async () => {
	const { findByTestId } = await setupViewer({
		filename: 'spec.pdf',
		contentType: 'application/pdf',
		bytes: new TextEncoder().encode('%PDF-1.4 fake'),
	});

	const card = await findByTestId('asset-viewer-metadata');
	expect(card.textContent).toContain('spec.pdf');
	expect(card.textContent).toContain('application/pdf');
	expect(card.querySelector('a[target="_blank"]')).toBeTruthy();
});

test('an archived asset renders read-only: no composer, frozen review', async () => {
	const { findByTestId, queryByTestId } = await setupViewer({
		filename: 'old.png',
		comments: [{ comment: 'Kept for the record' }],
		archived: true,
	});

	await findByTestId('asset-viewer-image');
	// The seeded comment is still visible…
	const row = await findByTestId('asset-review-row');
	expect(row.textContent).toContain('Kept for the record');
	// …but nothing is editable: no composer, no per-row edit/delete, clear disabled.
	expect(queryByTestId('asset-review-composer-open')).toBeNull();
	expect(queryByTestId('asset-review-edit')).toBeNull();
	expect(queryByTestId('asset-review-delete')).toBeNull();
	const clear = (await findByTestId('review-clear')) as HTMLButtonElement;
	expect(clear.disabled).toBe(true);
});

test('"Action this review" hands off with the asset-flavored blurb', async () => {
	const { findByTestId, user } = await setupViewer({
		filename: 'post.md',
		contentType: 'text/markdown',
		bytes: new TextEncoder().encode(MD_CONTENT),
		folder: 'launch',
		comments: [{ quote: 'target text', comment: 'Sharpen this' }],
	});

	// The count chip appearing means the comments query has landed — before
	// that the action button is disabled (count 0).
	await findByTestId('review-count-chip');
	await user.click(await findByTestId('review-action-open'));
	const handoff = await waitFor(() => {
		const el = document.body.querySelector('[data-testid="action-review-handoff"]');
		expect(el).toBeTruthy();
		return el as HTMLElement;
	});
	expect(handoff.textContent).toContain('assets/launch/post.md');
	expect(handoff.textContent).toContain('read_project_asset');
	expect(handoff.textContent).toContain('write_project_asset');
});

test('the viewer breadcrumb walks back to the grid folder and Open raw links the signed URL', async () => {
	const { findByTestId, findByText, router, user, asset, project } = await setupViewer({
		filename: 'hero.png',
		contentType: 'image/png',
		folder: 'launch',
	});

	const raw = (await findByTestId('asset-viewer-raw')) as HTMLAnchorElement;
	// Each list fetch mints a fresh signature, so match the stable prefix only.
	expect(raw.getAttribute('href')).toContain(`/api/assets/${asset.id}?exp=`);
	expect(raw.getAttribute('target')).toBe('_blank');

	// The Download button points at the same signed URL with `&download=1` (which
	// makes the serve route force an attachment) and carries the basename so the
	// browser saves it rather than opening it.
	const download = (await findByTestId('asset-viewer-download')) as HTMLAnchorElement;
	expect(download.getAttribute('href')).toContain(`/api/assets/${asset.id}?exp=`);
	expect(download.getAttribute('href')).toContain('&download=1');
	expect(download.getAttribute('download')).toBe('hero.png');

	// Breadcrumb: Assets › launch › hero.png; the folder crumb returns to the grid.
	const crumb = await findByTestId('asset-viewer-breadcrumb');
	expect(crumb.textContent).toContain('hero.png');
	await user.click(await findByText('launch'));
	await waitFor(() => {
		expect(router.state.location.pathname).toBe(`/projects/${project.slug}/assets`);
		expect(router.state.location.search).toMatchObject({ folder: 'launch' });
	});
});

test('switches the viewed asset via the header name search', async () => {
	let projectSlug = '';
	let fileA = '';
	let fileB = '';

	const { findByTestId, user, router } = await renderApp({
		initialPath: '/',
		seed: async () => {
			const ws = await seedWorkspace();
			const project = await seedProject(ws, { name: 'Asset Switcher Project' });
			const a = await seedAsset(ws, project, {
				filename: 'alpha.md',
				contentType: 'text/markdown',
				bytes: new TextEncoder().encode('# Alpha asset'),
				folder: 'community-posts',
			});
			const b = await seedAsset(ws, project, {
				filename: 'bravo.md',
				contentType: 'text/markdown',
				bytes: new TextEncoder().encode('# Bravo asset'),
			});
			projectSlug = project.slug;
			fileA = a.original_filename;
			fileB = b.original_filename;
		},
	});

	await router.navigate({
		to: '/projects/$projectId/assets/view',
		params: { projectId: projectSlug },
		search: { file: fileA },
	});

	const crumb = await findByTestId('asset-viewer-breadcrumb');
	expect(crumb.textContent).toContain('alpha.md');

	// Open the header switcher and jump to the other asset by name.
	await user.click(await findByTestId('asset-switch-button'));
	await user.type(await findByTestId('asset-switch-search'), 'bravo');
	await user.click(await findByTestId(`asset-switch-option-${fileB}`));

	await waitFor(() => {
		expect(router.state.location.search).toMatchObject({ file: fileB });
	});
	await waitFor(async () => {
		expect((await findByTestId('asset-viewer-breadcrumb')).textContent).toContain('bravo.md');
	});
});

const CSV_CONTENT = [
	'original_tweet_url,reply_text,priority',
	'https://x.com/a/1,"Orchestration, memory, and handoffs.",high',
	'https://x.com/b/2,Verification loops beat hovering.,low',
].join('\n');

test('a CSV asset renders as a table, with the raw file behind Source', async () => {
	const { container, findByTestId, queryByTestId, user } = await setupViewer({
		filename: 'x-replies.csv',
		contentType: 'text/plain',
		bytes: new TextEncoder().encode(CSV_CONTENT),
		comments: [{ quote: 'Verification loops', comment: 'Lead with this one' }],
	});

	const table = await findByTestId('asset-csv-table');
	expect(Array.from(table.querySelectorAll('th')).map((th) => th.textContent)).toEqual([
		'original_tweet_url',
		'reply_text',
		'priority',
	]);

	// Quoting is resolved: the cell holds the field's value, commas and all, and
	// the row is three cells rather than one run of raw text.
	const firstRow = table.querySelectorAll('tbody tr')[0];
	expect(Array.from(firstRow.querySelectorAll('td')).map((td) => td.textContent)).toEqual([
		'https://x.com/a/1',
		'Orchestration, memory, and handoffs.',
		'high',
	]);
	expect(table.textContent).not.toContain('"Orchestration');
	// The raw text view is not what the viewer opens on.
	expect(queryByTestId('asset-viewer-source')).toBeNull();

	// A seeded quote anchors inside its cell, exactly as it does in plain text.
	await waitFor(() => {
		const mark = container.querySelector('td mark[data-review-id]');
		expect(mark?.textContent).toBe('Verification loops');
	});

	// Source shows the file as written, quoting included.
	await user.click(await findByTestId('asset-viewer-source-tab'));
	const source = await findByTestId('asset-viewer-source');
	expect(source.textContent).toBe(CSV_CONTENT);
	expect(queryByTestId('asset-csv-table')).toBeNull();
});

test('selecting inside a CSV cell anchors a comment to that cell text', async () => {
	const { container, findByTestId, user } = await setupViewer({
		filename: 'x-replies.csv',
		contentType: 'text/plain',
		bytes: new TextEncoder().encode(CSV_CONTENT),
	});

	await findByTestId('asset-csv-table');
	const cell = Array.from(container.querySelectorAll('td')).find((td) =>
		td.textContent?.includes('Orchestration'),
	) as HTMLElement;
	const textNode = cell.firstChild?.firstChild as Text;
	const start = textNode.data.indexOf('memory');

	const range = document.createRange();
	range.setStart(textNode, start);
	range.setEnd(textNode, start + 'memory'.length);
	const selection = window.getSelection();
	selection?.removeAllRanges();
	selection?.addRange(range);
	document.dispatchEvent(new Event('selectionchange'));

	fireEvent.mouseDown(await findByTestId('review-selection-pill'));
	await user.type(
		(await findByTestId('review-editor-textarea')) as HTMLTextAreaElement,
		'Say what is remembered',
	);
	await user.click(await findByTestId('review-editor-save'));

	await waitFor(async () => {
		const rows = await assetReviewRows();
		expect(rows.length).toBe(1);
		expect(rows[0].quote).toBe('memory');
	});
	// The saved anchor resolves back over the table's own text stream.
	await waitFor(() => {
		expect(container.querySelector('td mark[data-review-id]')?.textContent).toBe('memory');
	});
});

test('hovering a CSV cell comments on that whole cell', async () => {
	const { container, findByTestId, user } = await setupViewer({
		filename: 'x-replies.csv',
		contentType: 'text/plain',
		bytes: new TextEncoder().encode(CSV_CONTENT),
	});

	await findByTestId('asset-csv-table');
	const cell = Array.from(container.querySelectorAll('td')).find(
		(td) => td.textContent === 'Verification loops beat hovering.',
	) as HTMLElement;
	fireEvent.mouseOver(cell);

	await user.click(await findByTestId('review-line-ghost'));
	const editor = await findByTestId('review-editor');
	expect(editor.textContent).toContain('Verification loops beat hovering.');
	await user.type(
		(await findByTestId('review-editor-textarea')) as HTMLTextAreaElement,
		'Cut the second sentence',
	);
	await user.click(await findByTestId('review-editor-save'));

	await waitFor(async () => {
		const rows = await assetReviewRows();
		expect(rows.length).toBe(1);
		expect(rows[0].quote).toBe('Verification loops beat hovering.');
	});
});

test('a .csv with nothing to split into columns stays plain text', async () => {
	const lines = 'first line of notes\nsecond line of notes';
	const { findByTestId, queryByTestId } = await setupViewer({
		filename: 'notes.csv',
		contentType: 'text/plain',
		bytes: new TextEncoder().encode(lines),
	});

	expect((await findByTestId('asset-plain-text')).textContent).toBe(lines);
	expect(queryByTestId('asset-csv-table')).toBeNull();
	expect(queryByTestId('asset-viewer-preview-tab')).toBeNull();
});

test('URLs in a CSV cell render as links, bounded by the cell they sit in', async () => {
	const content = [
		'original_tweet_url,reply_text,contact',
		'https://x.com/PenguinWeb3/status/2087206311586918767,"Ask about it (see www.hezo.ai/docs).",ops@hezo.ai',
	].join('\n');
	const { container, findByTestId } = await setupViewer({
		filename: 'links.csv',
		contentType: 'text/plain',
		bytes: new TextEncoder().encode(content),
	});

	const table = await findByTestId('asset-csv-table');
	const links = Array.from(table.querySelectorAll('a'));
	expect(links.map((a) => [a.textContent, a.getAttribute('href')])).toEqual([
		[
			'https://x.com/PenguinWeb3/status/2087206311586918767',
			'https://x.com/PenguinWeb3/status/2087206311586918767',
		],
		// A bare www host gains a scheme; the trailing `).` stays outside the link.
		['www.hezo.ai/docs', 'https://www.hezo.ai/docs'],
		['ops@hezo.ai', 'mailto:ops@hezo.ai'],
	]);
	for (const a of links) {
		expect(a.getAttribute('target')).toBe('_blank');
		expect(a.getAttribute('rel')).toBe('noopener noreferrer');
	}

	// The cells still read exactly as parsed - linking adds elements, never text.
	const firstRow = table.querySelectorAll('tbody tr')[0];
	expect(Array.from(firstRow.querySelectorAll('td')).map((td) => td.textContent)).toEqual([
		'https://x.com/PenguinWeb3/status/2087206311586918767',
		'Ask about it (see www.hezo.ai/docs).',
		'ops@hezo.ai',
	]);
	// A header cell holds no URL, so the header row gains no links.
	expect(container.querySelectorAll('th a').length).toBe(0);
});

test('a URL ending one CSV cell never runs into the next cell', async () => {
	// The table anchors review quotes over a flat stream that concatenates cells
	// with no separator ("…/a" + "high"), so links have to be found per cell.
	const content = ['url,priority', 'https://x.com/a,high'].join('\n');
	const { findByTestId } = await setupViewer({
		filename: 'adjacent.csv',
		contentType: 'text/plain',
		bytes: new TextEncoder().encode(content),
	});

	const table = await findByTestId('asset-csv-table');
	const links = Array.from(table.querySelectorAll('a'));
	expect(links.length).toBe(1);
	expect(links[0].textContent).toBe('https://x.com/a');
	expect(links[0].getAttribute('href')).toBe('https://x.com/a');
});

test('a plain-text asset links its URLs and still anchors review quotes across them', async () => {
	const txt = 'run failed, see https://ci.example.com/job/42 for the log\nsecond line';
	const { container, findByTestId } = await setupViewer({
		filename: 'run.txt',
		contentType: 'text/plain',
		bytes: new TextEncoder().encode(txt),
		comments: [{ quote: 'see https://ci.example.com/job/42 for', comment: 'Link the run instead' }],
	});

	const pre = await findByTestId('asset-plain-text');
	// The rendered text stream is byte-identical to the file, which is what keeps
	// selection anchors resolvable.
	expect(pre.textContent).toBe(txt);

	const link = pre.querySelector('a') as HTMLAnchorElement;
	expect(link.textContent).toBe('https://ci.example.com/job/42');
	expect(link.getAttribute('href')).toBe('https://ci.example.com/job/42');

	// The seeded quote spans the link, so the highlight wraps it rather than
	// being displaced by it.
	await waitFor(() => {
		const marks = Array.from(container.querySelectorAll('mark[data-review-id]'));
		expect(marks.map((m) => m.textContent).join('')).toBe('see https://ci.example.com/job/42 for');
		expect(marks.some((m) => m.querySelector('a'))).toBe(true);
	});
});

/**
 * Failure-time page forensics for the browser tier.
 *
 * A browser test that only fails in CI is diagnosed by looking at the page, and
 * every artifact that lets you do that - the trace, the HTML report, Playwright's
 * own `error-context.md` - is a *download*. That is a slow loop, and for the
 * failure class this tier actually produces it is the wrong one: almost every
 * CI-only failure here is a measurement taken against a frame of reference that
 * moved, so the question is "what was stacked above the scroller this time",
 * which is one `evaluate` away while the page is still open.
 *
 * So on failure this dumps the shell's geometry into the job log directly:
 * viewport, the scroller's box and its scroll metrics, every sibling stacked
 * above it, every fixed/sticky element with a visible box, and whatever occupies
 * the top band of the page. Those are the things that shift a reading without
 * changing what the assertion is looking at. Console output, page errors and
 * failed requests ride along, because a banner that only renders on CI usually
 * got there via a request that only fails on CI.
 *
 * It is `testInfo.attach`ed as well as logged, so the HTML report carries the
 * same text next to the trace for anyone who does download the artifact.
 */

import { writeFile } from 'node:fs/promises';
import type { Page, TestInfo } from '@playwright/test';

/** Console lines are unbounded in principle; a failing page can spam. */
const MAX_CONSOLE_LINES = 80;
const MAX_LINE_CHARS = 400;
/** Deep trees exist; the shell we care about is shallow. */
const OUTLINE_DEPTH = 3;

interface Box {
	x: number;
	y: number;
	w: number;
	h: number;
}

interface ShellNode {
	tag: string;
	testid: string | null;
	cls: string;
	rect: Box;
	position: string;
	z: string;
}

interface ScrollerNode extends ShellNode {
	scrollTop: number;
	scrollHeight: number;
	clientHeight: number;
	overflowY: string;
}

interface LayoutSnapshot {
	url: string;
	viewport: { w: number; h: number; dpr: number };
	documentScroll: { top: number; height: number };
	main: ScrollerNode | null;
	/** Siblings preceding `<main>` at each ancestor level, outermost level last. */
	above: ShellNode[];
	/** Every `fixed`/`sticky` element with a visible box - the usual culprits. */
	pinned: ShellNode[];
	/** Anything with a testid intersecting the top 200px, which names the growth. */
	topBand: ShellNode[];
	/** Shallow tag/testid tree from `<body>`, for orientation. */
	outline: string[];
}

/**
 * What the page recorded while the test ran. Attached at fixture setup so a
 * failure mid-navigation still has the lines that preceded it.
 */
export interface PageRecording {
	console: string[];
	pageErrors: string[];
	failedRequests: string[];
}

function clip(s: string): string {
	return s.length > MAX_LINE_CHARS ? `${s.slice(0, MAX_LINE_CHARS)}…` : s;
}

/**
 * Start recording. Returns the live buffer; listeners stay attached for the
 * test's lifetime and are dropped with the page.
 */
export function recordPage(page: Page): PageRecording {
	const rec: PageRecording = { console: [], pageErrors: [], failedRequests: [] };
	page.on('console', (msg) => {
		if (rec.console.length < MAX_CONSOLE_LINES) {
			rec.console.push(clip(`[${msg.type()}] ${msg.text()}`));
		}
	});
	page.on('pageerror', (err) => {
		if (rec.pageErrors.length < MAX_CONSOLE_LINES) rec.pageErrors.push(clip(err.message));
	});
	page.on('requestfailed', (req) => {
		if (rec.failedRequests.length < MAX_CONSOLE_LINES) {
			rec.failedRequests.push(clip(`${req.method()} ${req.url()} - ${req.failure()?.errorText}`));
		}
	});
	page.on('response', (res) => {
		if (res.status() >= 400 && rec.failedRequests.length < MAX_CONSOLE_LINES) {
			rec.failedRequests.push(clip(`${res.status()} ${res.request().method()} ${res.url()}`));
		}
	});
	return rec;
}

/**
 * Read the shell's geometry out of the live page.
 *
 * Runs entirely inside the browser (one round trip) and is deliberately
 * defensive: it is called on a page that has already failed, possibly mid-
 * navigation, so every lookup tolerates a missing node rather than throwing a
 * second error over the first.
 */
async function collectLayout(page: Page, depth: number): Promise<LayoutSnapshot> {
	return page.evaluate((outlineDepth: number) => {
		const box = (el: Element) => {
			const r = el.getBoundingClientRect();
			return {
				x: Math.round(r.x),
				y: Math.round(r.y),
				w: Math.round(r.width),
				h: Math.round(r.height),
			};
		};
		const describe = (el: Element) => {
			const cs = getComputedStyle(el);
			return {
				tag: el.tagName.toLowerCase(),
				testid: el.getAttribute('data-testid'),
				cls: (el.getAttribute('class') ?? '').slice(0, 120),
				rect: box(el),
				position: cs.position,
				z: cs.zIndex,
			};
		};

		const main = document.querySelector('main');
		const mainNode = main
			? {
					...describe(main),
					scrollTop: Math.round(main.scrollTop),
					scrollHeight: Math.round(main.scrollHeight),
					clientHeight: Math.round(main.clientHeight),
					overflowY: getComputedStyle(main).overflowY,
				}
			: null;

		// Walk main -> body, recording every preceding sibling that occupies
		// space. This is the list that answers "what pushed the scroller down".
		const above: ReturnType<typeof describe>[] = [];
		for (
			let node: Element | null = main;
			node && node !== document.body;
			node = node.parentElement
		) {
			for (let sib = node.previousElementSibling; sib; sib = sib.previousElementSibling) {
				if (sib.getBoundingClientRect().height > 0) above.push(describe(sib));
			}
		}

		const all = Array.from(document.querySelectorAll('*')).slice(0, 6000);
		const pinned = all
			.filter((el) => {
				const p = getComputedStyle(el).position;
				return (p === 'fixed' || p === 'sticky') && el.getBoundingClientRect().height > 0;
			})
			.slice(0, 40)
			.map(describe);

		const seen = new Set<string>();
		const topBand: ReturnType<typeof describe>[] = [];
		for (const el of all) {
			const id = el.getAttribute('data-testid');
			if (!id || seen.has(id)) continue;
			const r = el.getBoundingClientRect();
			if (r.height > 0 && r.top < 200 && r.bottom > 0) {
				seen.add(id);
				topBand.push(describe(el));
				if (topBand.length >= 40) break;
			}
		}

		const outline: string[] = [];
		const walk = (el: Element, level: number) => {
			if (level > outlineDepth || outline.length >= 60) return;
			const id = el.getAttribute('data-testid');
			const r = el.getBoundingClientRect();
			outline.push(
				`${'  '.repeat(level)}<${el.tagName.toLowerCase()}${id ? ` #${id}` : ''}> ` +
					`y=${Math.round(r.y)} h=${Math.round(r.height)}`,
			);
			for (const child of Array.from(el.children)) walk(child, level + 1);
		};
		walk(document.body, 0);

		return {
			url: location.href,
			viewport: {
				w: window.innerWidth,
				h: window.innerHeight,
				dpr: window.devicePixelRatio,
			},
			documentScroll: {
				top: Math.round(document.documentElement.scrollTop),
				height: Math.round(document.documentElement.scrollHeight),
			},
			main: mainNode,
			above,
			pinned,
			topBand,
			outline,
		};
	}, depth);
}

function node(n: ShellNode): string {
	const id = n.testid ? ` #${n.testid}` : '';
	return `<${n.tag}${id}> y=${n.rect.y} h=${n.rect.h} w=${n.rect.w} pos=${n.position} z=${n.z}`;
}

function section(title: string, lines: string[]): string[] {
	return lines.length ? [`\n${title}:`, ...lines.map((l) => `  ${l}`)] : [`\n${title}: (none)`];
}

function format(snap: LayoutSnapshot, rec: PageRecording, info: TestInfo): string {
	const out: string[] = [
		`----- page state at failure: ${info.titlePath.join(' > ')} -----`,
		`status=${info.status} expected=${info.expectedStatus} retry=${info.retry} project=${info.project.name}`,
		`url=${snap.url}`,
		`viewport=${snap.viewport.w}x${snap.viewport.h} dpr=${snap.viewport.dpr}`,
		`document scrollTop=${snap.documentScroll.top} scrollHeight=${snap.documentScroll.height}`,
	];

	out.push(
		snap.main
			? `\n<main>: ${node(snap.main)} scrollTop=${snap.main.scrollTop} ` +
					`scrollHeight=${snap.main.scrollHeight} clientHeight=${snap.main.clientHeight} ` +
					`overflowY=${snap.main.overflowY}`
			: '\n<main>: (absent)',
	);

	out.push(...section('stacked above <main>', snap.above.map(node)));
	out.push(...section('fixed / sticky', snap.pinned.map(node)));
	out.push(...section('top 200px', snap.topBand.map(node)));
	out.push(...section('outline', snap.outline));
	out.push(...section('console', rec.console));
	out.push(...section('page errors', rec.pageErrors));
	out.push(...section('failed requests', rec.failedRequests));
	out.push('----- end page state -----');
	return out.join('\n');
}

/**
 * Dump the page's state for a failed test, to the job log and to the report.
 *
 * Never throws: it runs during teardown of an already-failing test, and turning
 * a diagnosable failure into an unrelated fixture error would defeat the point.
 */
export async function dumpFailureDiagnostics(
	page: Page,
	info: TestInfo,
	rec: PageRecording,
): Promise<void> {
	let text: string;
	try {
		text = format(await collectLayout(page, OUTLINE_DEPTH), rec, info);
	} catch (e) {
		// A crashed or closed page cannot be measured, but the recording still
		// holds whatever the page said on the way down - which is often the answer.
		text = [
			`----- page state at failure: ${info.titlePath.join(' > ')} -----`,
			`could not read the page: ${(e as Error).message}`,
			...section('console', rec.console),
			...section('page errors', rec.pageErrors),
			...section('failed requests', rec.failedRequests),
			'----- end page state -----',
		].join('\n');
	}
	// stdout first: this is the channel that needs no download, which is the
	// whole reason this exists.
	console.log(text);
	// Then to a real file next to the trace, rather than an inline attachment
	// body. Both show up in the HTML report, but only a file lands in the
	// uploaded artifact as something greppable - and it is what CI's
	// print-failure-context step globs for.
	try {
		const file = info.outputPath('page-state.md');
		await writeFile(file, `\`\`\`\n${text}\n\`\`\`\n`, 'utf8');
		await info.attach('page-state.md', { path: file, contentType: 'text/markdown' });
	} catch {
		// The log above is the primary channel; losing the file is not worth
		// failing an already-failed test over.
	}
}

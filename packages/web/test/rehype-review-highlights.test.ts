import { describe, expect, it } from 'vitest';
import {
	applyReviewHighlights,
	findQuoteRange,
	type ReviewAnnotation,
} from '../src/lib/rehype-review-highlights';

// Pure-tree tests for the highlight anchoring: quotes resolve against the hast
// text stream by (quote, occurrence) and get wrapped in <mark data-review-id>.

interface Node {
	type: string;
	tagName?: string;
	value?: string;
	properties?: Record<string, unknown>;
	children?: Node[];
}

const text = (value: string): Node => ({ type: 'text', value });
const el = (tagName: string, ...children: Node[]): Node => ({
	type: 'element',
	tagName,
	children,
});
const root = (...children: Node[]): Node => ({ type: 'root', children });

function marks(node: Node): Node[] {
	const found: Node[] = [];
	const walk = (n: Node) => {
		if (n.tagName === 'mark') found.push(n);
		for (const c of n.children ?? []) walk(c);
	};
	walk(node);
	return found;
}

function textContent(node: Node): string {
	if (node.type === 'text') return node.value ?? '';
	return (node.children ?? []).map(textContent).join('');
}

const ann = (id: string, quote: string, occurrence = 0): ReviewAnnotation => ({
	id,
	quote,
	occurrence,
});

describe('findQuoteRange', () => {
	it('finds the nth occurrence', () => {
		expect(findQuoteRange('foo bar foo', 'foo', 0)).toEqual({ start: 0, end: 3 });
		expect(findQuoteRange('foo bar foo', 'foo', 1)).toEqual({ start: 8, end: 11 });
	});

	it('handles overlapping occurrences', () => {
		expect(findQuoteRange('aaaa', 'aa', 1)).toEqual({ start: 1, end: 3 });
	});

	it('returns null when not found or occurrence exceeds matches', () => {
		expect(findQuoteRange('hello', 'x', 0)).toBeNull();
		expect(findQuoteRange('foo', 'foo', 1)).toBeNull();
		expect(findQuoteRange('abc', '', 0)).toBeNull();
	});
});

describe('applyReviewHighlights', () => {
	it('wraps a quote inside a single text node, splitting around it', () => {
		const tree = root(el('p', text('The quick brown fox jumps.')));
		const matched = applyReviewHighlights(tree, [ann('a1', 'quick brown')]);

		expect(matched).toEqual(new Set(['a1']));
		const p = tree.children?.[0] as Node;
		expect(p.children?.map((c) => c.type)).toEqual(['text', 'element', 'text']);
		expect(textContent(p)).toBe('The quick brown fox jumps.');
		const m = marks(tree);
		expect(m.length).toBe(1);
		expect(m[0].properties).toEqual({ dataReviewId: 'a1' });
		expect(textContent(m[0])).toBe('quick brown');
	});

	it('spans element boundaries with multiple marks sharing the id', () => {
		// <p>The <strong>quick</strong> fox</p>, quote = "quick fox"
		const tree = root(el('p', text('The '), el('strong', text('quick')), text(' fox')));
		const matched = applyReviewHighlights(tree, [ann('a2', 'quick fox')]);

		expect(matched).toEqual(new Set(['a2']));
		const m = marks(tree);
		expect(m.length).toBe(2);
		expect(m.map(textContent)).toEqual(['quick', ' fox']);
		expect(m.every((x) => x.properties?.dataReviewId === 'a2')).toBe(true);
		expect(textContent(tree)).toBe('The quick fox');
	});

	it('targets the requested occurrence of a repeated quote', () => {
		const tree = root(el('p', text('foo bar foo')));
		applyReviewHighlights(tree, [ann('a3', 'foo', 1)]);

		const p = tree.children?.[0] as Node;
		expect(p.children?.map((c) => c.type)).toEqual(['text', 'element']);
		expect(textContent(p.children?.[0] as Node)).toBe('foo bar ');
		expect(textContent(marks(tree)[0])).toBe('foo');
	});

	it('matches across block boundaries through the newline separator nodes', () => {
		// mdast→hast trees separate blocks with "\n" text nodes in the root.
		const tree = root(el('p', text('Alpha end.')), text('\n'), el('p', text('Beta start.')));
		const matched = applyReviewHighlights(tree, [ann('a4', 'end.\nBeta')]);

		expect(matched).toEqual(new Set(['a4']));
		expect(marks(tree).map(textContent)).toEqual(['end.', '\n', 'Beta']);
	});

	it('leaves the tree untouched for an unmatched quote', () => {
		const tree = root(el('p', text('Nothing to see')));
		const matched = applyReviewHighlights(tree, [ann('a5', 'absent text')]);

		expect(matched.size).toBe(0);
		expect(marks(tree).length).toBe(0);
		const p = tree.children?.[0] as Node;
		expect(p.children?.length).toBe(1);
	});

	it('skips a later annotation overlapping an earlier claim', () => {
		const tree = root(el('p', text('one two three four')));
		const matched = applyReviewHighlights(tree, [
			ann('first', 'two three'),
			ann('second', 'three four'),
		]);

		expect(matched).toEqual(new Set(['first']));
		const m = marks(tree);
		expect(m.length).toBe(1);
		expect(textContent(m[0])).toBe('two three');
	});

	it('handles multiple disjoint annotations in one text node', () => {
		const tree = root(el('p', text('alpha beta gamma delta')));
		const matched = applyReviewHighlights(tree, [ann('x', 'alpha'), ann('y', 'gamma')]);

		expect(matched).toEqual(new Set(['x', 'y']));
		expect(marks(tree).map(textContent)).toEqual(['alpha', 'gamma']);
		expect(textContent(tree)).toBe('alpha beta gamma delta');
	});

	it('highlights inside list items', () => {
		const tree = root(el('ul', el('li', text('first item')), el('li', text('second item'))));
		applyReviewHighlights(tree, [ann('li1', 'second item')]);
		expect(marks(tree).map(textContent)).toEqual(['second item']);
	});

	// A GFM table's hast interleaves whitespace-only "\n" text nodes between its
	// structural elements (table/thead/tbody/tr). The browser never renders those
	// as text, so the DOM selection stream concatenates cells with no separator
	// ("RuleScope"); the highlight walk must skip them or a cross-cell quote can
	// never match its hast counterpart ("Rule\nScope"). These build a table shaped
	// like `mdast-util-to-hast` output to lock that in.
	const gfmTable = (rows: string[][], head: string[]) =>
		el(
			'table',
			text('\n'),
			el(
				'thead',
				text('\n'),
				el('tr', text('\n'), ...head.flatMap((h) => [el('th', text(h)), text('\n')])),
			),
			text('\n'),
			el(
				'tbody',
				text('\n'),
				...rows.flatMap((cells) => [
					el('tr', text('\n'), ...cells.flatMap((v) => [el('td', text(v)), text('\n')])),
					text('\n'),
				]),
			),
		);

	it('matches a quote spanning a table cell boundary, skipping the inter-cell whitespace', () => {
		// DOM renders the two header cells as adjacent text "RuleScope"; the quote
		// captured from such a selection must resolve despite the "\n" nodes in hast.
		const tree = root(gfmTable([['Never use X', 'All components']], ['Rule', 'Scope']));
		const matched = applyReviewHighlights(tree, [ann('t1', 'RuleScope')]);

		expect(matched).toEqual(new Set(['t1']));
		// One mark per cell, sharing the id (the boundary splits the run in two).
		expect(marks(tree).map(textContent)).toEqual(['Rule', 'Scope']);
	});

	it('matches a quote spanning a table row boundary', () => {
		// Selection dragged from the last cell of one row into the first of the next.
		const tree = root(
			gfmTable(
				[
					['Never use X', 'All components'],
					['Export static', 'utils/export.ts'],
				],
				['Rule', 'Scope'],
			),
		);
		const matched = applyReviewHighlights(tree, [ann('t2', 'All componentsExport static')]);

		expect(matched).toEqual(new Set(['t2']));
		expect(marks(tree).map(textContent)).toEqual(['All components', 'Export static']);
	});

	it('leaves the table whitespace nodes intact (matching only, no reflow)', () => {
		// Skipping the "\n" nodes from the match STREAM must not remove them from the
		// tree — the rendered table is unchanged, only anchoring is fixed.
		const tree = root(gfmTable([['a', 'b']], ['H1', 'H2']));
		const before = textContent(tree);
		applyReviewHighlights(tree, [ann('t3', 'H1H2')]);
		expect(textContent(tree)).toBe(before);
	});

	it('counts occurrences correctly across cells despite the whitespace nodes', () => {
		// "dup" appears in two separate cells; the phantom "\n" nodes must not shift
		// the occurrence count, so occurrence:1 still targets the SECOND cell.
		const tree = root(
			gfmTable(
				[
					['alpha dup', 'x'],
					['beta dup', 'y'],
				],
				['Key', 'Val'],
			),
		);
		applyReviewHighlights(tree, [ann('t4', 'dup', 1)]);

		const m = marks(tree);
		expect(m.length).toBe(1);
		expect(textContent(m[0])).toBe('dup');

		// The wrapped "dup" is the second one: the "beta dup" cell now holds the
		// mark, while the first cell ("alpha dup") is untouched.
		const cells: Node[] = [];
		const walkCells = (n: Node) => {
			if (n.tagName === 'td') cells.push(n);
			for (const c of n.children ?? []) walkCells(c);
		};
		walkCells(tree);
		const alpha = cells.find((c) => textContent(c) === 'alpha dup');
		const beta = cells.find((c) => textContent(c) === 'beta dup');
		expect(alpha?.children?.some((c) => c.tagName === 'mark')).toBe(false);
		expect(beta?.children?.some((c) => c.tagName === 'mark')).toBe(true);
	});
});

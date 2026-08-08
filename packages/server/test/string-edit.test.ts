import { describe, expect, it } from 'vitest';
import { applyStringEdit, buildEditHunk } from '../src/lib/string-edit';

const DOC = [
	'# Spec',
	'',
	'## Storage',
	'We use localStorage.',
	'',
	'## Routing',
	'Hash based.',
].join('\n');

describe('applyStringEdit', () => {
	it('replaces a unique span and leaves the rest untouched', () => {
		const r = applyStringEdit(DOC, 'We use localStorage.', 'We use IndexedDB.');
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(r.content).toContain('We use IndexedDB.');
		expect(r.content).not.toContain('localStorage');
		expect(r.content).toContain('## Routing');
		expect(r.replacements).toBe(1);
	});

	it('refuses an ambiguous anchor rather than silently editing the first match', () => {
		const text = 'alpha\nrepeat\nbeta\nrepeat\ngamma';
		const r = applyStringEdit(text, 'repeat', 'changed');
		expect(r.ok).toBe(false);
		if (r.ok) return;
		expect(r.error).toContain('matches 2 places');
		// The caller is told both ways out.
		expect(r.error).toContain('replace_all');
	});

	it('replaces every occurrence when replace_all is set', () => {
		const text = 'alpha\nrepeat\nbeta\nrepeat\ngamma';
		const r = applyStringEdit(text, 'repeat', 'changed', { replaceAll: true });
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(r.replacements).toBe(2);
		expect(r.content).toBe('alpha\nchanged\nbeta\nchanged\ngamma');
	});

	it('refuses an anchor that does not match, and points at whitespace when that is the cause', () => {
		const miss = applyStringEdit(DOC, 'We use Redis.', 'x');
		expect(miss.ok).toBe(false);
		if (miss.ok) return;
		expect(miss.error).toContain('not found');
		expect(miss.error).not.toContain('whitespace only');

		// Same text, but the caller padded it - the likeliest real-world miss.
		const padded = applyStringEdit(DOC, '  We use localStorage.  ', 'x');
		expect(padded.ok).toBe(false);
		if (padded.ok) return;
		expect(padded.error).toContain('whitespace only');
	});

	it('refuses an empty or no-op anchor', () => {
		const empty = applyStringEdit(DOC, '', 'x');
		expect(empty.ok).toBe(false);
		if (empty.ok) return;
		expect(empty.error).toContain('must not be empty');

		const noop = applyStringEdit(DOC, 'Hash based.', 'Hash based.');
		expect(noop.ok).toBe(false);
		if (noop.ok) return;
		expect(noop.error).toContain('identical');
	});

	it('deletes a span when new_string is empty', () => {
		const r = applyStringEdit(DOC, 'We use localStorage.', '');
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(r.content).not.toContain('localStorage');
	});

	it('returns a hunk showing the applied change in context', () => {
		const r = applyStringEdit(DOC, 'We use localStorage.', 'We use IndexedDB.');
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		// The changed line, with its numbered neighbours, so the caller can
		// confirm what landed without reading the record back.
		expect(r.hunk).toContain('We use IndexedDB.');
		expect(r.hunk).toContain('## Storage');
		expect(r.hunk).toMatch(/^\d+\t/m);
	});
});

describe('buildEditHunk', () => {
	it('caps a runaway hunk instead of returning the whole document', () => {
		const huge = Array.from({ length: 500 }, (_, i) => `line ${i} ${'x'.repeat(100)}`).join('\n');
		const hunk = buildEditHunk(huge, 0, huge.length);
		expect(hunk.length).toBeLessThan(huge.length);
		expect(hunk).toContain('hunk truncated');
	});

	it('clamps context at the start and end of the document', () => {
		const short = 'only line';
		expect(buildEditHunk(short, 0, short.length)).toBe('1\tonly line');
	});
});

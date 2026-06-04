import { reflowEnumerations } from '@hezo/web/lib/reflow-thinking-lists';
import { expect, test } from 'vitest';

// The real-world run-on thinking line the feature targets.
const EXAMPLE =
	'The user wants me to work on TO-2, which is a research task about client-side todo app ' +
	'approaches. I need to: 1. Investigate client-side storage options (localStorage, IndexedDB, ' +
	'etc.) 2. Survey existing open-source client-side todo implementations 3. Investigate ' +
	'offline-capable patterns (Service Workers, PWA) 4. Research UX patterns for anonymous-first, ' +
	'no-auth web apps 5. Produce a research.md report with findings and recommendations Let me ' +
	'start by doing web research and then compile finding…';

test('reflows the run-on example into a sequential markdown list', () => {
	const out = reflowEnumerations(EXAMPLE);
	// A blank line terminates the lead-in paragraph, then each item is line-leading.
	expect(out).toContain('I need to:\n\n1. Investigate client-side storage options');
	expect(out).toContain('\n2. Survey existing open-source');
	expect(out).toContain('\n3. Investigate offline-capable patterns');
	expect(out).toContain('\n4. Research UX patterns');
	expect(out).toContain('\n5. Produce a research.md report');
	// Trailing prose stays glued to the last item (no end-of-list delimiter exists).
	expect(out).toContain('recommendations Let me start by doing web research');
	// Exactly the 6 inserted newlines: `\n\n` before item 1 + one `\n` before items 2-5.
	expect((out.match(/\n/g) ?? []).length).toBe(6);
});

test('leaves hyphenated identifiers, filenames, decimals, and the lead-in text intact', () => {
	const out = reflowEnumerations(EXAMPLE);
	expect(out).toContain('TO-2');
	expect(out).toContain('research.md report');
	expect(out.startsWith('The user wants me to work on TO-2, which is a research task')).toBe(true);
});

test('reflows a simple numbered run', () => {
	expect(reflowEnumerations('Steps: 1. a 2. b 3. c')).toBe('Steps:\n\n1. a\n2. b\n3. c');
});

test('reflows markers using the `)` delimiter', () => {
	expect(reflowEnumerations('Order: 1) first 2) second')).toBe('Order:\n\n1) first\n2) second');
});

test('reflows repeated unicode bullets into a `-` list', () => {
	expect(reflowEnumerations('Options: • foo • bar')).toBe('Options:\n\n- foo\n- bar');
	expect(reflowEnumerations('Try ‣ one ‣ two ‣ three')).toBe('Try\n\n- one\n- two\n- three');
});

test('does not touch decimals', () => {
	const t = 'Pi is 3.14 and e is 2.71 in this note.';
	expect(reflowEnumerations(t)).toBe(t);
});

test('does not touch version numbers', () => {
	const t = 'Upgrade to v1.2 then maybe v1.3 later.';
	expect(reflowEnumerations(t)).toBe(t);
});

test('does not touch money amounts', () => {
	const t = 'It costs $1.50 today and $2.50 tomorrow.';
	expect(reflowEnumerations(t)).toBe(t);
});

test('does not touch hyphenated identifiers', () => {
	const t = 'Work on TO-2 and then PROJ-123 next.';
	expect(reflowEnumerations(t)).toBe(t);
});

test('does not treat `etc.` or filenames as markers', () => {
	const t = 'See research.md and notes.txt etc. for the details.';
	expect(reflowEnumerations(t)).toBe(t);
});

test('does not reflow a run that does not start at 1', () => {
	const t = 'Pick 2. apples then 3. pears from the bin.';
	expect(reflowEnumerations(t)).toBe(t);
});

test('does not reflow a lone marker', () => {
	const t = 'Step 1. do the only thing and stop.';
	expect(reflowEnumerations(t)).toBe(t);
});

test('does not reflow a single bullet', () => {
	const t = 'A note • with one inline glyph only.';
	expect(reflowEnumerations(t)).toBe(t);
});

test('is a no-op on plain prose', () => {
	const t = 'Just a normal sentence with no enumeration whatsoever.';
	expect(reflowEnumerations(t)).toBe(t);
});

test('is idempotent', () => {
	const once = reflowEnumerations(EXAMPLE);
	expect(reflowEnumerations(once)).toBe(once);
	// Already-newline-delimited markdown is left unchanged.
	const md = 'Steps:\n\n1. a\n2. b\n3. c';
	expect(reflowEnumerations(md)).toBe(md);
});

test('keeps `etc.` mid-item without splitting the item', () => {
	expect(reflowEnumerations('Need: 1. localStorage (etc.) 2. IndexedDB')).toBe(
		'Need:\n\n1. localStorage (etc.)\n2. IndexedDB',
	);
});

// Supplements reflow-thinking-lists.test.ts: drives firstSequentialRun's
// early-return branches — a qualifying run that is then interrupted by a fresh
// `1.` marker, and a qualifying run interrupted by an out-of-sequence marker.
import { reflowEnumerations } from '@hezo/web/lib/reflow-thinking-lists';
import { expect, test } from 'vitest';

test('returns the first qualifying run when a new "1." marker starts a second list', () => {
	// Markers: 1,2,3 (run of 3) then 1,2 (a second run). The first run qualifies
	// (>=2) and is returned the moment the second `1.` appears, so only items
	// 1-3 are reflowed; the trailing `1.`/`2.` stay inline.
	const input = 'First: 1. a 2. b 3. c then later 1. x 2. y';
	const out = reflowEnumerations(input);
	expect(out).toContain('First:\n\n1. a\n2. b\n3. c');
	// The second list's markers were NOT reflowed (no newline before them).
	expect(out).toContain('then later 1. x 2. y');
	expect(out).not.toContain('\n1. x');
});

test('returns the first qualifying run when an out-of-sequence marker interrupts it', () => {
	// 1,2 qualifies; the stray `7.` is neither sequential nor a restart, so the
	// already-qualifying run (length 2) is returned immediately.
	const input = 'Steps: 1. a 2. b but also 7. zzz extra';
	const out = reflowEnumerations(input);
	expect(out).toContain('Steps:\n\n1. a\n2. b');
	expect(out).toContain('but also 7. zzz extra');
	expect(out).not.toContain('\n7.');
});

test('a lone "1." marker followed by a fresh "1." restarts the run rather than returning', () => {
	// First `1.` builds run=[1] (length 1). The second `1.` hits the value===1
	// branch with run.length < 2, so it restarts the run instead of returning;
	// the `2.` then completes a qualifying [1,2] run that gets reflowed.
	const input = 'Note 1. discarded then 1. kept 2. also';
	const out = reflowEnumerations(input);
	expect(out).toContain('1. kept\n2. also');
	// The first, discarded `1.` was not reflowed.
	expect(out).toContain('Note 1. discarded then');
});

test('a non-qualifying partial run that restarts at 1 is discarded, not reflowed', () => {
	// `2.`,`3.` never start at 1 (run stays empty), then `1.`,`2.` form the real
	// run — only the latter is reflowed.
	const input = 'See 2. nope 3. nope then 1. real 2. list';
	const out = reflowEnumerations(input);
	expect(out).toContain('1. real\n2. list');
	expect(out).toContain('See 2. nope 3. nope');
});

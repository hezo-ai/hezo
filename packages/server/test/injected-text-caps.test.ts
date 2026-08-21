import { describe, expect, it } from 'vitest';
import {
	checkInjectedTextCap,
	INJECTED_TEXT_CAPS,
	type InjectedTextKind,
} from '../src/lib/injected-text-caps';

describe('injected-text caps', () => {
	const kinds = Object.keys(INJECTED_TEXT_CAPS) as InjectedTextKind[];

	it('passes content at exactly the limit', () => {
		for (const kind of kinds) {
			expect(checkInjectedTextCap(kind, 'x'.repeat(INJECTED_TEXT_CAPS[kind]))).toBeNull();
		}
	});

	it('refuses one character over, for every kind', () => {
		for (const kind of kinds) {
			const over = checkInjectedTextCap(kind, 'x'.repeat(INJECTED_TEXT_CAPS[kind] + 1));
			expect(over).not.toBeNull();
			expect(over?.limit).toBe(INJECTED_TEXT_CAPS[kind]);
			expect(over?.length).toBe(INJECTED_TEXT_CAPS[kind] + 1);
		}
	});

	// The caller is usually an agent, and a refusal it cannot act on is a loop.
	// Both numbers plus an instruction to consolidate make the retry a compaction
	// rather than a guess.
	it('names the ceiling, the actual size and the overage in the message', () => {
		const over = checkInjectedTextCap('team_preferences', 'x'.repeat(12_050));
		expect(over?.error).toContain('12050');
		expect(over?.error).toContain('12000');
		expect(over?.error).toContain('50');
		expect(over?.error).toMatch(/consolidate/i);
	});

	it('says which surface it is talking about', () => {
		expect(checkInjectedTextCap('team_preferences', 'x'.repeat(99_999))?.error).toContain(
			'Custom Prompt',
		);
		expect(checkInjectedTextCap('chat_memory', 'x'.repeat(99_999))?.error).toContain(
			'long-term chat memory',
		);
	});

	it('keeps every ceiling well under a context window', () => {
		// The point is instruction-following, not fitting: compliance degrades with
		// the number of stacked rules long before a window fills, so a generous cap
		// would buy nothing except a prompt nobody reads to the end.
		for (const kind of kinds) {
			expect(INJECTED_TEXT_CAPS[kind]).toBeLessThanOrEqual(40_000);
		}
	});
});

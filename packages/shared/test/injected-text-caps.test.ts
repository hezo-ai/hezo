import { describe, expect, it } from 'vitest';
import {
	checkInjectedTextCap,
	INJECTED_TEXT_CAPS,
	type InjectedTextKind,
} from '../src/documents/injected-text-caps.js';

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

	// The ceiling must bound growth without freezing what is already past it.
	// Provisioning writes these fields uncapped, and an instance upgrading onto this
	// release carries values written before the ceiling existed, so "already over"
	// is a state that legitimately exists and has to remain fixable.
	describe('content that is already over the ceiling', () => {
		const limit = INJECTED_TEXT_CAPS.agent_system_prompt;
		const current = limit + 5_000;

		it('accepts a write that is shorter than what it replaces, even while still over', () => {
			expect(
				checkInjectedTextCap('agent_system_prompt', 'x'.repeat(current - 1), current),
			).toBeNull();
			expect(
				checkInjectedTextCap('agent_system_prompt', 'x'.repeat(limit + 1), current),
			).toBeNull();
		});

		it('accepts the write that finally lands under the ceiling', () => {
			expect(checkInjectedTextCap('agent_system_prompt', 'x'.repeat(limit), current)).toBeNull();
		});

		it('refuses a write that is longer, the same size, or grows an under-limit value', () => {
			// Not `<=`: an edit that keeps it the same size makes no progress, and the
			// pressure to get back under the ceiling is the point of having one.
			expect(
				checkInjectedTextCap('agent_system_prompt', 'x'.repeat(current), current),
			).not.toBeNull();
			expect(
				checkInjectedTextCap('agent_system_prompt', 'x'.repeat(current + 1), current),
			).not.toBeNull();
			// A value that fits today cannot be pushed past the ceiling.
			expect(
				checkInjectedTextCap('agent_system_prompt', 'x'.repeat(current), limit - 1),
			).not.toBeNull();
		});

		it('says it can only be edited downwards, and names both sizes', () => {
			const refused = checkInjectedTextCap(
				'agent_system_prompt',
				'x'.repeat(current + 10),
				current,
			);
			expect(refused?.error).toContain(String(current));
			expect(refused?.error).toContain(String(current + 10));
			expect(refused?.error).toMatch(/only downwards/);
		});

		it('behaves identically without a current length, so an unwired caller still caps', () => {
			expect(checkInjectedTextCap('agent_system_prompt', 'x'.repeat(current))).not.toBeNull();
		});
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

// A cap is only real if every writer of that surface hits it. This pins the
// server-side enforcement points by name, because the batch tool and the admin
// REST route both wrote the same field and both originally skipped the check. It
// is a hand-kept list either way, so it lives beside the rules it is about.
describe('every writer of a capped surface is capped', () => {
	it('names an enforcement point for each kind in the table', () => {
		// This is the list that must grow when a row is added — an unwired row is
		// worse than no row, because the table then documents a ceiling nobody holds.
		// Every entry passes the length of the value it replaces. A site that
		// forgets still caps, but freezes anything provisioned over the ceiling.
		const enforced: Record<InjectedTextKind, string[]> = {
			team_preferences: ['services/custom-prompt.ts (REST + MCP share it)'],
			agent_system_prompt: [
				'mcp/tools.ts update_agent_system_prompt',
				'mcp/tools.ts update_agent_system_prompts (batch)',
				'routes/agents.ts PATCH agent (admin)',
			],
			chat_memory: ['services/chat-memory.ts (REST + MCP share it)'],
			task_progress_summary: ['mcp/tools.ts update_task'],
			agent_team_context: [
				'mcp/tools.ts set_agent_team_context',
				'mcp/tools.ts set_agent_team_contexts (batch)',
			],
		};
		for (const kind of Object.keys(INJECTED_TEXT_CAPS) as InjectedTextKind[]) {
			expect(enforced[kind]?.length ?? 0).toBeGreaterThan(0);
		}
	});
});

// The invariant this whole area rests on: an assembled run prompt is bounded no
// matter what any one task field holds.
//
// Two production failures made this necessary and they had different shapes. One
// run was woken by a mention and carried the same half-megabyte comment twice -
// once quoted in the handoff, once in the thread block. The other had no handoff
// at all and still blew its CLI's input ceiling on three thread rows alone. So a
// test that only pins the de-duplication would have passed while the second
// failure stayed reachable, and a test that only pins one section's ceiling
// misses that the sections sum. These assert the total.

import { AgentRuntime, RUNTIME_PROMPT_MAX_CHARS } from '@hezo/shared';
import { describe, expect, it } from 'vitest';
import {
	assertPromptAcceptable,
	buildTaskPrompt,
	type RenderableComment,
	renderCommentHistory,
	type TaskInfo,
} from '../src/services/agent-runner';
import {
	PROMPT_BUDGET_CHARS,
	PROMPT_SECTION_CEILINGS,
	PromptBudget,
} from '../src/services/prompt-budget';

const HUGE = 500_000;

function makeTask(overrides: Partial<TaskInfo> = {}): TaskInfo {
	return {
		id: 'task-uuid',
		identifier: 'INV-234',
		title: 'Weekly screening round',
		description: 'D'.repeat(HUGE),
		status: 'in_progress',
		priority: 'medium',
		project_id: 'project-uuid',
		rules: 'R'.repeat(HUGE),
		progress_summary: 'P'.repeat(HUGE),
		...overrides,
	} as TaskInfo;
}

function makeComment(id: string, chars: number): RenderableComment {
	return {
		id,
		content_type: 'text',
		content: { text: 'C'.repeat(chars) },
		author_name: 'Market Researcher',
		created_at: '2026-09-09 08:10:43',
		reactions: undefined,
		attachments: [],
	};
}

/** Everything the prompt carries beyond the system half it was handed. */
function taskHalf(prompt: string, systemPrompt: string): string {
	return prompt.slice(systemPrompt.length);
}

describe('PromptBudget', () => {
	it('spends down and never hands out more than it has left', () => {
		const budget = new PromptBudget(1_000);
		const first = budget.take('taskDescription', 'x'.repeat(800));
		const second = budget.take('taskDescription', 'y'.repeat(800));
		expect(first.text.length).toBe(800);
		expect(second.text.length).toBeLessThanOrEqual(200);
		expect(budget.left).toBe(0);
		// A third section on an exhausted budget renders nothing rather than throwing:
		// an over-long task must still produce a prompt.
		expect(budget.take('taskRules', 'z'.repeat(100)).text).toBe('');
	});

	it('caps a section at its own ceiling even with budget to spare', () => {
		const budget = new PromptBudget(PROMPT_BUDGET_CHARS);
		const cut = budget.take('recentComment', 'x'.repeat(HUGE));
		expect(cut.text.length).toBeLessThanOrEqual(PROMPT_SECTION_CEILINGS.recentComment);
		expect(cut.truncated).toBe(true);
		// The ceiling is what shapes a normal prompt; the budget is what stops the
		// sections summing past it. Without the ceiling the first section would eat
		// the lot and every later one would render empty.
		expect(budget.left).toBeGreaterThan(PROMPT_BUDGET_CHARS / 2);
	});

	it('reports the source length, not the cut length, so a reader can decide not to page', () => {
		const budget = new PromptBudget();
		const cut = budget.take('recentComment', 'x'.repeat(HUGE));
		expect(cut.length).toBe(HUGE);
	});

	it('never claims a squeezed-out section is absent — that fact is not the same fact', () => {
		// An exhausted budget and an unset field render identically unless this is
		// right, and "No description provided." about a real description is a lie
		// the agent plans around.
		const prompt = buildTaskPrompt(
			'SYS',
			makeTask({ description: 'D'.repeat(HUGE), rules: null, progress_summary: null }),
			{ source: 'mention', comment_id: 'c1' },
			{
				mentionContext: {
					authorName: 'A',
					// Wide enough to leave the description nothing to spend.
					excerpt: 'M'.repeat(HUGE),
					openTickets: [],
					triggeringCommentId: 'c1',
				},
				recentComments: [makeComment('c1', HUGE), makeComment('c2', HUGE)],
			},
		);
		expect(prompt).not.toContain('No description provided.');
		expect(prompt).toMatch(/of 500000 characters - read the rest with/);
	});

	it('leaves a short section its slack for the next one', () => {
		const budget = new PromptBudget(PROMPT_BUDGET_CHARS);
		budget.take('taskDescription', 'short');
		expect(budget.left).toBe(PROMPT_BUDGET_CHARS - 'short'.length);
	});
});

describe('renderCommentHistory', () => {
	it('bounds row width, not just row count', () => {
		const budget = new PromptBudget();
		const out = renderCommentHistory([makeComment('c1', HUGE), makeComment('c2', HUGE)], {
			budget,
			section: 'recentComment',
		});
		expect(out.length).toBeLessThan(PROMPT_BUDGET_CHARS);
		// Each cut row names its true size and the call that serves the rest, so the
		// bound is a size hint rather than a silent drop.
		expect(out).toContain(`of ${HUGE} characters`);
		expect(out).toContain('get_comment(comment_id: "c1")');
		expect(out).toContain('get_comment(comment_id: "c2")');
	});

	it('back-references a body a handoff already quoted instead of repeating it', () => {
		const budget = new PromptBudget();
		const out = renderCommentHistory([makeComment('c1', 4_000)], {
			budget,
			section: 'recentComment',
			shownAbove: new Set(['c1']),
			wakingCommentId: 'c1',
		});
		expect(out).toContain('quoted in full above');
		expect(out).toContain('← the comment that woke you');
		expect(out).not.toContain('CCCC');
		// Nothing was spent, because nothing was rendered.
		expect(budget.left).toBe(PROMPT_BUDGET_CHARS);
	});
});

describe('buildTaskPrompt stays inside the budget', () => {
	const systemPrompt = 'SYS';

	it('bounds a task whose every field is pathological', () => {
		const prompt = buildTaskPrompt(systemPrompt, makeTask(), undefined, {
			recentComments: [makeComment('c1', HUGE), makeComment('c2', HUGE), makeComment('c3', HUGE)],
		});
		expect(taskHalf(prompt, systemPrompt).length).toBeLessThan(PROMPT_BUDGET_CHARS * 2);
	});

	it('bounds the mention wake that failed in production, and quotes the comment once', () => {
		const prompt = buildTaskPrompt(
			systemPrompt,
			makeTask(),
			{ source: 'mention', comment_id: 'c1' },
			{
				mentionContext: {
					authorName: 'Market Researcher',
					excerpt: 'M'.repeat(HUGE),
					openTickets: [],
					triggeringCommentId: 'c1',
				},
				recentComments: [makeComment('c1', HUGE), makeComment('c2', HUGE)],
				wakingCommentId: 'c1',
			},
		);
		expect(taskHalf(prompt, systemPrompt).length).toBeLessThan(PROMPT_BUDGET_CHARS * 2);
		expect(prompt).toContain('quoted in full above');
		// The handoff quote survives; it is the instruction this run was woken for.
		expect(prompt).toContain('MMMM');
	});

	it('bounds a reply wake, which carries two bodies the thread block may not hold', () => {
		const prompt = buildTaskPrompt(
			systemPrompt,
			makeTask(),
			{ source: 'reply', comment_id: 'reply-1' },
			{
				replyContext: {
					responderName: 'Risk Verifier',
					responderSlug: 'risk-verifier',
					replyExcerpt: 'A'.repeat(HUGE),
					originalExcerpt: 'B'.repeat(HUGE),
					replyCommentId: 'reply-1',
					originalCommentId: 'orig-1',
					referencedTasks: [],
				},
				recentComments: [makeComment('c1', HUGE), makeComment('c2', HUGE)],
			},
		);
		expect(taskHalf(prompt, systemPrompt).length).toBeLessThan(PROMPT_BUDGET_CHARS * 2);
		// Both ids reach the prompt: without them the overflow line names a
		// get_comment the agent has no argument for.
		expect(prompt).toContain('reply-1');
		expect(prompt).toContain('orig-1');
	});

	it('leaves a normal task untouched', () => {
		const prompt = buildTaskPrompt(
			systemPrompt,
			makeTask({
				description: 'A short brief.',
				rules: 'Be careful.',
				progress_summary: 'Halfway.',
			}),
			undefined,
			{ recentComments: [makeComment('c1', 200)] },
		);
		expect(prompt).toContain('A short brief.');
		expect(prompt).toContain('Be careful.');
		expect(prompt).toContain('Halfway.');
		expect(prompt).toContain('C'.repeat(200));
		expect(prompt).not.toContain('read the rest with');
	});
});

describe('assertPromptAcceptable', () => {
	const codexCap = RUNTIME_PROMPT_MAX_CHARS[AgentRuntime.Codex] as number;

	it('refuses a prompt over the runtime input ceiling, naming the runtime and the numbers', () => {
		expect(() => assertPromptAcceptable(AgentRuntime.Codex, 'x'.repeat(codexCap + 1))).toThrow(
			/Codex/,
		);
		expect(() => assertPromptAcceptable(AgentRuntime.Codex, 'x'.repeat(codexCap + 1))).toThrow(
			new RegExp(String(codexCap)),
		);
	});

	it('accepts a prompt at the ceiling', () => {
		expect(() => assertPromptAcceptable(AgentRuntime.Codex, 'x'.repeat(codexCap))).not.toThrow();
	});

	it('lets a runtime with no published ceiling through', () => {
		expect(() =>
			assertPromptAcceptable(AgentRuntime.ClaudeCode, 'x'.repeat(codexCap * 2)),
		).not.toThrow();
	});

	it('never fires on a budgeted prompt - the backstop is not the bound', () => {
		const prompt = buildTaskPrompt('S'.repeat(150_000), makeTask(), undefined, {
			recentComments: [makeComment('c1', HUGE), makeComment('c2', HUGE), makeComment('c3', HUGE)],
		});
		for (const runtime of Object.values(AgentRuntime)) {
			if (RUNTIME_PROMPT_MAX_CHARS[runtime] === null) continue;
			expect(() => assertPromptAcceptable(runtime, prompt)).not.toThrow();
		}
	});
});

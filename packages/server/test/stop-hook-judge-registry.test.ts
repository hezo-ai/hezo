import { AgentRuntime, AiProvider } from '@hezo/shared';
import { describe, expect, it } from 'vitest';
import {
	buildClaudeCodeSettings,
	buildCodexJudgeScript,
	buildGeminiJudgeScript,
	buildJudgeScriptForRuntime,
	STOP_HOOK_JUDGE_MODEL_KIMI,
	STOP_HOOK_PROMPT,
	STOP_HOOK_RULES,
} from '../src/services/stop-hook-prompt';

/**
 * A2 refactor: the Codex/Gemini judge scripts now come from a JUDGE_SPECS
 * registry behind buildJudgeScriptForRuntime. These assert the registry path
 * produces byte-identical output to the original named builders (parity), and
 * that the runtime with no command-script judge resolves to null.
 */
describe('stop-hook judge spec registry', () => {
	it('Codex runtime builds the same script as buildCodexJudgeScript', () => {
		expect(buildJudgeScriptForRuntime(AgentRuntime.Codex)).toBe(buildCodexJudgeScript());
	});

	it('Gemini runtime builds the same script as buildGeminiJudgeScript', () => {
		expect(buildJudgeScriptForRuntime(AgentRuntime.Gemini)).toBe(buildGeminiJudgeScript());
	});

	it('Claude Code has no command-script judge (uses the native prompt hook)', () => {
		expect(buildJudgeScriptForRuntime(AgentRuntime.ClaudeCode)).toBeNull();
	});

	it('Codex and Gemini scripts target their respective upstreams', () => {
		expect(buildJudgeScriptForRuntime(AgentRuntime.Codex)).toContain(
			'api.openai.com/v1/chat/completions',
		);
		expect(buildJudgeScriptForRuntime(AgentRuntime.Gemini)).toContain(
			'generativelanguage.googleapis.com',
		);
	});

	it('Kimi judges via the native Claude Code prompt hook with the Moonshot model', () => {
		// Kimi runs on Claude Code (no command script), so it resolves to null in the
		// registry and judges via buildClaudeCodeSettings with Moonshot's own model.
		expect(buildJudgeScriptForRuntime(AgentRuntime.ClaudeCode)).toBeNull();
		expect(STOP_HOOK_JUDGE_MODEL_KIMI).toBe('kimi-k2.7-code');
		expect(buildClaudeCodeSettings(AiProvider.Kimi).hooks.Stop[0].hooks[0].model).toBe(
			STOP_HOOK_JUDGE_MODEL_KIMI,
		);
	});
});

/**
 * A ticket that pauses because it is waiting on another ticket must declare the
 * dependency with add_task_blocker — a prose "waiting on X" note creates no edge
 * and strands the work. The judge rule that enforces this is shared verbatim
 * across every runtime's judge, so a single rule edit must reach all of them.
 */
describe('stop-hook rules require add_task_blocker for cross-ticket waits', () => {
	it('the rules block prose-only waits and require add_task_blocker', () => {
		expect(STOP_HOOK_RULES).toContain('add_task_blocker');
		expect(STOP_HOOK_RULES).toContain('waiting on');
		// The closing allow-clause must NOT treat waiting on another ticket as
		// "waiting on input" — that loophole is what stranded the downstream ticket.
		expect(STOP_HOOK_RULES).toContain(
			"Waiting on ANOTHER TICKET's completion does NOT count as waiting on input",
		);
	});

	it("blocks offloading the ticket's own deliverable into a sub-task or separate ticket", () => {
		// A defect in the work THIS ticket is producing is its own remaining work,
		// not separable follow-up — it cannot be deferred via create_task.
		expect(STOP_HOOK_RULES).toContain("part of THIS ticket's own deliverable");
		expect(STOP_HOOK_RULES).toContain('never for fixing this ticket');
	});

	it('blocks marking done while the agent awaits an answer to its own outbound ask', () => {
		// The incident shape: close the task, then post the @admin question — or
		// close with the question already open. Both are the same failure; a task
		// waiting on an answer stays non-terminal.
		expect(STOP_HOOK_RULES).toContain('OWN outbound question is still awaiting an answer');
		expect(STOP_HOOK_RULES).toContain(
			'closing the task and then posting the question is the same failure',
		);
		// The allow-clause blesses waiting on @admin ONLY with the task non-terminal.
		expect(STOP_HOOK_RULES).toContain(
			'The same wait with the task set to done or cancelled is NOT a valid stop',
		);
	});

	it('the Claude Code prompt hook embeds the rule', () => {
		expect(STOP_HOOK_PROMPT).toContain('add_task_blocker');
		expect(buildClaudeCodeSettings(AiProvider.Anthropic).hooks.Stop[0].hooks[0].prompt).toContain(
			'add_task_blocker',
		);
	});

	it('every command-script judge embeds the same rule', () => {
		expect(buildJudgeScriptForRuntime(AgentRuntime.Codex)).toContain('add_task_blocker');
		expect(buildJudgeScriptForRuntime(AgentRuntime.Gemini)).toContain('add_task_blocker');
	});
});

/**
 * An agent that announced a plan in the thread ("I will delegate…", "once this
 * decision lands I'll update X and Y") must not stop after silently doing less —
 * rule 9 blocks the silent scope reduction while accepting an explicit
 * reconciling wrap-up. Shared verbatim across every runtime's judge.
 */
describe('stop-hook rules block announced-plan abandonment', () => {
	it('blocks closing with an announced plan neither executed nor revised', () => {
		expect(STOP_HOOK_RULES).toContain('announced a plan or next step on this ticket');
		expect(STOP_HOOK_RULES).toContain('silent scope reduction');
		expect(STOP_HOOK_RULES).toContain('explicitly revising or retracting the plan');
	});

	it('targets explicit self-commitments, not options the agent merely discussed', () => {
		expect(STOP_HOOK_RULES).toContain('explicit self-commitments only');
		expect(STOP_HOOK_RULES).toContain('without committing do NOT count');
	});

	it('an explicit reconciling wrap-up satisfies the rule', () => {
		expect(STOP_HOOK_RULES).toContain('fully satisfies this rule');
		expect(STOP_HOOK_RULES).toContain('never for legitimately revising scope in the thread');
	});

	it('report_no_work carve-out spans rules 1-10', () => {
		expect(STOP_HOOK_RULES).toContain('block rules 1-10');
		expect(STOP_HOOK_RULES).not.toContain('block rules 1-9');
	});

	it('every runtime judge embeds the rule', () => {
		expect(STOP_HOOK_PROMPT).toContain('silent scope reduction');
		expect(buildClaudeCodeSettings(AiProvider.Anthropic).hooks.Stop[0].hooks[0].prompt).toContain(
			'silent scope reduction',
		);
		expect(buildJudgeScriptForRuntime(AgentRuntime.Codex)).toContain('silent scope reduction');
		expect(buildJudgeScriptForRuntime(AgentRuntime.Gemini)).toContain('silent scope reduction');
	});
});

/**
 * A run's final assistant message is delivered to no one — it is not a comment,
 * mentions in it are never parsed, and no wake fires. Rule 10 blocks the stop
 * when the final message is itself the handoff (an active @-mention or
 * baton-passing address) that was never posted via create_comment, so the
 * handoff cannot strand with both sides waiting. Shared verbatim across every
 * runtime's judge.
 */
describe('stop-hook rules block handoffs left only in the final message', () => {
	it('blocks a final-message handoff never posted as a comment', () => {
		expect(STOP_HOOK_RULES).toContain('never posted to the task thread as a comment');
		expect(STOP_HOOK_RULES).toContain('delivered to NO ONE');
		expect(STOP_HOOK_RULES).toContain('exists only in the final message');
	});

	it('accepts a message that reports an already-posted comment or mentions passively', () => {
		expect(STOP_HOOK_RULES).toContain('REPORTS an already-posted comment');
		expect(STOP_HOOK_RULES).toContain('names teammates passively');
	});

	it('the block reason routes the agent to create_comment without duplicate reposts', () => {
		expect(STOP_HOOK_RULES).toContain('post the handoff as a create_comment on the current task');
		expect(STOP_HOOK_RULES).toContain('end the turn without reposting');
	});

	it('every runtime judge embeds the rule', () => {
		expect(STOP_HOOK_PROMPT).toContain('delivered to NO ONE');
		expect(buildClaudeCodeSettings(AiProvider.Anthropic).hooks.Stop[0].hooks[0].prompt).toContain(
			'delivered to NO ONE',
		);
		expect(buildJudgeScriptForRuntime(AgentRuntime.Codex)).toContain('delivered to NO ONE');
		expect(buildJudgeScriptForRuntime(AgentRuntime.Gemini)).toContain('delivered to NO ONE');
	});
});

/**
 * B2: each command-hook judge must emit the decision value that actually makes
 * ITS runtime continue the agent, and must not loop the agent indefinitely.
 * Codex's `Stop` hook continues on `block`; Gemini's `AfterAgent` hook continues
 * on `deny` and ignores `block`, so emitting `block` there is a silent no-op.
 */
describe('stop-hook command judges emit the runtime-correct decision and guard the loop', () => {
	it('Codex emits decision "block" (its Stop-hook continuation value)', () => {
		expect(buildCodexJudgeScript()).toContain('decision: "block"');
	});

	it('Gemini emits decision "deny" (AfterAgent ignores "block")', () => {
		const script = buildGeminiJudgeScript();
		expect(script).toContain('decision: "deny"');
		expect(script).not.toContain('decision: "block"');
	});

	it('both short-circuit once already continued (stop_hook_active) so the judge cannot loop', () => {
		for (const script of [buildCodexJudgeScript(), buildGeminiJudgeScript()]) {
			expect(script).toContain('stop_hook_active');
		}
	});
});

import { AgentRuntime, AiProvider, KIMI_DEFAULT_MODEL } from '@hezo/shared';
import { describe, expect, it } from 'vitest';
import {
	buildClaudeCodeSettings,
	buildCodexJudgeScript,
	buildGeminiJudgeScript,
	buildJudgeScriptForRuntime,
	judgeModelForProvider,
	STOP_HOOK_JUDGE_MODEL_ANTHROPIC,
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
		expect(STOP_HOOK_JUDGE_MODEL_KIMI).toBe(KIMI_DEFAULT_MODEL);
		// No explicit run model → falls back to the per-provider constant.
		expect(buildClaudeCodeSettings(AiProvider.Kimi).hooks.Stop[0].hooks[0].model).toBe(
			STOP_HOOK_JUDGE_MODEL_KIMI,
		);
	});
});

/**
 * The judge for a third-party Anthropic-compatible provider must be a model that
 * provider's endpoint actually serves. Tracking the run's own selected model
 * means a provider upgrade (Kimi k2.7-code → k3) needs no code change, while the
 * per-provider constant stays the fallback when the run pins no model. Anthropic
 * is excluded — its cheaper Sonnet judge must not scale with the run model.
 */
describe('judgeModelForProvider derives the judge from the run model', () => {
	it('uses the selected model for third-party Claude Code providers (Kimi k3)', () => {
		expect(judgeModelForProvider(AiProvider.Kimi, 'k3')).toBe('k3');
		expect(judgeModelForProvider(AiProvider.Kimi, 'kimi-k3')).toBe('kimi-k3');
		expect(judgeModelForProvider(AiProvider.ZAi, 'GLM-5')).toBe('GLM-5');
	});

	it('normalizes the DeepSeek [1m] suffix the endpoint would reject', () => {
		expect(judgeModelForProvider(AiProvider.DeepSeek, 'deepseek-v5-pro[1m]')).toBe(
			'deepseek-v5-pro',
		);
	});

	it('falls back to the per-provider constant when no run model is selected', () => {
		expect(judgeModelForProvider(AiProvider.Kimi, null)).toBe(STOP_HOOK_JUDGE_MODEL_KIMI);
		expect(judgeModelForProvider(AiProvider.Kimi, '   ')).toBe(STOP_HOOK_JUDGE_MODEL_KIMI);
		expect(judgeModelForProvider(AiProvider.Kimi, undefined)).toBe(STOP_HOOK_JUDGE_MODEL_KIMI);
	});

	it('never derives for Anthropic — its stable Sonnet judge must not scale with the run model', () => {
		expect(judgeModelForProvider(AiProvider.Anthropic, 'claude-opus-4-8')).toBe(
			STOP_HOOK_JUDGE_MODEL_ANTHROPIC,
		);
		// And the settings a run writes reflect the derived model end-to-end.
		expect(buildClaudeCodeSettings(AiProvider.Kimi, 'k3').hooks.Stop[0].hooks[0].model).toBe('k3');
		expect(
			buildClaudeCodeSettings(AiProvider.Anthropic, 'claude-opus-4-8').hooks.Stop[0].hooks[0].model,
		).toBe(STOP_HOOK_JUDGE_MODEL_ANTHROPIC);
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

	it('report_no_work carve-out spans rules 1-13', () => {
		expect(STOP_HOOK_RULES).toContain('block rules 1-13');
		expect(STOP_HOOK_RULES).not.toContain('block rules 1-11');
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

	it('treats an unposted final-message handoff as undelivered and blocks by default', () => {
		// The incident: a stative "@admin — … is presented for your final approval" read as a
		// report and was ALLOWED. The final-message-only branch now blocks by default instead.
		expect(STOP_HOOK_RULES).toContain('UNDELIVERED handoff — BLOCK by default');
	});

	it('exempts only an explicit already-posted claim, not report-like readiness phrasing', () => {
		// A stative description of the work's readiness ("is presented for your final approval")
		// no longer earns an exemption — only a first-person claim of the create_comment itself.
		expect(STOP_HOOK_RULES).toContain('EXPLICITLY states the same handoff was already posted');
		expect(STOP_HOOK_RULES).toContain('must still be blocked');
	});

	it('does not exempt a handoff merely because it is spelled passively', () => {
		// The @@<slug> spelling used to be a blanket exemption ("notifies no one by
		// design"), which made the judge structurally blind to the incident it most
		// needed to catch: a passively-addressed ask ("@@equity-analyst — please mark
		// INV-86 done.") hands over the next action and wakes nobody, exactly like a
		// bare name. The exemption is now about who acts next, not how it is spelled.
		expect(STOP_HOOK_RULES).toContain('NOT itself an exemption');
		expect(STOP_HOOK_RULES).toContain('who is expected to act next on this ticket?');
		expect(STOP_HOOK_RULES).not.toContain('written passively (@@<slug>), which notifies no one');
	});

	it('blocks a stative sign-off recap that names an approver but posts no @-mention', () => {
		// The screenshot incident: "the ticket stays in review awaiting Captain sign-off"
		// left the ticket non-terminal (so rule 11 never fires) and @-mentioned no one.
		// Rule 10 now blocks that stative recap by treating the named approver as the
		// next actor, whether the ticket is left non-terminal or marked terminal.
		expect(STOP_HOOK_RULES).toContain('STATIVE sign-off recap counts the same');
		expect(STOP_HOOK_RULES).toContain('awaiting Captain sign-off');
		expect(STOP_HOOK_RULES).toContain('Treat the named approver as the next actor and block');
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
 * The incident shape: a ticket's flow required a final approval (the admin's
 * sign-off) that the thread established across earlier runs, but a reviewer marked
 * it done on the strength of its OWN review after a rework/detour — forgetting the
 * inherited approval was never granted. Rule 11 blocks closing on an approval
 * requirement inherited from the thread (distinct from rule 7's own-outbound-ask),
 * and the allow-clause blesses waiting on a posted approval ask with the ticket
 * non-terminal. Shared verbatim across every runtime's judge.
 */
describe('stop-hook rules block closing while an inherited approval is still owed', () => {
	it("blocks closing on the agent's own review when a higher/final sign-off is ungranted", () => {
		expect(STOP_HOOK_RULES).toContain('approval requirement INHERITED from the thread');
		expect(STOP_HOOK_RULES).toContain("A reviewer's own pass");
		expect(STOP_HOOK_RULES).toContain('silently short-circuits the approval chain');
	});

	it("distinguishes rule 11 from rule 7's own-outbound-ask", () => {
		expect(STOP_HOOK_RULES).toContain('DISTINCT from rule 7');
		expect(STOP_HOOK_RULES).toContain('stated by ANY participant');
	});

	it('a rework/detour cycle does not discharge a pending approval', () => {
		expect(STOP_HOOK_RULES).toContain('does NOT discharge a pending approval');
	});

	it('the block reason routes the agent to a live @-mention approval ask, ticket non-terminal', () => {
		expect(STOP_HOOK_RULES).toContain('post the outstanding approval as a live @-mention ask');
		expect(STOP_HOOK_RULES).toContain(
			'may become done only after the required approval actually lands',
		);
	});

	it('the allow-clause blesses a correctly-posted approval wait as a valid stop', () => {
		expect(STOP_HOOK_RULES).toContain(
			"Waiting on an approval or sign-off the ticket's flow requires",
		);
	});

	it('every runtime judge embeds the rule', () => {
		expect(STOP_HOOK_PROMPT).toContain('approval requirement INHERITED from the thread');
		expect(buildClaudeCodeSettings(AiProvider.Anthropic).hooks.Stop[0].hooks[0].prompt).toContain(
			'approval requirement INHERITED from the thread',
		);
		expect(buildJudgeScriptForRuntime(AgentRuntime.Codex)).toContain(
			'approval requirement INHERITED from the thread',
		);
		expect(buildJudgeScriptForRuntime(AgentRuntime.Gemini)).toContain(
			'approval requirement INHERITED from the thread',
		);
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

	it('the Claude Code prompt hook short-circuits on stop_hook_active too (loop parity)', () => {
		// The native type:"prompt" Stop hook receives the full input JSON via $ARGUMENTS
		// (including stop_hook_active); the loop breaker tells the judge to allow the stop
		// once the turn was already continued, matching the command-script guard so a
		// persistent verdict cannot spin the same headless exec indefinitely.
		expect(STOP_HOOK_PROMPT).toContain('stop_hook_active');
		expect(buildClaudeCodeSettings(AiProvider.Anthropic).hooks.Stop[0].hooks[0].prompt).toContain(
			'stop_hook_active',
		);
	});

	it('the Claude Code prompt hook points the judge at the last_assistant_message field', () => {
		// $ARGUMENTS is the raw Stop-hook input JSON, whose `last_assistant_message`
		// field carries the agent's final message. The prompt names that field
		// explicitly so a weaker judge model (e.g. DeepSeek judging itself) evaluates
		// the message text — the input rule 10 turns on — rather than the surrounding
		// metadata blob.
		expect(STOP_HOOK_PROMPT).toContain('last_assistant_message');
		expect(buildClaudeCodeSettings(AiProvider.DeepSeek).hooks.Stop[0].hooks[0].prompt).toContain(
			'last_assistant_message',
		);
	});
});

/**
 * A ticket parked on a pending admin approval it filed (e.g. a hire proposal via
 * create_hire_proposal) is a legitimate "waiting on input" stop — the admin's resolution
 * auto-wakes the requester exactly as an @admin reply does. The judge must not treat
 * re-evaluating such a task and calling report_no_work (while the approval stays pending)
 * as an unresolved problem, or it spins the agent. The clause lives in STOP_HOOK_RULES so
 * it is shared verbatim across every runtime's judge.
 */
describe('stop-hook rules bless waiting on a pending admin approval', () => {
	it('a filed approval pending an admin decision, task non-terminal, is a valid wait', () => {
		expect(STOP_HOOK_RULES).toContain('awaits an admin decision the agent cannot make itself');
		expect(STOP_HOOK_RULES).toContain('create_hire_proposal');
		// report_no_work while the approval stays pending must NOT read as rule 5 / rule 7.
		expect(STOP_HOOK_RULES).toContain('while the approval is still pending is a valid stop');
		// The non-terminal guard from the @admin case still applies to the approval wait.
		expect(STOP_HOOK_RULES).toContain(
			'The same wait with the task set to done or cancelled is NOT a valid stop',
		);
	});

	it('the carve-out reaches every runtime judge', () => {
		expect(STOP_HOOK_PROMPT).toContain('create_hire_proposal');
		expect(buildClaudeCodeSettings(AiProvider.Anthropic).hooks.Stop[0].hooks[0].prompt).toContain(
			'create_hire_proposal',
		);
		expect(buildJudgeScriptForRuntime(AgentRuntime.Codex)).toContain('create_hire_proposal');
		expect(buildJudgeScriptForRuntime(AgentRuntime.Gemini)).toContain('create_hire_proposal');
	});
});

/**
 * Rule 12. The incident: a Captain woken by a teammate's `@captain` review request
 * did the whole review, wrote its PASS verdict, and ended the run with that verdict
 * only in its final message. Rule 10 did not reach it — the message named nobody and
 * passed no baton, so it is not shaped like a handoff — and the ticket sat in `review`
 * with nobody woken. Rule 12 covers the reply itself, whatever shape it takes.
 */
describe('stop-hook rules block a reply left only in the final message', () => {
	it('blocks an answer to an ask that was never posted as a comment', () => {
		expect(STOP_HOOK_RULES).toContain('woken by someone ASKING this agent for something');
		expect(STOP_HOOK_RULES).toContain('Doing the work is NOT the deliverable on its own');
	});

	it('is scoped so it does not collapse into rule 10', () => {
		expect(STOP_HOOK_RULES).toContain('a reply that names nobody and passes no baton');
		// Answering the asker needs no mention — the reply reaches them — so the rule
		// must not push agents into spraying @-mentions on routine answers.
		expect(STOP_HOOK_RULES).toContain('it does not need an @-mention if it is simply answering');
	});

	it('reaches every runtime judge', () => {
		const needle = 'woken by someone ASKING this agent for something';
		expect(STOP_HOOK_PROMPT).toContain(needle);
		expect(buildClaudeCodeSettings(AiProvider.Anthropic).hooks.Stop[0].hooks[0].prompt).toContain(
			needle,
		);
		expect(buildJudgeScriptForRuntime(AgentRuntime.Codex)).toContain(needle);
		expect(buildJudgeScriptForRuntime(AgentRuntime.Gemini)).toContain(needle);
	});
});

/**
 * Rule 13. The same run noticed the IBKR MCP connector's OAuth grant had expired and
 * filed it as a "Known gap (already acknowledged)" pointing at another ticket. Nothing
 * reached a human who could reconnect it, so every later run kept producing degraded
 * output. Rule 6 does not reach this — it covers an agent that never had a credential,
 * not one whose working integration broke.
 */
describe('stop-hook rules block an unescalated broken integration', () => {
	it('blocks stopping without escalating a broken connector', () => {
		expect(STOP_HOOK_RULES).toContain('an integration the work depends on is BROKEN');
		expect(STOP_HOOK_RULES).toContain('is NOT escalation');
	});

	it('names the acceptable resolutions and rejects the known-gap dodge', () => {
		expect(STOP_HOOK_RULES).toContain(
			'active @admin comment on the current ticket naming the connector',
		);
		expect(STOP_HOOK_RULES).toContain(
			'request_credential call where a pasted value is what fixes it',
		);
		// Working around it is fine; going quiet about it is not.
		expect(STOP_HOOK_RULES).toContain('does not discharge the escalation');
	});

	it('is distinguished from rule 6', () => {
		expect(STOP_HOOK_RULES).toContain('covers one that WAS working and has stopped working');
	});

	it('reaches every runtime judge', () => {
		const needle = 'an integration the work depends on is BROKEN';
		expect(STOP_HOOK_PROMPT).toContain(needle);
		expect(buildClaudeCodeSettings(AiProvider.Anthropic).hooks.Stop[0].hooks[0].prompt).toContain(
			needle,
		);
		expect(buildJudgeScriptForRuntime(AgentRuntime.Codex)).toContain(needle);
		expect(buildJudgeScriptForRuntime(AgentRuntime.Gemini)).toContain(needle);
	});
});

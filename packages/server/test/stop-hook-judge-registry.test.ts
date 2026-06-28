import { AgentRuntime, AiProvider } from '@hezo/shared';
import { describe, expect, it } from 'vitest';
import {
	buildClaudeCodeSettings,
	buildCodexJudgeScript,
	buildGeminiJudgeScript,
	buildGrokJudgeScript,
	buildJudgeScriptForRuntime,
	buildKimiJudgeScript,
	STOP_HOOK_JUDGE_MODEL_XAI,
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

	it('Grok runtime builds the same script as buildGrokJudgeScript', () => {
		expect(buildJudgeScriptForRuntime(AgentRuntime.Grok)).toBe(buildGrokJudgeScript());
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

	it('Grok script targets xAI with the Grok judge model and XAI_API_KEY', () => {
		const script = buildGrokJudgeScript();
		expect(script).toContain('api.x.ai/v1/chat/completions');
		expect(script).toContain('XAI_API_KEY');
		expect(script).toContain(STOP_HOOK_JUDGE_MODEL_XAI);
		// Grok's Stop payload shape is undocumented, so the judge probes several
		// candidate fields rather than a single one.
		expect(script).toContain('last_assistant_message');
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

	it('the Claude Code prompt hook embeds the rule', () => {
		expect(STOP_HOOK_PROMPT).toContain('add_task_blocker');
		expect(buildClaudeCodeSettings(AiProvider.Anthropic).hooks.Stop[0].hooks[0].prompt).toContain(
			'add_task_blocker',
		);
	});

	it('every command-script judge embeds the same rule', () => {
		expect(buildJudgeScriptForRuntime(AgentRuntime.Codex)).toContain('add_task_blocker');
		expect(buildJudgeScriptForRuntime(AgentRuntime.Gemini)).toContain('add_task_blocker');
		expect(buildJudgeScriptForRuntime(AgentRuntime.Grok)).toContain('add_task_blocker');
		expect(buildKimiJudgeScript()).toContain('add_task_blocker');
	});
});

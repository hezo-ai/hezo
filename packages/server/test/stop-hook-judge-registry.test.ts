import { AgentRuntime } from '@hezo/shared';
import { describe, expect, it } from 'vitest';
import {
	buildCodexJudgeScript,
	buildGeminiJudgeScript,
	buildJudgeScriptForRuntime,
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
});

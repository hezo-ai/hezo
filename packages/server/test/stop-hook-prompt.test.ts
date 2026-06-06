import { describe, expect, it } from 'vitest';
import {
	buildClaudeCodeSettings,
	buildCodexJudgeScript,
	buildGeminiJudgeScript,
	STOP_HOOK_JUDGE_MODEL_ANTHROPIC,
	STOP_HOOK_JUDGE_MODEL_GOOGLE,
	STOP_HOOK_JUDGE_MODEL_OPENAI,
} from '../src/services/stop-hook-prompt';

describe('buildClaudeCodeSettings', () => {
	it('defaults to the Anthropic judge model (unchanged behavior)', () => {
		const settings = buildClaudeCodeSettings();
		expect(settings.hooks.Stop).toHaveLength(1);
		const entry = settings.hooks.Stop[0].hooks[0];
		expect(entry.type).toBe('prompt');
		expect(entry.model).toBe(STOP_HOOK_JUDGE_MODEL_ANTHROPIC);
		expect(entry.timeout).toBe(30);
		expect(entry.prompt).toContain('quality gate');
		expect(entry.prompt).toContain('$ARGUMENTS');
	});

	it('uses the provided judge model when given one', () => {
		const settings = buildClaudeCodeSettings('claude-some-future-model');
		expect(settings.hooks.Stop[0].hooks[0].model).toBe('claude-some-future-model');
	});

	it('omits the Stop hook entirely when the judge model is null (fail open)', () => {
		const settings = buildClaudeCodeSettings(null);
		expect(settings.hooks.Stop).toEqual([]);
	});
});

describe('judge scripts', () => {
	it('codex script targets the OpenAI judge model and Chat Completions API', () => {
		const script = buildCodexJudgeScript();
		expect(script).toContain(STOP_HOOK_JUDGE_MODEL_OPENAI);
		expect(script).toContain('api.openai.com/v1/chat/completions');
		expect(script).toContain('last_assistant_message');
		expect(script).toContain('quality gate');
	});

	it('gemini script targets the Google judge model and Generative AI API', () => {
		const script = buildGeminiJudgeScript();
		expect(script).toContain(STOP_HOOK_JUDGE_MODEL_GOOGLE);
		expect(script).toContain('generativelanguage.googleapis.com');
		expect(script).toContain('prompt_response');
		expect(script).toContain('quality gate');
	});
});

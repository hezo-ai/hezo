import { AgentEffort, AgentRuntime, DEFAULT_EFFORT } from '@hezo/shared';
import { describe, expect, it } from 'vitest';
import {
	applyEffortToRuntime,
	parseEffortFromCommentBody,
	resolveEffort,
} from '../../services/effort';

describe('resolveEffort', () => {
	it('prefers a valid wakeup override over the agent default', () => {
		expect(resolveEffort(AgentEffort.Max, AgentEffort.Medium)).toBe(AgentEffort.Max);
	});

	it('falls back to the agent default when the wakeup has no override', () => {
		expect(resolveEffort(undefined, AgentEffort.High)).toBe(AgentEffort.High);
		expect(resolveEffort(null, AgentEffort.High)).toBe(AgentEffort.High);
	});

	it('ignores garbage wakeup values and falls back to the agent default', () => {
		expect(resolveEffort('nonsense', AgentEffort.High)).toBe(AgentEffort.High);
		expect(resolveEffort(42, AgentEffort.High)).toBe(AgentEffort.High);
	});

	it('falls back to DEFAULT_EFFORT when both inputs are missing or invalid', () => {
		expect(resolveEffort(undefined, undefined)).toBe(DEFAULT_EFFORT);
		expect(resolveEffort('bogus', 'also-bogus')).toBe(DEFAULT_EFFORT);
	});

	it('forces max effort for the CEO regardless of wakeup or column default', () => {
		expect(resolveEffort(AgentEffort.Minimal, AgentEffort.Low, 'ceo')).toBe(AgentEffort.Max);
		expect(resolveEffort(undefined, null, 'ceo')).toBe(AgentEffort.Max);
		expect(resolveEffort('nonsense', 'bogus', 'ceo')).toBe(AgentEffort.Max);
	});

	it('does not force max effort for other slugs', () => {
		expect(resolveEffort(undefined, AgentEffort.Low, 'engineer')).toBe(AgentEffort.Low);
		expect(resolveEffort(AgentEffort.Medium, AgentEffort.Low, 'architect')).toBe(
			AgentEffort.Medium,
		);
	});
});

describe('parseEffortFromCommentBody', () => {
	it('reads a top-level effort field', () => {
		expect(parseEffortFromCommentBody({ effort: AgentEffort.Max })).toBe(AgentEffort.Max);
	});

	it('reads a nested content.effort field', () => {
		expect(parseEffortFromCommentBody({ content: { effort: AgentEffort.High, text: 'hi' } })).toBe(
			AgentEffort.High,
		);
	});

	it('prefers the top-level field over the nested one', () => {
		expect(
			parseEffortFromCommentBody({
				effort: AgentEffort.Low,
				content: { effort: AgentEffort.Max },
			}),
		).toBe(AgentEffort.Low);
	});

	it('returns null for missing or invalid values', () => {
		expect(parseEffortFromCommentBody({ content: { text: 'hi' } })).toBe(null);
		expect(parseEffortFromCommentBody({ effort: 'ultrathink' })).toBe(null);
		expect(parseEffortFromCommentBody({})).toBe(null);
	});
});

describe('applyEffortToRuntime — Claude Code', () => {
	it('appends ultrathink directive at max effort', () => {
		const r = applyEffortToRuntime(AgentRuntime.ClaudeCode, AgentEffort.Max);
		expect(r.promptDirective).toBe('ultrathink');
		expect(r.extraArgs).toEqual([]);
		expect(r.extraEnv).toEqual([]);
	});

	it('uses "think hard" at high effort', () => {
		const r = applyEffortToRuntime(AgentRuntime.ClaudeCode, AgentEffort.High);
		expect(r.promptDirective).toBe('think hard');
	});

	it('omits the directive at minimal effort', () => {
		const r = applyEffortToRuntime(AgentRuntime.ClaudeCode, AgentEffort.Minimal);
		expect(r.promptDirective).toBe('');
	});
});

describe('applyEffortToRuntime — Codex', () => {
	it('passes the reasoning effort via -c flag', () => {
		const r = applyEffortToRuntime(AgentRuntime.Codex, AgentEffort.High);
		expect(r.extraArgs).toEqual(['-c', 'model_reasoning_effort=high']);
	});

	it('maps max → high (Codex does not have a max level)', () => {
		const r = applyEffortToRuntime(AgentRuntime.Codex, AgentEffort.Max);
		expect(r.extraArgs).toEqual(['-c', 'model_reasoning_effort=high']);
	});

	it('passes minimal through unchanged', () => {
		const r = applyEffortToRuntime(AgentRuntime.Codex, AgentEffort.Minimal);
		expect(r.extraArgs).toEqual(['-c', 'model_reasoning_effort=minimal']);
	});
});

describe('applyEffortToRuntime — Gemini', () => {
	it('sets GEMINI_REASONING_EFFORT env var', () => {
		const r = applyEffortToRuntime(AgentRuntime.Gemini, AgentEffort.High);
		expect(r.extraEnv).toEqual(['GEMINI_REASONING_EFFORT=high']);
		expect(r.extraArgs).toEqual([]);
	});
});

import { describe, expect, it } from 'vitest';
import { toEntityBudgetStatus } from '../src/services/budget';
import { buildRunLimitsBlock } from '../src/services/template-resolver';

// `buildRunLimitsBlock` is a pure formatter (the runner fetches run_timeout_min +
// budget status and passes them in), so these tests need no DB/context.

const status = (
	spend: { daily: number; weekly: number; monthly: number },
	limits: { daily: number; weekly: number; monthly: number },
) =>
	toEntityBudgetStatus(spend, {
		daily_budget_cents: limits.daily,
		weekly_budget_cents: limits.weekly,
		monthly_budget_cents: limits.monthly,
	});

const NO_CAPS = status({ daily: 0, weekly: 0, monthly: 0 }, { daily: 0, weekly: 0, monthly: 0 });

describe('buildRunLimitsBlock', () => {
	it('states the run-time limit in minutes and the graceful wind-down protocol', () => {
		const block = buildRunLimitsBlock(60, NO_CAPS, null);
		expect(block).toContain('## Run limits & winding down');
		expect(block).toContain('hard wall-clock limit of **60 minutes**');
		// The wind-down protocol references the durability path (auto-push) + deferral.
		expect(block).toContain('auto-pushes');
		expect(block).toContain('leave the task non-terminal');
	});

	it('says no cap is configured when neither agent nor project has budget limits', () => {
		const block = buildRunLimitsBlock(60, NO_CAPS, NO_CAPS);
		expect(block).toContain('No spend cap is configured');
		expect(block).not.toContain('Daily —');
	});

	it('lists only capped windows with spend/cap in dollars, agent and project', () => {
		// agent: daily + weekly capped, monthly unlimited; project: only daily capped.
		const agent = status(
			{ daily: 42, weekly: 310, monthly: 0 },
			{ daily: 500, weekly: 2000, monthly: 0 },
		);
		const project = status(
			{ daily: 1210, weekly: 0, monthly: 0 },
			{ daily: 5000, weekly: 0, monthly: 0 },
		);
		const block = buildRunLimitsBlock(90, agent, project);
		expect(block).toContain('hard wall-clock limit of **90 minutes**');
		expect(block).toContain('Daily — you $0.42/$5.00 · project $12.10/$50.00');
		expect(block).toContain('Weekly — you $3.10/$20.00'); // only the agent side is capped
		expect(block).not.toContain('Monthly —'); // uncapped on both → omitted
	});

	it('shows only the agent side when the project has no budget status', () => {
		const agent = status(
			{ daily: 100, weekly: 0, monthly: 0 },
			{ daily: 1000, weekly: 0, monthly: 0 },
		);
		const block = buildRunLimitsBlock(30, agent, null);
		expect(block).toContain('Daily — you $1.00/$10.00');
		expect(block).not.toContain('project ');
	});
});

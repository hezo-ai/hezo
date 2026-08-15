import { describe, expect, it } from 'vitest';
import { GoalHealth, sortGoalsByTriage } from '../src/types/common';

/**
 * The ordering a capped goal list uses. It exists so a surface showing only some of a project's
 * goals spends those slots on the ones needing a decision, so the properties worth pinning are
 * the ranking itself, that ties keep their input order, and that the input is not mutated.
 */
const goal = (id: string, health: GoalHealth) => ({ id, health });

describe('sortGoalsByTriage', () => {
	it('ranks off track, then at risk, then unassessed, then on track', () => {
		const sorted = sortGoalsByTriage([
			goal('ok', GoalHealth.OnTrack),
			goal('pending', GoalHealth.Pending),
			goal('off', GoalHealth.OffTrack),
			goal('risk', GoalHealth.AtRisk),
		]);
		expect(sorted.map((g) => g.id)).toEqual(['off', 'risk', 'pending', 'ok']);
	});

	it('keeps the input order within one health, so a stable list does not reshuffle itself', () => {
		const sorted = sortGoalsByTriage([
			goal('first', GoalHealth.OnTrack),
			goal('second', GoalHealth.OnTrack),
			goal('third', GoalHealth.OnTrack),
		]);
		expect(sorted.map((g) => g.id)).toEqual(['first', 'second', 'third']);
	});

	it('sorts an unknown health last rather than throwing', () => {
		// A health value from a newer server than this client: it must not win a slot over a
		// goal the Captain has actually assessed as off track.
		const sorted = sortGoalsByTriage([
			goal('mystery', 'invented_later' as GoalHealth),
			goal('off', GoalHealth.OffTrack),
		]);
		expect(sorted.map((g) => g.id)).toEqual(['off', 'mystery']);
	});

	it('returns a new array and leaves the caller’s own untouched', () => {
		const input = [goal('ok', GoalHealth.OnTrack), goal('off', GoalHealth.OffTrack)];
		const sorted = sortGoalsByTriage(input);
		expect(sorted).not.toBe(input);
		expect(input.map((g) => g.id)).toEqual(['ok', 'off']);
	});

	it('handles an empty list', () => {
		expect(sortGoalsByTriage([])).toEqual([]);
	});
});

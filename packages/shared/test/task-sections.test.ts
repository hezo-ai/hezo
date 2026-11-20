import { describe, expect, it } from 'vitest';
import {
	parseTaskSectionsOpenPatch,
	resolveTaskSectionsOpen,
	TASK_SECTION_DEFAULT_OPEN,
	TaskSection,
} from '../src/task-sections.js';

describe('parseTaskSectionsOpenPatch', () => {
	it('accepts a partial patch of known sections', () => {
		expect(parseTaskSectionsOpenPatch({ rules: true })).toEqual({
			ok: true,
			value: { rules: true },
		});
		expect(
			parseTaskSectionsOpenPatch({ sub_tasks: false, progress_summary: true, rules: false }),
		).toEqual({
			ok: true,
			value: { sub_tasks: false, progress_summary: true, rules: false },
		});
	});

	it('rejects a value that is not an object', () => {
		for (const input of [null, undefined, 'rules', 3, [true]]) {
			const result = parseTaskSectionsOpenPatch(input);
			expect(result.ok).toBe(false);
		}
	});

	it('rejects an unknown section and names the known ones', () => {
		const result = parseTaskSectionsOpenPatch({ comments: true });
		expect(result).toEqual({
			ok: false,
			error: expect.stringContaining('unknown section "comments"'),
		});
		if (!result.ok) expect(result.error).toContain('sub_tasks');
	});

	it('rejects a value that is not a boolean', () => {
		expect(parseTaskSectionsOpenPatch({ rules: 'true' })).toEqual({
			ok: false,
			error: 'sections_open.rules must be a boolean',
		});
		expect(parseTaskSectionsOpenPatch({ sub_tasks: null }).ok).toBe(false);
	});

	it('rejects an empty patch', () => {
		const result = parseTaskSectionsOpenPatch({});
		expect(result.ok).toBe(false);
		if (!result.ok) expect(result.error).toContain('at least one');
	});
});

describe('resolveTaskSectionsOpen', () => {
	it('starts Sub-tasks open and the other cards folded', () => {
		expect(resolveTaskSectionsOpen(undefined)).toEqual({
			sub_tasks: true,
			rules: false,
			progress_summary: false,
		});
		expect(resolveTaskSectionsOpen({})).toEqual(TASK_SECTION_DEFAULT_OPEN);
	});

	it('overlays the saved state on the defaults', () => {
		expect(resolveTaskSectionsOpen({ sub_tasks: false, rules: true })).toEqual({
			sub_tasks: false,
			rules: true,
			progress_summary: false,
		});
	});

	it('keeps the default for a malformed saved value and ignores unknown keys', () => {
		expect(
			resolveTaskSectionsOpen({ [TaskSection.Rules]: 'yes', comments: true, sub_tasks: false }),
		).toEqual({ sub_tasks: false, rules: false, progress_summary: false });
		expect(resolveTaskSectionsOpen('garbage')).toEqual(TASK_SECTION_DEFAULT_OPEN);
		expect(resolveTaskSectionsOpen([true])).toEqual(TASK_SECTION_DEFAULT_OPEN);
	});

	it('does not share the defaults object with its callers', () => {
		const resolved = resolveTaskSectionsOpen(undefined);
		resolved.rules = true;
		expect(TASK_SECTION_DEFAULT_OPEN.rules).toBe(false);
	});
});

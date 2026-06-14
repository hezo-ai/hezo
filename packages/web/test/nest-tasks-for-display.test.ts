import { describe, expect, it } from 'vitest';
import { nestTasksForDisplay } from '../src/lib/nest-tasks-for-display';

type Row = { id: string; parent_task_id: string | null; title: string };

function row(id: string, title: string, parent?: string): Row {
	return { id, title, parent_task_id: parent ?? null };
}

describe('nestTasksForDisplay', () => {
	it('returns a single root unchanged', () => {
		expect(nestTasksForDisplay([row('a', 'A')])).toEqual([{ ...row('a', 'A'), depth: 0 }]);
	});

	it('nests a child beneath its parent', () => {
		const nested = nestTasksForDisplay([row('p', 'Parent'), row('c', 'Child', 'p')]);
		expect(nested.map((t) => [t.title, t.depth])).toEqual([
			['Parent', 0],
			['Child', 1],
		]);
	});

	it('preserves parent order from the flat list', () => {
		const nested = nestTasksForDisplay([row('b', 'B'), row('a', 'A'), row('c', 'C', 'a')]);
		expect(nested.map((t) => t.title)).toEqual(['B', 'A', 'C']);
	});

	it('preserves sibling order under the same parent', () => {
		const nested = nestTasksForDisplay([
			row('p', 'Parent'),
			row('c2', 'Second', 'p'),
			row('c1', 'First', 'p'),
		]);
		expect(nested.map((t) => t.title)).toEqual(['Parent', 'Second', 'First']);
	});

	it('supports depth-2 nesting', () => {
		const nested = nestTasksForDisplay([
			row('p', 'Parent'),
			row('c', 'Child', 'p'),
			row('gc', 'Grandchild', 'c'),
		]);
		expect(nested.map((t) => [t.title, t.depth])).toEqual([
			['Parent', 0],
			['Child', 1],
			['Grandchild', 2],
		]);
	});

	it('shows orphans at top level when parent is absent from the list', () => {
		const nested = nestTasksForDisplay([row('c', 'Orphan', 'missing')]);
		expect(nested).toEqual([{ ...row('c', 'Orphan', 'missing'), depth: 0 }]);
	});
});

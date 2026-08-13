import { describe, expect, it } from 'vitest';
import {
	buildThreadItems,
	DEFAULT_TASK_VIEW,
	failedRunIds,
	findGroupKeyForRow,
	isFoldableThreadRow,
	isInlineEventType,
	isRunFailedRow,
	isTaskView,
	isWorkingThreadRow,
	TASK_VIEWS,
	TaskView,
	type ThreadRow,
	threadRowRunId,
} from '../src/task-thread.js';

function text(id: string): ThreadRow {
	return { id, content_type: 'text', content: null };
}
function run(id: string, runId: string): ThreadRow {
	return { id, content_type: 'run', content: { run_id: runId, agent_slug: 'writer' } };
}
function sys(id: string, kind: string, extra: Record<string, unknown> = {}): ThreadRow {
	return { id, content_type: 'system', content: { kind, ...extra } };
}

describe('TaskView', () => {
	it('accepts only the two views', () => {
		expect(isTaskView('conversation')).toBe(true);
		expect(isTaskView('detailed')).toBe(true);
		expect(isTaskView('simple')).toBe(false);
		expect(isTaskView(null)).toBe(false);
		expect(isTaskView(undefined)).toBe(false);
		expect(isTaskView(1)).toBe(false);
	});

	it('defaults to conversation and lists both views', () => {
		expect(DEFAULT_TASK_VIEW).toBe(TaskView.Conversation);
		expect([...TASK_VIEWS]).toEqual(['conversation', 'detailed']);
	});
});

describe('row classification', () => {
	it('treats only system and run rows as inline events', () => {
		expect(isInlineEventType('system')).toBe(true);
		expect(isInlineEventType('run')).toBe(true);
		for (const t of [
			'text',
			'preview',
			'action',
			'credential_request',
			'connect_required',
			'asset_deletion_request',
		]) {
			expect(isInlineEventType(t)).toBe(false);
		}
	});

	it('never folds a row a person wrote or must act on', () => {
		for (const t of [
			'text',
			'preview',
			'action',
			'credential_request',
			'connect_required',
			'asset_deletion_request',
		]) {
			expect(isFoldableThreadRow({ id: 'c', content_type: t })).toBe(false);
		}
	});

	it('folds completed runs and every system change', () => {
		expect(isFoldableThreadRow(run('c1', 'r1'), {})).toBe(true);
		expect(isFoldableThreadRow(sys('c2', 'status_change'), {})).toBe(true);
		expect(isFoldableThreadRow(sys('c3', 'task_link'), {})).toBe(true);
		expect(isFoldableThreadRow(sys('c4', 'run_failed', { run_id: 'r1' }), {})).toBe(true);
	});

	it('keeps the live run and the retryable failure out of the fold', () => {
		expect(isFoldableThreadRow(run('c1', 'r1'), { activeRunId: 'r1' })).toBe(false);
		expect(isFoldableThreadRow(run('c2', 'r2'), { retryableRunId: 'r2' })).toBe(false);
		// A different run keeps folding.
		expect(isFoldableThreadRow(run('c3', 'r3'), { activeRunId: 'r1', retryableRunId: 'r2' })).toBe(
			true,
		);
	});

	it('folds a run row whose payload carries no run id', () => {
		const orphan: ThreadRow = { id: 'c', content_type: 'run', content: {} };
		expect(threadRowRunId(orphan)).toBeNull();
		expect(isFoldableThreadRow(orphan, { activeRunId: 'r1' })).toBe(true);
	});

	it('identifies the working row only by the active run id', () => {
		expect(isWorkingThreadRow(run('c1', 'r1'), { activeRunId: 'r1' })).toBe(true);
		expect(isWorkingThreadRow(run('c1', 'r1'), { activeRunId: 'r2' })).toBe(false);
		expect(isWorkingThreadRow(run('c1', 'r1'), {})).toBe(false);
		// A system row naming the active run is still not the working row.
		expect(
			isWorkingThreadRow(sys('c2', 'run_failed', { run_id: 'r1' }), { activeRunId: 'r1' }),
		).toBe(false);
	});

	it('recognises run_failed rows and collects their run ids', () => {
		expect(isRunFailedRow(sys('c1', 'run_failed', { run_id: 'r1' }))).toBe(true);
		expect(isRunFailedRow(sys('c2', 'status_change'))).toBe(false);
		expect(isRunFailedRow(run('c3', 'r1'))).toBe(false);
		expect([
			...failedRunIds([
				sys('c1', 'run_failed', { run_id: 'r1' }),
				sys('c2', 'run_failed', { run_id: 'r2' }),
				sys('c3', 'run_failed'),
				sys('c4', 'status_change'),
			]),
		]).toEqual(['r1', 'r2']);
	});

	it('tolerates a non-object content payload', () => {
		const weird: ThreadRow = { id: 'c', content_type: 'run', content: 'not-an-object' };
		expect(threadRowRunId(weird)).toBeNull();
		expect(isRunFailedRow({ id: 'c', content_type: 'system', content: null })).toBe(false);
	});
});

describe('buildThreadItems', () => {
	it('returns every row on its own in the detailed view', () => {
		const rows = [text('a'), run('b', 'r1'), sys('c', 'status_change')];
		const items = buildThreadItems(rows, TaskView.Detailed);
		expect(items.map((i) => i.kind)).toEqual(['row', 'row', 'row']);
		expect(items.map((i) => i.key)).toEqual(['row:a', 'row:b', 'row:c']);
	});

	it('groups contiguous foldable rows in chronological position', () => {
		const rows = [
			text('a'),
			run('b', 'r1'),
			sys('c', 'status_change'),
			text('d'),
			sys('e', 'task_link'),
		];
		const items = buildThreadItems(rows, TaskView.Conversation);
		expect(items.map((i) => i.kind)).toEqual(['row', 'group', 'row', 'group']);
		const first = items[1];
		if (first.kind !== 'group') throw new Error('expected a group');
		expect(first.rows.map((r) => r.id)).toEqual(['b', 'c']);
		expect(first.key).toBe('group:b');
	});

	it('does not merge groups separated by a visible row', () => {
		const rows = [run('a', 'r1'), text('b'), run('c', 'r2')];
		const items = buildThreadItems(rows, TaskView.Conversation);
		expect(items.map((i) => i.kind)).toEqual(['group', 'row', 'group']);
	});

	it('splits a group around the live run and the retryable failure', () => {
		const rows = [
			sys('a', 'status_change'),
			run('b', 'r-old'),
			run('c', 'r-retry'),
			sys('d', 'task_link'),
			run('e', 'r-live'),
		];
		const items = buildThreadItems(rows, TaskView.Conversation, {
			activeRunId: 'r-live',
			retryableRunId: 'r-retry',
		});
		expect(items.map((i) => i.kind)).toEqual(['group', 'row', 'group', 'row']);
		expect(items[1].kind === 'row' && items[1].row.id).toBe('c');
		expect(items[3].kind === 'row' && items[3].row.id).toBe('e');
	});

	it('counts failures, other runs and changes separately', () => {
		const rows = [
			run('a', 'r1'),
			sys('b', 'run_failed', { run_id: 'r1' }),
			run('c', 'r2'),
			sys('d', 'status_change'),
			sys('e', 'assignee_change'),
		];
		const items = buildThreadItems(rows, TaskView.Conversation);
		expect(items).toHaveLength(1);
		const group = items[0];
		if (group.kind !== 'group') throw new Error('expected a group');
		expect(group.summary).toEqual({ total: 5, failedRuns: 1, runs: 1, changes: 2 });
	});

	it('counts an undetected failure as a plain run rather than guessing', () => {
		const items = buildThreadItems([run('a', 'r1')], TaskView.Conversation);
		const group = items[0];
		if (group.kind !== 'group') throw new Error('expected a group');
		expect(group.summary).toEqual({ total: 1, failedRuns: 0, runs: 1, changes: 0 });
	});

	it('keeps a group key stable when later rows join it', () => {
		const before = buildThreadItems([text('a'), run('b', 'r1')], TaskView.Conversation);
		const after = buildThreadItems(
			[text('a'), run('b', 'r1'), sys('c', 'status_change')],
			TaskView.Conversation,
		);
		expect(before[1].key).toBe('group:b');
		expect(after[1].key).toBe('group:b');
	});

	it('handles an empty thread and an all-foldable thread', () => {
		expect(buildThreadItems([], TaskView.Conversation)).toEqual([]);
		const all = buildThreadItems(
			[run('a', 'r1'), sys('b', 'status_change')],
			TaskView.Conversation,
		);
		expect(all).toHaveLength(1);
		expect(all[0].kind).toBe('group');
	});

	it('finds the group a folded row belongs to, and none for a visible row', () => {
		const rows = [text('a'), run('b', 'r1'), sys('c', 'status_change')];
		const items = buildThreadItems(rows, TaskView.Conversation);
		expect(findGroupKeyForRow(items, 'c')).toBe('group:b');
		expect(findGroupKeyForRow(items, 'a')).toBeNull();
		expect(findGroupKeyForRow(items, 'nope')).toBeNull();
	});
});

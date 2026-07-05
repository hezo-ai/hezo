import type { QueryClient } from '@tanstack/react-query';
import { describe, expect, test } from 'vitest';
import { invalidateQueriesForRowChange } from '../src/hooks/use-websocket';
import { queryKeys } from '../src/lib/query-keys';

/**
 * B2 refactor: realtime invalidation (use-websocket's TABLE_TO_QUERY_KEY) and
 * the hooks both build keys from the same `queryKeys` factory. This pins the
 * websocket side to the factory output, so a key shape can't drift between the
 * two without this failing (the bug class the factory exists to prevent).
 */
function recordingClient() {
	const keys: unknown[][] = [];
	const calls: { queryKey: unknown[]; exact?: boolean }[] = [];
	const client = {
		invalidateQueries: ({ queryKey, exact }: { queryKey: unknown[]; exact?: boolean }) => {
			keys.push(queryKey);
			calls.push({ queryKey, exact });
		},
	} as unknown as QueryClient;
	return { client, keys, calls };
}

const SLUG = 'ops';

describe('invalidateQueriesForRowChange uses the queryKeys factory', () => {
	test('tasks row change invalidates the task list + global indexes', () => {
		const { client, keys } = recordingClient();
		invalidateQueriesForRowChange(client, SLUG, 'tasks', {});
		expect(keys).toContainEqual(queryKeys.projects.tasks(SLUG));
		expect(keys).toContainEqual(queryKeys.projects.all());
		expect(keys).toContainEqual(queryKeys.projectIntakes());
	});

	test('approvals row change invalidates approvals + inbox count', () => {
		const { client, keys } = recordingClient();
		invalidateQueriesForRowChange(client, SLUG, 'approvals', {});
		expect(keys).toContainEqual(queryKeys.projects.approvals(SLUG));
		expect(keys).toContainEqual(queryKeys.projects.inboxCount(SLUG));
		expect(keys).toContainEqual(queryKeys.approvals.root());
	});

	test('heartbeat_runs scopes queued-wakeups + heartbeat-runs to the row ids', () => {
		const { client, keys } = recordingClient();
		invalidateQueriesForRowChange(client, SLUG, 'heartbeat_runs', {
			task_id: 't1',
			member_id: 'a1',
			id: 'r1',
		});
		expect(keys).toContainEqual(queryKeys.projects.taskQueuedWakeups(SLUG, 't1'));
		expect(keys).toContainEqual(queryKeys.projects.agentHeartbeatRuns(SLUG, 'a1'));
		expect(keys).toContainEqual(queryKeys.projects.agentHeartbeatRun(SLUG, 'a1', 'r1'));
	});

	test('mcp_connections detail key is scoped to the row id', () => {
		const { client, keys } = recordingClient();
		invalidateQueriesForRowChange(client, SLUG, 'mcp_connections', { id: 'c1' });
		expect(keys).toContainEqual(queryKeys.projects.mcpConnections(SLUG));
		expect(keys).toContainEqual(queryKeys.projects.mcpConnectionDetail(SLUG, 'c1'));
	});

	test('document row change branches on the document type', () => {
		const { client, keys } = recordingClient();
		invalidateQueriesForRowChange(client, SLUG, 'documents', { type: 'skill' });
		expect(keys).toContainEqual(queryKeys.projects.skills(SLUG));
	});

	test('task_comments invalidates the task list (prefix-covers taskComments)', () => {
		// task_comments maps to projects.tasks(cid); per the queryKeys factory that
		// prefix also invalidates taskComments(cid, taskId) beneath it, so an
		// incoming comment refetches the open thread.
		const { client, keys } = recordingClient();
		invalidateQueriesForRowChange(client, SLUG, 'task_comments', { task_id: 't1' });
		expect(keys).toContainEqual(queryKeys.projects.tasks(SLUG));
	});

	test('comment_reactions invalidates the task list', () => {
		const { client, keys } = recordingClient();
		invalidateQueriesForRowChange(client, SLUG, 'comment_reactions', { task_id: 't1' });
		expect(keys).toContainEqual(queryKeys.projects.tasks(SLUG));
	});

	test('member_agents row change invalidates agents AND budget status', () => {
		// Agent rows carry the per-agent budget caps; the Budget page's status
		// query must refetch when one changes (e.g. a cap edit or budget pause).
		const { client, keys } = recordingClient();
		invalidateQueriesForRowChange(client, SLUG, 'member_agents', {});
		expect(keys).toContainEqual(queryKeys.projects.agents(SLUG));
		expect(keys).toContainEqual(queryKeys.projects.budgetStatus(SLUG));
	});

	test('cost_entries row change invalidates costs AND budget status', () => {
		// New spend moves both the cost charts and the spend-vs-cap status.
		const { client, keys } = recordingClient();
		invalidateQueriesForRowChange(client, SLUG, 'cost_entries', {});
		expect(keys).toContainEqual(['projects', SLUG, 'costs']);
		expect(keys).toContainEqual(queryKeys.projects.budgetStatus(SLUG));
	});

	test('unknown table is a no-op', () => {
		const { client, keys } = recordingClient();
		invalidateQueriesForRowChange(client, SLUG, 'nonexistent', {});
		expect(keys).toHaveLength(0);
	});

	test('the project-index key is invalidated EXACTLY, but per-project keys stay fuzzy', () => {
		// Regression: `['projects']` is the index query key AND a prefix of every
		// `['projects', <slug>, ...]` query. A fuzzy invalidation of it refetches
		// every project's task list on any one project's change (the cross-project
		// refetch storm). It must be invalidated with exact:true; the per-project
		// keys (e.g. tasks(cid)) must stay fuzzy so they still prefix-cover their
		// own sub-queries (taskComments, phase-banner).
		const { client, calls } = recordingClient();
		invalidateQueriesForRowChange(client, SLUG, 'tasks', {});
		const indexCall = calls.find(
			(c) => Array.isArray(c.queryKey) && c.queryKey.length === 1 && c.queryKey[0] === 'projects',
		);
		expect(indexCall?.exact).toBe(true);
		const tasksCall = calls.find(
			(c) => JSON.stringify(c.queryKey) === JSON.stringify(queryKeys.projects.tasks(SLUG)),
		);
		expect(tasksCall?.exact).toBeFalsy();
	});
});

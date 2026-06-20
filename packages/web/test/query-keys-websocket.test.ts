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
	const client = {
		invalidateQueries: ({ queryKey }: { queryKey: unknown[] }) => {
			keys.push(queryKey);
		},
	} as unknown as QueryClient;
	return { client, keys };
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

	test('unknown table is a no-op', () => {
		const { client, keys } = recordingClient();
		invalidateQueriesForRowChange(client, SLUG, 'nonexistent', {});
		expect(keys).toHaveLength(0);
	});
});

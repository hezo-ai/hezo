// Regression: the "provisioning is complete" signal has to land in situ.
//
// The container status banner reads its health from the project index, and
// provisioning ends with a single `projects` row change broadcast over the
// WebSocket. Resolving that row to a project slug used to fall through to the
// `team_id` lookup, which filters out `is_internal` projects — so the HQ
// transition resolved to nothing and was dropped. The resolver's table
// branching is unit-tested in resolve-project-slug-for-row.test.ts; this spec
// pins the HQ row resolving by its own id against the real project index.
//
// The CEO chat itself no longer gates on the HQ container: a turn claims a
// pool container when it is sent, so the composer stays open mid-provision —
// asserted here because this spec seeds exactly that state.

import { queryClient } from '@hezo/web/lib/query-client';
import { waitFor } from '@testing-library/react';
import { expect, test } from 'vitest';
import type { Project } from '../src/hooks/use-projects';
import {
	invalidateQueriesForRowChange,
	resolveProjectSlugForChange,
} from '../src/hooks/use-websocket';
import { queryKeys } from '../src/lib/query-keys';
import { renderApp } from './helpers/render';

test('the CEO composer stays open mid-provision, and the HQ row change resolves in situ', async () => {
	let hq!: { id: string; team_id: string };
	let db!: Parameters<NonNullable<Parameters<typeof renderApp>[0]['seed']>>[0]['db'];

	const { findByTestId } = await renderApp({
		initialPath: '/home',
		seed: async (ctx) => {
			db = ctx.db;
			const r = await ctx.db.query<{ id: string; team_id: string }>(
				`UPDATE projects SET container_status = 'creating'
				 WHERE is_internal = true
				 RETURNING id, team_id`,
			);
			hq = r.rows[0];
		},
	});

	const panel = async () => await findByTestId('chat-panel');
	(await findByTestId('app-header-chat')).click();

	// Mid-provision the composer is open and nothing gates the chat: a send would
	// claim its own pool container, so there is no state to wait out here.
	await waitFor(async () => {
		if (!(await panel()).querySelector('[data-testid="chat-input"]')) {
			throw new Error('composer not yet rendered');
		}
	});
	expect((await panel()).querySelector('[data-testid="hq-container-notice"]')).toBeNull();

	// The container comes up server-side and broadcasts a `projects` UPDATE. The
	// row is the shape broadcastProjectUpdate emits: its own `id` and `team_id`,
	// never a `project_id`.
	await db.query(`UPDATE projects SET container_status = 'running' WHERE id = $1`, [hq.id]);
	const row = { id: hq.id, team_id: hq.team_id, container_status: 'running' };

	// The crux: HQ is the is_internal project, so the `team_id` fallback resolves
	// nothing for it. Keying on the row's own id is what makes the signal land.
	await waitFor(() => {
		const loaded = queryClient.getQueryData<Project[]>(queryKeys.projects.all()) ?? [];
		if (loaded.length === 0) throw new Error('project index not loaded yet');
	});
	const index = queryClient.getQueryData<Project[]>(queryKeys.projects.all()) ?? [];
	const slug = resolveProjectSlugForChange(index, 'projects', row);
	expect(slug).toBe('hq');

	// And the invalidation keyed on that slug goes through without error.
	invalidateQueriesForRowChange(queryClient, slug as string, 'projects', row);
});

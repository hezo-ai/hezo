// Regression: the "provisioning is complete" signal has to land in situ.
//
// The container status banner and the CEO chat's HQ gate both read their health
// from the project index, and provisioning ends with a single `projects` row
// change broadcast over the WebSocket. Resolving that row to a project slug used
// to fall through to the `team_id` lookup, which filters out `is_internal`
// projects — so the HQ transition resolved to nothing and was dropped, leaving
// the chat stuck on "Starting the HQ container…" until a full page reload.
//
// Component tier: the harness stubs the WebSocket transport, so the spec drives
// the subscriber's own resolve-then-invalidate path directly against the real
// components and the real backend. The resolver's table branching is unit-tested
// in resolve-project-slug-for-row.test.ts.

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

test('the CEO chat unblocks in situ when HQ finishes provisioning', async () => {
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
	(await findByTestId('chat-launcher')).click();

	// Provisioning: the notice replaces the composer.
	const notice = await waitFor(async () => {
		const el = (await panel()).querySelector('[data-testid="hq-container-notice"]');
		if (!el) throw new Error('notice not yet rendered');
		return el as HTMLElement;
	});
	expect(notice.textContent ?? '').toContain('Starting the HQ container');
	expect((await panel()).querySelector('[data-testid="chat-input"]')).toBeNull();

	// The container comes up server-side and broadcasts a `projects` UPDATE. The
	// row is the shape broadcastProjectUpdate emits: its own `id` and `team_id`,
	// never a `project_id`.
	await db.query(`UPDATE projects SET container_status = 'running' WHERE id = $1`, [hq.id]);
	const row = { id: hq.id, team_id: hq.team_id, container_status: 'running' };

	// The crux: HQ is the is_internal project, so the `team_id` fallback resolves
	// nothing for it. Keying on the row's own id is what makes the signal land.
	const index = queryClient.getQueryData<Project[]>(queryKeys.projects.all()) ?? [];
	const slug = resolveProjectSlugForChange(index, 'projects', row);
	expect(slug).toBe('hq');

	invalidateQueriesForRowChange(queryClient, slug as string, 'projects', row);

	// The gate clears and the composer comes back — no navigation, no reload.
	await waitFor(async () => {
		if ((await panel()).querySelector('[data-testid="hq-container-notice"]')) {
			throw new Error('still gated on the container');
		}
	});
	expect((await panel()).querySelector('[data-testid="chat-input"]')).toBeTruthy();
});

import { WsMessageType, wsRoom } from '@hezo/shared';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import type { Env } from '../src/lib/types';
import { WebSocketManager, type WsEvent } from '../src/services/ws';
import { safeClose } from './helpers';
import { authHeader, createTestApp, createTestProject, createTestTeam } from './helpers/app';

interface CapturedBroadcast {
	room: string;
	event: WsEvent;
}

describe('container removal broadcasts carry team_id', () => {
	let ctx: Awaited<ReturnType<typeof createTestApp>>;
	let teamId: string;
	let projectId: string;
	let projectSlug: string;
	let captured: CapturedBroadcast[];
	let broadcastSpy: ReturnType<typeof vi.spyOn>;

	beforeAll(async () => {
		ctx = await createTestApp();

		const typesRes = await ctx.app.request('/api/team-templates', {
			headers: authHeader(ctx.token),
		});
		const typeId = (await typesRes.json()).data.find(
			(t: { name: string }) => t.name === 'Blank',
		).id;

		const teamRes = await createTestTeam(ctx.db, {
			name: 'Container Broadcast Co',
			template_id: typeId,
		});
		teamId = (await teamRes.json()).data.id;

		const projectRes = await createTestProject(ctx.db, teamId, {
			name: 'Container Broadcast Project',
		});
		const project = (await projectRes.json()).data;
		projectId = project.id;
		projectSlug = project.slug;

		captured = [];
		broadcastSpy = vi.spyOn(WebSocketManager.prototype, 'broadcast').mockImplementation(function (
			this: WebSocketManager,
			room: string,
			event: WsEvent,
		) {
			captured.push({ room, event });
		});
	});

	afterAll(async () => {
		broadcastSpy.mockRestore();
		await safeClose(ctx.db);
	});

	function lastProjectUpdate(): CapturedBroadcast | undefined {
		// Find the latest projects-UPDATE broadcast on this team's room.
		const teamRoom = wsRoom.team(teamId);
		for (let i = captured.length - 1; i >= 0; i--) {
			const entry = captured[i];
			if (entry.room !== teamRoom) continue;
			if (entry.event.type !== WsMessageType.RowChange) continue;
			if (entry.event.table !== 'projects') continue;
			if (entry.event.action !== 'UPDATE') continue;
			return entry;
		}
		return undefined;
	}

	it('removing a container broadcasts a full project row with team_id', async () => {
		// The broadcast is what a client's project row refetches off, and its
		// `team_id` is what routes it to the right room. Rebuild used to be the
		// operator action that produced one; removal is now, and it must carry the
		// same shape or every open project page goes stale on the change an operator
		// just made.
		await ctx.db.query(
			"UPDATE projects SET container_id = 'stub-running', container_status = 'running'::container_status WHERE id = $1",
			[projectId],
		);
		await ctx.db.query(
			`INSERT INTO container_pool_members (project_id, container_id, state, disk_ceiling_bytes)
			 VALUES ($1, 'stub-running', 'idle', 1000000)`,
			[projectId],
		);

		captured.length = 0;

		const res = await ctx.app.request('/api/containers/stub-running', {
			method: 'DELETE',
			headers: authHeader(ctx.token),
		});
		expect(res.status).toBe(200);

		const update = lastProjectUpdate();
		expect(update).toBeDefined();
		const row = update?.event.row as Record<string, unknown>;
		expect(row.id).toBe(projectId);
		expect(row.team_id).toBe(teamId);
		// The project no longer names a container, because the one it named is gone.
		expect(row.container_id).toBeNull();
	});
});

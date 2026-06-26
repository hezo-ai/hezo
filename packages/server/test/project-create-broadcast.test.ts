import { WsMessageType, wsRoom } from '@hezo/shared';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { WebSocketManager, type WsEvent } from '../src/services/ws';
import { safeClose } from './helpers';
import { authHeader, createTestApp } from './helpers/app';

interface CapturedBroadcast {
	room: string;
	event: WsEvent;
}

// A project is created in a brand-new team whose `team:<id>` room no shell has
// joined yet, so the per-team `projects`-INSERT broadcast can't reach the rail.
// Creation must additionally signal the global project-index room so every
// connected shell refetches `/api/projects` and the project appears at once.
describe('project creation signals the global project-index room', () => {
	let ctx: Awaited<ReturnType<typeof createTestApp>>;
	let blankTemplateId: string;
	let captured: CapturedBroadcast[];
	let broadcastSpy: ReturnType<typeof vi.spyOn>;

	beforeAll(async () => {
		ctx = await createTestApp();
		const typesRes = await ctx.app.request('/api/team-templates', {
			headers: authHeader(ctx.token),
		});
		blankTemplateId = (await typesRes.json()).data.find(
			(t: { name: string }) => t.name === 'Blank',
		).id;

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

	it('broadcasts a no-payload ProjectsChanged signal to projects:global on create', async () => {
		captured.length = 0;

		const res = await ctx.app.request('/api/projects', {
			method: 'POST',
			headers: { ...authHeader(ctx.token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				name: 'Rail Signal Co',
				description: 'verifies the global rail signal',
				template_id: blankTemplateId,
			}),
		});
		expect(res.status).toBe(201);
		const project = (await res.json()).data;

		const signals = captured.filter(
			(c) => c.room === wsRoom.projects() && c.event.type === WsMessageType.ProjectsChanged,
		);
		expect(signals).toHaveLength(1);
		// No row data on the global room — the index is authorized per caller, so a
		// row here would leak a project a user can't see. Just the type.
		expect(Object.keys(signals[0].event)).toEqual(['type']);

		// The team-scoped INSERT still fires (regression guard) — it drives the
		// already-subscribed team members' other views; the global signal is what
		// reaches a shell that hasn't joined the new team's room.
		const teamInsert = captured.filter(
			(c) =>
				c.room === wsRoom.team(project.team_id) &&
				c.event.type === WsMessageType.RowChange &&
				c.event.table === 'projects' &&
				c.event.action === 'INSERT',
		);
		expect(teamInsert).toHaveLength(1);
	});
});

import { WsMessageType, wsRoom } from '@hezo/shared';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { WebSocketManager, type WsEvent } from '../src/services/ws';
import { safeClose } from './helpers';
import { authHeader, createTestApp, createTestProject, createTestTeam } from './helpers/app';
import { createGitHubSim, type GitHubSim } from './helpers/github-sim';

interface CapturedBroadcast {
	room: string;
	event: WsEvent;
}

/**
 * `mcp_connections` realtime broadcasts must carry `team_id` + `project_id`.
 *
 * The web client resolves the project slug whose caches a row_change
 * invalidates from `row.project_id` (falling back to `row.team_id`), so a
 * partial `{ id, status }` row resolves to nothing and is dropped client-side.
 * That is what left a reconnected connector's card showing "Needs reconnect"
 * until a page reload: the OAuth popup does the write, so this broadcast is the
 * open Connectors page's only other update channel.
 */
describe('mcp_connections realtime broadcasts carry team_id + project_id', () => {
	let ctx: Awaited<ReturnType<typeof createTestApp>>;
	let sim: GitHubSim;
	let teamId: string;
	let projectId: string;
	let projectSlug: string;
	let captured: CapturedBroadcast[];
	let broadcastSpy: ReturnType<typeof vi.spyOn>;
	let prevApi: string | undefined;
	let prevOAuth: string | undefined;
	const issuedToken = 'gho_broadcast_test_token';

	/** Every `mcp_connections` row this test's actions broadcast. */
	function connectorRows(): Record<string, unknown>[] {
		return captured
			.filter(
				(b) =>
					b.room === wsRoom.team(teamId) &&
					(b.event as { type: string; table?: string }).type === WsMessageType.RowChange &&
					(b.event as { table?: string }).table === 'mcp_connections',
			)
			.map((b) => (b.event as unknown as { row: Record<string, unknown> }).row);
	}

	beforeAll(async () => {
		sim = await createGitHubSim();
		prevApi = process.env.GITHUB_API_BASE_URL;
		prevOAuth = process.env.GITHUB_OAUTH_BASE_URL;
		process.env.GITHUB_API_BASE_URL = sim.baseUrl;
		process.env.GITHUB_OAUTH_BASE_URL = sim.baseUrl;
		sim.seed({
			token: issuedToken,
			user: { id: 11, login: 'octo-broadcast', avatar_url: 'http://av/o.png', email: 'o@e' },
			signingKeys: [],
			authKeys: [],
		});

		ctx = await createTestApp();

		const typesRes = await ctx.app.request('/api/team-templates', {
			headers: authHeader(ctx.token),
		});
		const typeId = (await typesRes.json()).data.find(
			(t: { name: string }) => t.name === 'App Team',
		).id;
		const teamRes = await createTestTeam(ctx.db, {
			name: 'Connector Realtime Co',
			template_id: typeId,
		});
		teamId = (await teamRes.json()).data.id;

		const projectRes = await createTestProject(ctx.db, teamId, { name: 'Connector Realtime' });
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
		broadcastSpy?.mockRestore();
		process.env.GITHUB_API_BASE_URL = prevApi;
		process.env.GITHUB_OAUTH_BASE_URL = prevOAuth;
		await sim.destroy();
		await safeClose(ctx.db);
	});

	it('stamps both ids on the create / api-key / revoke / delete broadcasts', async () => {
		captured = [];

		const createRes = await ctx.app.request(`/api/projects/${projectSlug}/connectors`, {
			method: 'POST',
			headers: { ...authHeader(ctx.token), 'Content-Type': 'application/json' },
			body: JSON.stringify({
				name: 'linear',
				kind: 'saas',
				config: { url: 'https://mcp.linear.example/mcp' },
			}),
		});
		expect(createRes.status).toBe(201);
		const connectorId = (await createRes.json()).data.id as string;

		// Attaching an API key is the non-OAuth way a connector goes active.
		const keyRes = await ctx.app.request(
			`/api/projects/${projectSlug}/connectors/${connectorId}/api-key`,
			{
				method: 'POST',
				headers: { ...authHeader(ctx.token), 'Content-Type': 'application/json' },
				body: JSON.stringify({ value: 'sk-test-value' }),
			},
		);
		expect(keyRes.status).toBe(200);

		const revokeRes = await ctx.app.request(
			`/api/projects/${projectSlug}/connectors/${connectorId}/revoke`,
			{ method: 'POST', headers: authHeader(ctx.token) },
		);
		expect(revokeRes.status).toBe(200);

		const deleteRes = await ctx.app.request(
			`/api/projects/${projectSlug}/connectors/${connectorId}`,
			{ method: 'DELETE', headers: authHeader(ctx.token) },
		);
		expect(deleteRes.status).toBe(200);

		const rows = connectorRows();
		expect(rows.length).toBe(4);
		for (const row of rows) {
			expect(row.team_id).toBe(teamId);
			expect(row.project_id).toBe(projectId);
		}
	});

	it('stamps both ids on the connection-completed broadcast the reconnect path emits', async () => {
		captured = [];

		const ensureRes = await ctx.app.request(`/api/projects/${projectSlug}/connectors/ensure`, {
			method: 'POST',
			headers: { ...authHeader(ctx.token), 'Content-Type': 'application/json' },
			body: JSON.stringify({ provider_id: 'github' }),
		});
		expect(ensureRes.status).toBe(200);
		const connectorId = (await ensureRes.json()).data.id as string;

		const startRes = await ctx.app.request(
			`/api/projects/${projectSlug}/connectors/${connectorId}/device/start`,
			{ method: 'POST', headers: { ...authHeader(ctx.token), 'Content-Type': 'application/json' } },
		);
		expect(startRes.status).toBe(200);
		const start = (await startRes.json()).data as { flow_id: string; user_code: string };

		sim.approveDeviceFlow(start.user_code, issuedToken);

		const pollRes = await ctx.app.request(
			`/api/projects/${projectSlug}/connectors/${connectorId}/device/poll`,
			{
				method: 'POST',
				headers: { ...authHeader(ctx.token), 'Content-Type': 'application/json' },
				body: JSON.stringify({ flow_id: start.flow_id }),
			},
		);
		expect(pollRes.status).toBe(200);

		// The `status: 'active'` row is the one the open Connectors page needs to
		// flip its card out of "Needs reconnect".
		const activated = connectorRows().find((row) => row.status === 'active');
		expect(activated).toBeDefined();
		expect(activated?.id).toBe(connectorId);
		expect(activated?.team_id).toBe(teamId);
		expect(activated?.project_id).toBe(projectId);
	});
});

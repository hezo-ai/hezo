import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ChatSessionManager } from '../src/services/chat-session-manager';
import { LogStreamBroker } from '../src/services/log-stream-broker';
import { WebSocketManager } from '../src/services/ws';
import { createStubDocker } from './helpers/app';
import { createTestContext, destroyTestContext, type ServerTestContext } from './helpers/context';

describe('chat channel + identity admin routes', () => {
	let ctx: ServerTestContext;
	let auth: Record<string, string>;

	beforeAll(async () => {
		ctx = await createTestContext();
		auth = { authorization: `Bearer ${ctx.token}`, 'content-type': 'application/json' };
	});
	afterAll(() => destroyTestContext(ctx));

	it('configures a channel, redacts the token, and toggles enablement', async () => {
		const put = await ctx.app.request('/api/chat/channels/telegram', {
			method: 'PUT',
			headers: auth,
			body: JSON.stringify({
				enabled: true,
				bot_token: 'secret-bot-token',
				metadata: { group_id: '-100' },
			}),
		});
		expect(put.status).toBe(200);

		const list = await ctx.app.request('/api/chat/channels', { headers: auth });
		const body = (await list.json()) as { data: { channels: Array<Record<string, unknown>> } };
		const tg = body.data.channels.find((ch) => ch.channel === 'telegram');
		expect(tg).toMatchObject({ enabled: true, has_token: true, has_webhook: true });
		// The raw token/secret are never returned.
		expect(JSON.stringify(tg)).not.toContain('secret-bot-token');
		expect(tg?.metadata).toMatchObject({ group_id: '-100' });

		// The bot token landed in the vault, encrypted, scoped to the platform host.
		const secret = await ctx.db.query<{ allowed_hosts: string[] }>(
			`SELECT allowed_hosts FROM secrets WHERE name = 'TELEGRAM_BOT_TOKEN'`,
		);
		expect(secret.rows[0].allowed_hosts).toContain('api.telegram.org');

		const del = await ctx.app.request('/api/chat/channels/telegram', {
			method: 'DELETE',
			headers: auth,
		});
		expect(del.status).toBe(200);
		const after = await ctx.db.query<{ enabled: boolean }>(
			`SELECT enabled FROM chat_channel_configs WHERE channel = 'telegram'`,
		);
		expect(after.rows[0].enabled).toBe(false);
	});

	it('stores both slack tokens in the vault and preserves them across re-saves', async () => {
		// enabled:false keeps the adapter offline — no slack.com traffic in tests.
		const put = await ctx.app.request('/api/chat/channels/slack', {
			method: 'PUT',
			headers: auth,
			body: JSON.stringify({
				enabled: false,
				bot_token: 'xoxb-secret',
				app_token: 'xapp-secret',
				metadata: { dm_mode_enabled: true, group_mode_enabled: true },
			}),
		});
		expect(put.status).toBe(200);
		const putBody = (await put.json()) as { data: Record<string, unknown> };
		expect(putBody.data).toMatchObject({ has_token: true, has_app_token: true });

		const list = await ctx.app.request('/api/chat/channels', { headers: auth });
		const body = (await list.json()) as { data: { channels: Array<Record<string, unknown>> } };
		const slack = body.data.channels.find((ch) => ch.channel === 'slack');
		expect(slack).toMatchObject({ enabled: false, has_token: true, has_app_token: true });
		// Raw tokens never come back.
		expect(JSON.stringify(slack)).not.toContain('xoxb-secret');
		expect(JSON.stringify(slack)).not.toContain('xapp-secret');
		expect(slack?.metadata).toMatchObject({ app_token_secret: 'SLACK_APP_TOKEN' });

		// Both tokens landed in the vault, scoped to slack.com.
		const secrets = await ctx.db.query<{ name: string; allowed_hosts: string[] }>(
			`SELECT name, allowed_hosts FROM secrets WHERE name IN ('SLACK_BOT_TOKEN', 'SLACK_APP_TOKEN') ORDER BY name`,
		);
		expect(secrets.rows.map((r) => r.name)).toEqual(['SLACK_APP_TOKEN', 'SLACK_BOT_TOKEN']);
		for (const row of secrets.rows) expect(row.allowed_hosts).toContain('slack.com');

		// A token-less re-save (metadata omitting the vault reference) keeps both
		// tokens: bot via the config column, app via the carried-forward reference.
		const resave = await ctx.app.request('/api/chat/channels/slack', {
			method: 'PUT',
			headers: auth,
			body: JSON.stringify({ enabled: false, metadata: { group_mode_enabled: false } }),
		});
		expect(resave.status).toBe(200);
		const after = await ctx.app.request('/api/chat/channels', { headers: auth });
		const afterBody = (await after.json()) as {
			data: { channels: Array<Record<string, unknown>> };
		};
		const slackAfter = afterBody.data.channels.find((ch) => ch.channel === 'slack');
		expect(slackAfter).toMatchObject({ has_token: true, has_app_token: true });
		expect(slackAfter?.metadata).toMatchObject({
			app_token_secret: 'SLACK_APP_TOKEN',
			group_mode_enabled: false,
		});
	});

	it('links, lists, and unlinks an external identity', async () => {
		const u = await ctx.db.query<{ id: string }>(
			`INSERT INTO users (display_name) VALUES ('Linked') RETURNING id`,
		);
		const create = await ctx.app.request('/api/chat/identities', {
			method: 'POST',
			headers: auth,
			body: JSON.stringify({ channel: 'telegram', external_user_id: '777', user_id: u.rows[0].id }),
		});
		expect(create.status).toBe(201);

		const list = await ctx.app.request('/api/chat/identities', { headers: auth });
		const body = (await list.json()) as { data: { identities: Array<Record<string, unknown>> } };
		const row = body.data.identities.find((i) => i.external_user_id === '777');
		expect(row).toMatchObject({ channel: 'telegram', user_id: u.rows[0].id });

		// A duplicate (channel, external_user_id) is a conflict.
		const dup = await ctx.app.request('/api/chat/identities', {
			method: 'POST',
			headers: auth,
			body: JSON.stringify({ channel: 'telegram', external_user_id: '777', user_id: u.rows[0].id }),
		});
		expect(dup.status).toBe(409);

		const del = await ctx.app.request(`/api/chat/identities/${row?.id}`, {
			method: 'DELETE',
			headers: auth,
		});
		expect(del.status).toBe(200);
	});

	it('rejects a non-admin', async () => {
		const res = await ctx.app.request('/api/chat/channels', {
			headers: { 'content-type': 'application/json' },
		});
		expect(res.status).toBe(401);
	});
});

describe('ChatSessionManager conversation lifecycle', () => {
	let ctx: ServerTestContext;
	let manager: ChatSessionManager;

	beforeAll(async () => {
		ctx = await createTestContext();
		const wsManager = new WebSocketManager();
		const logs = new LogStreamBroker();
		logs.setWsManager(wsManager);
		manager = new ChatSessionManager({
			db: ctx.db,
			docker: createStubDocker(),
			masterKeyManager: ctx.masterKeyManager,
			serverPort: 0,
			dataDir: ctx.dataDir,
			wsManager,
			logs,
		});
	});
	afterAll(() => destroyTestContext(ctx));

	it('creates, lists (open-only), and closes web threads', async () => {
		const defaultId = await manager.getConversationId();
		const a = await manager.createWebConversation('Thread A');
		const b = await manager.createWebConversation('Thread B');

		let open = await manager.listConversations();
		const ids = open.map((c) => c.id);
		expect(ids).toEqual(expect.arrayContaining([defaultId, a, b]));

		await manager.closeConversation(a);
		open = await manager.listConversations();
		expect(open.map((c) => c.id)).not.toContain(a);
		// Closed still visible when explicitly requested.
		const all = await manager.listConversations({ includeClosed: true });
		expect(all.map((c) => c.id)).toContain(a);

		// getConversation reflects the closed state.
		const closed = await manager.getConversation(a);
		expect(closed?.closed_at).not.toBeNull();
	});

	it('resolves the same default web thread each time', async () => {
		const first = await manager.getConversationId();
		const second = await manager.getConversationId();
		expect(first).toBe(second);
	});
});

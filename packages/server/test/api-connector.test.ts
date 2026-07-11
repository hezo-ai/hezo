import type { Hono } from 'hono';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { Db } from '../src/db/database';
import type { Env } from '../src/lib/types';
import {
	loadConnectorDescriptors,
	validateApiConnectorConfig,
} from '../src/services/connectors/connections';
import { safeClose } from './helpers';
import { authHeader, createTestApp, createTestProject, createTestTeam } from './helpers/app';

let app: Hono<Env>;
let db: Db;
let token: string;
let projectSlug: string;
let projectId: string;

beforeAll(async () => {
	const ctx = await createTestApp();
	app = ctx.app;
	db = ctx.db;
	token = ctx.token;

	const typesRes = await app.request('/api/team-templates', { headers: authHeader(token) });
	const typeId = (await typesRes.json()).data.find(
		(t: Record<string, unknown>) => t.name === 'Startup',
	).id;
	const teamData = (
		await (await createTestTeam(db, { name: 'Api Connector Co', template_id: typeId })).json()
	).data;
	const proj = (await (await createTestProject(db, teamData.id, { name: 'Api Proj' })).json()).data;
	projectSlug = proj.slug;
	projectId = proj.id;
});

afterAll(async () => {
	await safeClose(db);
});

beforeEach(async () => {
	await db.query('DELETE FROM mcp_connections');
	await db.query(`DELETE FROM secrets WHERE name LIKE 'MCP_%'`);
});

const VALID_API_CONFIG = {
	base_url: 'https://api.weather.example/v1',
	allowed_hosts: ['api.weather.example'],
	auth: { placement: 'header', name: 'Authorization', scheme: 'Bearer ' },
	docs_url: 'https://api.weather.example/docs',
};

describe('validateApiConnectorConfig', () => {
	it('accepts a valid config and normalizes hosts/strings', () => {
		const r = validateApiConnectorConfig({
			base_url: '  https://api.weather.example/v1  ',
			allowed_hosts: ['API.Weather.Example', 'api.weather.example'],
			auth: { placement: 'header', name: ' Authorization ', scheme: 'Bearer ' },
			docs_url: ' https://api.weather.example/docs ',
		});
		expect(r.ok).toBe(true);
		if (!r.ok) return;
		expect(r.config.base_url).toBe('https://api.weather.example/v1');
		// hosts lowercased + deduped
		expect(r.config.allowed_hosts).toEqual(['api.weather.example']);
		expect(r.config.auth.name).toBe('Authorization');
		expect(r.config.docs_url).toBe('https://api.weather.example/docs');
	});

	it('rejects a missing/invalid base_url', () => {
		expect(validateApiConnectorConfig({ allowed_hosts: ['x'], auth: {} }).ok).toBe(false);
		expect(
			validateApiConnectorConfig({ base_url: 'not a url', allowed_hosts: ['x'], auth: {} }).ok,
		).toBe(false);
	});

	it('rejects empty allowed_hosts', () => {
		const r = validateApiConnectorConfig({
			base_url: 'https://api.x.example',
			allowed_hosts: [],
			auth: { placement: 'header', name: 'Authorization' },
		});
		expect(r.ok).toBe(false);
	});

	it('rejects a bad auth placement or missing name', () => {
		expect(
			validateApiConnectorConfig({
				base_url: 'https://api.x.example',
				allowed_hosts: ['api.x.example'],
				auth: { placement: 'body', name: 'k' },
			}).ok,
		).toBe(false);
		expect(
			validateApiConnectorConfig({
				base_url: 'https://api.x.example',
				allowed_hosts: ['api.x.example'],
				auth: { placement: 'query', name: '' },
			}).ok,
		).toBe(false);
	});
});

describe('api connector routes', () => {
	async function createApiConnector(config: unknown = VALID_API_CONFIG) {
		return app.request(`/api/projects/${projectSlug}/connectors`, {
			method: 'POST',
			headers: { ...authHeader(token), 'content-type': 'application/json' },
			body: JSON.stringify({ name: 'weather', kind: 'api', config }),
		});
	}

	it('creates an api connector (installed, no MCP descriptor)', async () => {
		const res = await createApiConnector();
		expect(res.status).toBe(201);
		const row = (await res.json()).data;
		expect(row.kind).toBe('api');
		expect(row.install_status).toBe('installed');

		// api connectors are surfaced via list_connectors + egress only — never as an
		// MCP descriptor injected into a run.
		const descriptors = await loadConnectorDescriptors(db, projectId);
		expect(descriptors.find((d) => d.name === 'weather')).toBeUndefined();
	});

	it('rejects an invalid api config with 400', async () => {
		const res = await createApiConnector({ base_url: 'nope', allowed_hosts: [], auth: {} });
		expect(res.status).toBe(400);
	});

	it('attaches a credential and scopes the vault secret to the config allowed_hosts', async () => {
		const created = (await (await createApiConnector()).json()).data;
		const attach = await app.request(
			`/api/projects/${projectSlug}/connectors/${created.id}/api-key`,
			{
				method: 'POST',
				headers: { ...authHeader(token), 'content-type': 'application/json' },
				body: JSON.stringify({ value: 'super-secret-key' }),
			},
		);
		expect(attach.status).toBe(200);

		const conn = await db.query<{ api_key_secret_id: string | null }>(
			`SELECT api_key_secret_id FROM mcp_connections WHERE id = $1`,
			[created.id],
		);
		expect(conn.rows[0].api_key_secret_id).not.toBeNull();

		const secret = await db.query<{ allowed_hosts: string[]; allow_all_hosts: boolean }>(
			`SELECT allowed_hosts, allow_all_hosts FROM secrets WHERE id = $1`,
			[conn.rows[0].api_key_secret_id],
		);
		// Scoped to the connector's allowed_hosts (from config), never all hosts.
		expect(secret.rows[0].allowed_hosts).toEqual(['api.weather.example']);
		expect(secret.rows[0].allow_all_hosts).toBe(false);
	});
});

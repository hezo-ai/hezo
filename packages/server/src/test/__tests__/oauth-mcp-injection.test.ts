import type { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { MasterKeyManager } from '../../crypto/master-key';
import { loadMcpConnectionDescriptors } from '../../services/mcp-connections';
import { createConnection } from '../../services/oauth/connection-store';
import { safeClose } from '../helpers';
import { createTestApp } from '../helpers/app';

let db: PGlite;
let masterKeyManager: MasterKeyManager;
let companyId: string;
let projectId: string;

beforeAll(async () => {
	const ctx = await createTestApp();
	db = ctx.db;
	masterKeyManager = ctx.masterKeyManager;

	const company = await db.query<{ id: string }>(
		`INSERT INTO companies (name, slug) VALUES ('Mcp OAuth Co', 'mcp-oauth-co') RETURNING id`,
	);
	companyId = company.rows[0].id;

	const project = await db.query<{ id: string }>(
		`INSERT INTO projects (company_id, name, slug, issue_prefix) VALUES ($1, 'P', 'p', 'P') RETURNING id`,
		[companyId],
	);
	projectId = project.rows[0].id;
});

afterAll(async () => {
	await safeClose(db);
});

describe('mcp connection descriptor with oauth_connection_id', () => {
	it('emits Authorization: Bearer __HEZO_SECRET_OAUTH_<...>__ for SaaS MCPs linked to an OAuth connection', async () => {
		const conn = await createConnection(
			{ db, masterKeyManager },
			{
				companyId,
				provider: 'datocms',
				providerAccountId: 'workspace-1',
				providerAccountLabel: 'Acme Workspace',
				accessToken: 'real-secret-token-value',
				scopes: ['read', 'write'],
				allowedHosts: ['site-api.datocms.com'],
			},
		);

		await db.query(
			`INSERT INTO mcp_connections (company_id, project_id, name, kind, config, oauth_connection_id, install_status)
			 VALUES ($1, NULL, 'datocms', 'saas', $2::jsonb, $3, 'installed')`,
			[
				companyId,
				JSON.stringify({
					url: 'https://site-api.datocms.com/mcp',
					headers: { 'X-Custom': 'keep-me' },
				}),
				conn.id,
			],
		);

		const descriptors = await loadMcpConnectionDescriptors(db, companyId, projectId);
		const dato = descriptors.find((d) => d.name === 'datocms');
		expect(dato).toBeTruthy();
		if (dato?.kind !== 'http') throw new Error('expected http descriptor');
		expect(dato.headers?.Authorization).toBe(
			`Bearer ${conn.accessTokenSecretName}`.replace(
				conn.accessTokenSecretName,
				`__HEZO_SECRET_${conn.accessTokenSecretName}__`,
			),
		);
		expect(dato.headers?.['X-Custom']).toBe('keep-me');
		expect(dato.url).toBe('https://site-api.datocms.com/mcp');
		expect(JSON.stringify(dato)).not.toContain('real-secret-token-value');
	});

	it('overrides any user-provided Authorization header when oauth_connection_id is set', async () => {
		const conn = await createConnection(
			{ db, masterKeyManager },
			{
				companyId,
				provider: 'linear',
				providerAccountId: 'team-1',
				providerAccountLabel: 'Linear Team',
				accessToken: 'linear-token',
				scopes: ['read'],
				allowedHosts: ['api.linear.app'],
			},
		);

		await db.query(
			`INSERT INTO mcp_connections (company_id, project_id, name, kind, config, oauth_connection_id, install_status)
			 VALUES ($1, NULL, 'linear', 'saas', $2::jsonb, $3, 'installed')`,
			[
				companyId,
				JSON.stringify({
					url: 'https://api.linear.app/mcp',
					headers: { authorization: 'Bearer should-be-overridden' },
				}),
				conn.id,
			],
		);

		const descriptors = await loadMcpConnectionDescriptors(db, companyId, projectId);
		const linear = descriptors.find((d) => d.name === 'linear');
		if (linear?.kind !== 'http') throw new Error('expected http descriptor');
		expect(linear.headers?.authorization).toBeUndefined();
		expect(linear.headers?.Authorization).toBe(
			`Bearer __HEZO_SECRET_${conn.accessTokenSecretName}__`,
		);
	});

	it('preserves headers verbatim when oauth_connection_id is not set', async () => {
		await db.query(
			`INSERT INTO mcp_connections (company_id, project_id, name, kind, config, install_status)
			 VALUES ($1, NULL, 'plain', 'saas', $2::jsonb, 'installed')`,
			[
				companyId,
				JSON.stringify({
					url: 'https://example.com/mcp',
					headers: { authorization: 'Bearer __HEZO_SECRET_RAW_KEY__' },
				}),
			],
		);
		const descriptors = await loadMcpConnectionDescriptors(db, companyId, projectId);
		const plain = descriptors.find((d) => d.name === 'plain');
		if (plain?.kind !== 'http') throw new Error('expected http descriptor');
		expect(plain.headers?.authorization).toBe('Bearer __HEZO_SECRET_RAW_KEY__');
	});
});

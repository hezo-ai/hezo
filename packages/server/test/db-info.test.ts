import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { redactDatabaseUrl } from '../src/lib/db-info';
import { signAdminJwt } from '../src/middleware/auth';
import { buildApp } from '../src/startup';
import { safeClose } from './helpers';
import { authHeader, createTestApp } from './helpers/app';

describe('redactDatabaseUrl', () => {
	it('occludes username and password, keeps scheme/host/port/database', () => {
		const out = redactDatabaseUrl('postgres://alice:s3cret@db.example.com:5432/hezo');
		expect(out).toBe('postgres://••••:••••@db.example.com:5432/hezo');
	});

	it('never contains any credential fragment', () => {
		const out = redactDatabaseUrl(
			'postgresql://svc_user:p%40ssw0rd!@10.0.0.7:6543/prod?sslmode=require&password=oops&options=-csearch_path%3Dsecret',
		);
		for (const fragment of [
			'svc_user',
			'p%40ssw0rd',
			'p@ssw0rd',
			'oops',
			'search_path',
			'secret',
		]) {
			expect(out).not.toContain(fragment);
		}
		expect(out).toContain('10.0.0.7:6543');
		expect(out).toContain('/prod');
	});

	it('keeps only whitelisted query params (sslmode)', () => {
		const out = redactDatabaseUrl(
			'postgres://u:p@host/db?sslmode=verify-full&sslpassword=key&application_name=hezo',
		);
		expect(out).toBe('postgres://••••:••••@host/db?sslmode=verify-full');
	});

	it('omits the auth marker entirely when the URL carries no credentials', () => {
		expect(redactDatabaseUrl('postgres://host:5432/db')).toBe('postgres://host:5432/db');
	});

	it('occludes username-only URLs too', () => {
		const out = redactDatabaseUrl('postgres://alice@host/db');
		expect(out).toBe('postgres://••••:••••@host/db');
		expect(out).not.toContain('alice');
	});

	it('returns full occlusion for unparseable input instead of echoing fragments', () => {
		expect(redactDatabaseUrl('user:pass@not a url')).toBe('••••');
		expect(redactDatabaseUrl('')).toBe('••••');
	});
});

describe('GET /api/database-info', () => {
	let ctx: Awaited<ReturnType<typeof createTestApp>>;
	let nonSuperuserToken: string;

	beforeAll(async () => {
		ctx = await createTestApp();
		const plain = await ctx.db.query<{ id: string }>(
			"INSERT INTO users (display_name, is_superuser) VALUES ('Plain User', false) RETURNING id",
		);
		nonSuperuserToken = await signAdminJwt(ctx.masterKeyManager, plain.rows[0].id);
	});

	afterAll(async () => {
		await safeClose(ctx.db);
	});

	it('returns the embedded storage shape for a superuser', async () => {
		const res = await ctx.app.request('/api/database-info', { headers: authHeader(ctx.token) });
		expect(res.status).toBe(200);
		const { data } = await res.json();
		expect(data.backend).toBe('embedded');
		expect(data.display).toContain('pgdata');
		// Embedded mode carries no external server version.
		expect(data.server_version).toBeUndefined();
	});

	it('403s for a non-superuser', async () => {
		const res = await ctx.app.request('/api/database-info', {
			headers: authHeader(nonSuperuserToken),
		});
		expect(res.status).toBe(403);
	});

	it('passes the pre-redacted external shape through untouched', async () => {
		// The route reflects the StorageInfo computed (and redacted) at startup.
		// Build a sibling app over the same db/master-key with an external-shaped
		// AppConfig — the exact path startup wires — and read it back.
		const externalApp = buildApp(ctx.db, ctx.masterKeyManager, {
			dataDir: ctx.dataDir,
			webUrl: '',
			storageInfo: {
				backend: 'external',
				display: 'postgres://••••:••••@db.example.com:5432/hezo?sslmode=require',
				server_version: '16.4',
			},
		});
		const res = await externalApp.request('/api/database-info', {
			headers: authHeader(ctx.token),
		});
		expect(res.status).toBe(200);
		const { data } = await res.json();
		expect(data.backend).toBe('external');
		expect(data.display).toBe('postgres://••••:••••@db.example.com:5432/hezo?sslmode=require');
		expect(data.server_version).toBe('16.4');
	});
});

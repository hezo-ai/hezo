import type { PGlite } from '@electric-sql/pglite';
import { describe, expect, it } from 'vitest';
import { createMemoryDb } from '../src/db/client';
import { runMigrations } from '../src/db/migrate';
import { migration } from '../src/db/migrations/code/015_github_actions_toolset';
import { safeClose } from './helpers';

// Migration 015 retrofits already-connected `github` MCP rows with the
// X-MCP-Toolsets header (default toolsets + `actions`) so agents get the
// get_job_logs tool instead of hand-rolling curl to read CI logs. New
// connections receive the header from the capability at connect time, so this
// migration only has to cover rows that predate the change.

const MIGRATIONS = { '015_github_actions_toolset': migration };

// Minimal slice of the mcp_connections table the migration reads/writes.
async function createMcpTable(db: PGlite): Promise<void> {
	await db.exec(`
		CREATE TABLE mcp_connections (
			id TEXT PRIMARY KEY,
			name TEXT NOT NULL,
			kind TEXT NOT NULL,
			config JSONB NOT NULL,
			oauth_connection_id TEXT,
			updated_at TIMESTAMPTZ NOT NULL DEFAULT now()
		);
	`);
}

describe('migration 015: github actions toolset', () => {
	it('adds X-MCP-Toolsets (defaults + actions) to a bare github row, preserves url/oauth, ignores non-github rows', async () => {
		const db = await createMemoryDb();
		try {
			await createMcpTable(db);
			await db.query(
				`INSERT INTO mcp_connections (id, name, kind, config, oauth_connection_id)
				 VALUES ('g1', 'github', 'saas', $1::jsonb, 'oc-1')`,
				[JSON.stringify({ url: 'https://api.githubcopilot.com/mcp/' })],
			);
			// A different saas connector must be left completely untouched.
			await db.query(
				`INSERT INTO mcp_connections (id, name, kind, config)
				 VALUES ('d1', 'datocms', 'saas', $1::jsonb)`,
				[JSON.stringify({ url: 'https://mcp.datocms.com' })],
			);

			await runMigrations(db, MIGRATIONS);

			const gh = await db.query<{
				config: { url: string; headers?: Record<string, string> };
				oauth_connection_id: string;
			}>("SELECT config, oauth_connection_id FROM mcp_connections WHERE id = 'g1'");
			const toolsets = (gh.rows[0].config.headers?.['X-MCP-Toolsets'] ?? '').split(',');
			expect(toolsets).toContain('actions');
			expect(toolsets).toContain('pull_requests'); // PR ops must survive
			expect(gh.rows[0].config.url).toBe('https://api.githubcopilot.com/mcp/');
			expect(gh.rows[0].oauth_connection_id).toBe('oc-1');

			const dato = await db.query<{ config: { url: string; headers?: Record<string, string> } }>(
				"SELECT config FROM mcp_connections WHERE id = 'd1'",
			);
			expect(dato.rows[0].config.headers).toBeUndefined();
			expect(dato.rows[0].config.url).toBe('https://mcp.datocms.com');
		} finally {
			await safeClose(db);
		}
	});

	it('preserves operator-set headers and is idempotent when the transform re-runs', async () => {
		const db = await createMemoryDb();
		try {
			await createMcpTable(db);
			await db.query(
				`INSERT INTO mcp_connections (id, name, kind, config)
				 VALUES ('g1', 'github', 'saas', $1::jsonb)`,
				[
					JSON.stringify({
						url: 'https://api.githubcopilot.com/mcp/',
						headers: { 'X-Foo': 'bar' },
					}),
				],
			);

			await runMigrations(db, MIGRATIONS);
			// The runner records the migration as applied, so re-invoke the transform
			// directly to prove re-application is a no-op (no duplicated/changed value).
			await migration.run(db);

			const gh = await db.query<{ config: { headers: Record<string, string> } }>(
				"SELECT config FROM mcp_connections WHERE id = 'g1'",
			);
			expect(gh.rows[0].config.headers['X-Foo']).toBe('bar');
			expect(gh.rows[0].config.headers['X-MCP-Toolsets']).toBe(
				'context,repos,issues,pull_requests,users,copilot,actions',
			);
		} finally {
			await safeClose(db);
		}
	});
});

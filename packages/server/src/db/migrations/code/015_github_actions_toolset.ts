import type { CodeMigration } from '../../migrate';

/**
 * Enable the GitHub MCP `actions` toolset on already-connected `github` rows.
 *
 * The `github` connector snapshots the capability's bare
 * `https://api.githubcopilot.com/mcp/` URL into `config` at connect time and
 * carried no toolset header, so the remote server exposed only its default
 * toolsets. `get_job_logs` / `list_workflow_runs` live in the non-default
 * `actions` toolset and were therefore missing — leaving agents to hand-roll
 * `curl` to read CI logs.
 *
 * This rewrites every saas `github` connection to add the `X-MCP-Toolsets`
 * header (current default set + `actions`), preserving any operator-set headers,
 * the `url`, and the OAuth linkage. New connections receive the header from the
 * capability at connect time (see services/connectors/lifecycle.ts), so only
 * pre-existing rows need this. The transform is idempotent.
 */
const TOOLSETS = 'context,repos,issues,pull_requests,users,copilot,actions';

export const migration: CodeMigration = {
	checksum: 'github-actions-toolset-v1',
	run: async (db) => {
		const rows = await db.query<{ id: string; config: Record<string, unknown> | null }>(
			"SELECT id, config FROM mcp_connections WHERE kind = 'saas' AND name = 'github'",
		);
		for (const row of rows.rows) {
			const cfg = (row.config ?? {}) as { headers?: Record<string, string> } & Record<
				string,
				unknown
			>;
			const headers = { ...(cfg.headers ?? {}), 'X-MCP-Toolsets': TOOLSETS };
			const nextConfig = { ...cfg, headers };
			await db.query(
				'UPDATE mcp_connections SET config = $1::jsonb, updated_at = now() WHERE id = $2',
				[JSON.stringify(nextConfig), row.id],
			);
		}
	},
};

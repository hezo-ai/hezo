import type { PGlite } from '@electric-sql/pglite';
import { McpConnectionKind, type McpInstallStatus } from '@hezo/shared';
import { logger } from '../logger';
import type { McpDescriptor } from './mcp-injectors';

const log = logger.child('mcp-connections');

export interface SaasMcpConfig {
	url: string;
	headers?: Record<string, string>;
}

export interface LocalMcpConfig {
	command: string;
	args?: string[];
	env?: Record<string, string>;
	package?: string;
}

export type McpConnectionConfig = SaasMcpConfig | LocalMcpConfig;

export interface McpConnectionRow {
	id: string;
	company_id: string;
	project_id: string | null;
	name: string;
	kind: McpConnectionKind;
	config: McpConnectionConfig;
	install_status: McpInstallStatus;
	install_error: string | null;
	created_at: string;
	updated_at: string;
}

/**
 * Load MCP connections that should be exposed to the given agent run scope:
 * connections scoped to the project AND company-wide (project_id IS NULL)
 * connections, deduped by name with project-scoped winning.
 */
export async function loadMcpConnectionsForRun(
	db: PGlite,
	companyId: string,
	projectId: string,
): Promise<McpConnectionRow[]> {
	const result = await db.query<McpConnectionRow>(
		`SELECT id, company_id, project_id, name, kind::text AS kind,
		        config, install_status::text AS install_status, install_error,
		        created_at::text, updated_at::text
		 FROM mcp_connections
		 WHERE company_id = $1
		   AND (project_id IS NULL OR project_id = $2)
		 ORDER BY project_id NULLS FIRST`,
		[companyId, projectId],
	);

	const out = new Map<string, McpConnectionRow>();
	for (const row of result.rows) out.set(row.name, row);
	return [...out.values()];
}

/**
 * Map persisted connection rows into runtime descriptors. Local MCPs whose
 * install hasn't completed are skipped with a warning so the agent run still
 * proceeds — caller can call the installer separately to (re)try.
 */
export async function loadMcpConnectionDescriptors(
	db: PGlite,
	companyId: string,
	projectId: string,
): Promise<McpDescriptor[]> {
	const rows = await loadMcpConnectionsForRun(db, companyId, projectId);
	const descriptors: McpDescriptor[] = [];
	for (const row of rows) {
		if (row.kind === McpConnectionKind.Saas) {
			const config = row.config as SaasMcpConfig;
			if (!config?.url) {
				log.warn('skipping saas mcp connection with no url', { id: row.id, name: row.name });
				continue;
			}
			descriptors.push({
				kind: 'http',
				name: row.name,
				url: config.url,
				headers: config.headers,
			});
		} else if (row.kind === McpConnectionKind.Local) {
			if (row.install_status !== 'installed') {
				log.warn('skipping local mcp connection that is not installed', {
					id: row.id,
					name: row.name,
					status: row.install_status,
				});
				continue;
			}
			const config = row.config as LocalMcpConfig;
			if (!config?.command) {
				log.warn('skipping local mcp connection with no command', { id: row.id, name: row.name });
				continue;
			}
			descriptors.push({
				kind: 'stdio',
				name: row.name,
				command: config.command,
				args: config.args,
				env: config.env,
			});
		}
	}
	return descriptors;
}

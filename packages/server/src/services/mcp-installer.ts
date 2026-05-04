import type { PGlite } from '@electric-sql/pglite';
import { McpConnectionKind, McpInstallStatus } from '@hezo/shared';
import { logger } from '../logger';
import type { DockerClient } from './docker';
import type { LocalMcpConfig } from './mcp-connections';

const log = logger.child('mcp-installer');

const INSTALL_ROOT = '/workspace/.hezo/mcp';
const INSTALL_TIMEOUT_MS = 5 * 60 * 1000;

export interface InstallResult {
	id: string;
	name: string;
	status: McpInstallStatus;
	error?: string;
}

interface PendingRow {
	id: string;
	name: string;
	config: LocalMcpConfig;
}

export interface InstallerDeps {
	db: PGlite;
	docker: DockerClient;
	containerId: string;
	companyId: string;
	projectId: string;
	emit?: (stream: 'stdout' | 'stderr', text: string) => void;
}

/**
 * Install (or reinstall) every `kind='local'` mcp_connection scoped to the
 * given company+project that is not already `installed`. Idempotent: rows
 * already in `installed` are skipped, and the installer can be re-run after
 * a transient failure to retry.
 *
 * Each pending row's `config.package` is the npm spec the installer runs
 * `npm install --prefix <INSTALL_ROOT>/<name>` against. Rows without a
 * `package` field are marked installed (the operator is providing the
 * binary themselves — bind-mount, baked-into-image, etc.).
 */
export async function installPendingLocalMcps(deps: InstallerDeps): Promise<InstallResult[]> {
	const pending = await loadPending(deps);
	const results: InstallResult[] = [];
	for (const row of pending) {
		results.push(await installOne(deps, row));
	}
	return results;
}

/**
 * Install a single row by id. Used after `add_mcp_connection` to make the
 * MCP usable for the next agent run without waiting for the next provision
 * cycle. Returns the post-install row state.
 */
export async function installLocalMcpById(
	deps: InstallerDeps,
	rowId: string,
): Promise<InstallResult | null> {
	const result = await deps.db.query<PendingRow & { kind: string; install_status: string }>(
		`SELECT id, name, kind::text AS kind, config, install_status::text AS install_status
		 FROM mcp_connections
		 WHERE id = $1 AND company_id = $2`,
		[rowId, deps.companyId],
	);
	const row = result.rows[0];
	if (!row || row.kind !== McpConnectionKind.Local) return null;
	return installOne(deps, { id: row.id, name: row.name, config: row.config });
}

async function loadPending(deps: InstallerDeps): Promise<PendingRow[]> {
	const result = await deps.db.query<PendingRow>(
		`SELECT id, name, config
		 FROM mcp_connections
		 WHERE company_id = $1
		   AND kind = $2::mcp_connection_kind
		   AND install_status <> $3::mcp_install_status
		   AND (project_id IS NULL OR project_id = $4)`,
		[deps.companyId, McpConnectionKind.Local, McpInstallStatus.Installed, deps.projectId],
	);
	return result.rows;
}

async function installOne(deps: InstallerDeps, row: PendingRow): Promise<InstallResult> {
	const config = row.config ?? {};
	const pkg = typeof config.package === 'string' ? config.package.trim() : '';

	if (!pkg) {
		// No package to install — operator is providing the binary directly.
		await markStatus(deps.db, row.id, McpInstallStatus.Installed, null);
		return { id: row.id, name: row.name, status: McpInstallStatus.Installed };
	}

	if (!isSafePackageName(pkg)) {
		const reason = `unsafe package name: ${pkg}`;
		await markStatus(deps.db, row.id, McpInstallStatus.Failed, reason);
		return { id: row.id, name: row.name, status: McpInstallStatus.Failed, error: reason };
	}

	if (!isSafeName(row.name)) {
		const reason = `unsafe connection name: ${row.name}`;
		await markStatus(deps.db, row.id, McpInstallStatus.Failed, reason);
		return { id: row.id, name: row.name, status: McpInstallStatus.Failed, error: reason };
	}

	const dir = `${INSTALL_ROOT}/${row.name}`;
	deps.emit?.('stdout', `→ Installing MCP "${row.name}" (${pkg}) to ${dir}\n`);
	log.info('installing local mcp', { id: row.id, name: row.name, pkg });

	try {
		const exec = await deps.docker.execCreate(deps.containerId, {
			Cmd: [
				'sh',
				'-c',
				`mkdir -p ${shQuote(dir)} && cd ${shQuote(dir)} && npm install --no-audit --no-fund --silent ${shQuote(pkg)} 2>&1`,
			],
			AttachStdout: true,
			AttachStderr: true,
		});

		const { stdout, stderr } = await runWithTimeout(deps, exec, INSTALL_TIMEOUT_MS);
		const info = await deps.docker.execInspect(exec);
		if (info.ExitCode !== 0) {
			const tail = `${stdout}\n${stderr}`.trim().slice(-1000);
			const reason = `npm install exited ${info.ExitCode}: ${tail}`;
			deps.emit?.('stderr', `✗ MCP "${row.name}" install failed (exit ${info.ExitCode})\n`);
			await markStatus(deps.db, row.id, McpInstallStatus.Failed, reason);
			return { id: row.id, name: row.name, status: McpInstallStatus.Failed, error: reason };
		}
		deps.emit?.('stdout', `✓ MCP "${row.name}" installed\n`);
		await markStatus(deps.db, row.id, McpInstallStatus.Installed, null);
		return { id: row.id, name: row.name, status: McpInstallStatus.Installed };
	} catch (e) {
		const reason = e instanceof Error ? e.message : String(e);
		deps.emit?.('stderr', `✗ MCP "${row.name}" install errored: ${reason}\n`);
		await markStatus(deps.db, row.id, McpInstallStatus.Failed, reason);
		return { id: row.id, name: row.name, status: McpInstallStatus.Failed, error: reason };
	}
}

async function runWithTimeout(
	deps: InstallerDeps,
	execId: string,
	timeoutMs: number,
): Promise<{ stdout: string; stderr: string }> {
	const ac = new AbortController();
	const timer = setTimeout(() => ac.abort(), timeoutMs);
	try {
		return await deps.docker.execStart(execId, { signal: ac.signal });
	} finally {
		clearTimeout(timer);
	}
}

async function markStatus(
	db: PGlite,
	id: string,
	status: McpInstallStatus,
	error: string | null,
): Promise<void> {
	await db.query(
		`UPDATE mcp_connections
		 SET install_status = $1::mcp_install_status,
		     install_error = $2,
		     updated_at = now()
		 WHERE id = $3`,
		[status, error, id],
	);
}

function isSafeName(name: string): boolean {
	return /^[A-Za-z0-9_-][A-Za-z0-9_.-]*$/.test(name) && name.length <= 64;
}

function isSafePackageName(pkg: string): boolean {
	// Conservative: matches npm-style names plus optional version suffix.
	// Disallows shell metacharacters.
	return /^(@?[A-Za-z0-9._~/-]+)(@[A-Za-z0-9.~^*<>=-]+)?$/.test(pkg) && pkg.length <= 200;
}

function shQuote(value: string): string {
	return `'${value.replace(/'/g, `'\\''`)}'`;
}

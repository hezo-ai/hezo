import type { PGlite } from '@electric-sql/pglite';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { DockerClient } from '../../services/docker';
import { installLocalMcpById, installPendingLocalMcps } from '../../services/mcp-installer';
import { safeClose } from '../helpers';
import { createTestApp } from '../helpers/app';

let db: PGlite;
let companyId: string;
let projectId: string;

interface DockerCall {
	cmd: string[];
}

function makeFakeDocker(opts: {
	exitCode?: number;
	stdout?: string;
	stderr?: string;
	throwOnExec?: boolean;
}): { docker: DockerClient; calls: DockerCall[] } {
	const calls: DockerCall[] = [];
	const docker = {
		execCreate: async (_id: string, cfg: { Cmd: string[] }): Promise<string> => {
			calls.push({ cmd: cfg.Cmd });
			if (opts.throwOnExec) throw new Error('exec failed');
			return 'exec-id';
		},
		execStart: async () => ({
			stdout: opts.stdout ?? '',
			stderr: opts.stderr ?? '',
		}),
		execInspect: async () => ({
			ExitCode: opts.exitCode ?? 0,
			Running: false,
			Pid: 0,
		}),
	} as unknown as DockerClient;
	return { docker, calls };
}

beforeAll(async () => {
	const ctx = await createTestApp();
	db = ctx.db;

	const co = await ctx.app.request('/api/companies', {
		method: 'POST',
		headers: { Authorization: `Bearer ${ctx.token}`, 'Content-Type': 'application/json' },
		body: JSON.stringify({ name: 'Inst' }),
	});
	companyId = (await co.json()).data.id;
	const proj = await db.query<{ id: string }>(
		`INSERT INTO projects (company_id, name, slug, issue_prefix, docker_base_image)
		 VALUES ($1, 'P', 'p', 'P', 'hezo/agent-base:latest') RETURNING id`,
		[companyId],
	);
	projectId = proj.rows[0].id;
});

afterAll(async () => {
	await safeClose(db);
});

describe('installPendingLocalMcps', () => {
	it('installs a row whose package npm-installs successfully and marks status=installed', async () => {
		const { id } = (
			await db.query<{ id: string }>(
				`INSERT INTO mcp_connections (company_id, project_id, name, kind, config, install_status)
				 VALUES ($1, NULL, 'fs-ok', 'local', $2::jsonb, 'pending') RETURNING id`,
				[
					companyId,
					JSON.stringify({
						command: '/workspace/.hezo/mcp/fs-ok/node_modules/.bin/server-filesystem',
						args: ['/workspace'],
						package: '@modelcontextprotocol/server-filesystem',
					}),
				],
			)
		).rows[0];

		const { docker, calls } = makeFakeDocker({ exitCode: 0 });
		const results = await installPendingLocalMcps({
			db,
			docker,
			containerId: 'c',
			companyId,
			projectId,
		});
		const result = results.find((r) => r.id === id);
		expect(result?.status).toBe('installed');
		// The exec command bundles npm install into a sh -c so cd + mkdir
		// can sequence; the package name should appear quoted
		const npmCall = calls.find((c) => c.cmd[2]?.includes('npm install'));
		expect(npmCall?.cmd[2]).toContain('@modelcontextprotocol/server-filesystem');
		expect(npmCall?.cmd[2]).toContain('/workspace/.hezo/mcp/fs-ok');

		const after = await db.query<{ install_status: string }>(
			`SELECT install_status::text AS install_status FROM mcp_connections WHERE id = $1`,
			[id],
		);
		expect(after.rows[0].install_status).toBe('installed');
	});

	it('marks status=failed with the npm exit-code message when install exits non-zero', async () => {
		const { id } = (
			await db.query<{ id: string }>(
				`INSERT INTO mcp_connections (company_id, project_id, name, kind, config, install_status)
				 VALUES ($1, NULL, 'fs-bad', 'local', $2::jsonb, 'pending') RETURNING id`,
				[companyId, JSON.stringify({ command: 'x', package: 'no-such-pkg-xyz-99999' })],
			)
		).rows[0];

		const { docker } = makeFakeDocker({
			exitCode: 1,
			stderr: 'npm ERR! 404 Not Found',
		});
		const results = await installPendingLocalMcps({
			db,
			docker,
			containerId: 'c',
			companyId,
			projectId,
		});
		const result = results.find((r) => r.id === id);
		expect(result?.status).toBe('failed');
		expect(result?.error).toContain('exited 1');
		expect(result?.error).toContain('404 Not Found');

		const after = await db.query<{ install_status: string; install_error: string }>(
			`SELECT install_status::text AS install_status, install_error FROM mcp_connections WHERE id = $1`,
			[id],
		);
		expect(after.rows[0].install_status).toBe('failed');
		expect(after.rows[0].install_error).toContain('404 Not Found');
	});

	it('rejects shell-injection package names without invoking npm', async () => {
		const { id } = (
			await db.query<{ id: string }>(
				`INSERT INTO mcp_connections (company_id, project_id, name, kind, config, install_status)
				 VALUES ($1, NULL, 'evil-pkg', 'local', $2::jsonb, 'pending') RETURNING id`,
				[companyId, JSON.stringify({ command: 'x', package: 'good-pkg; rm -rf /' })],
			)
		).rows[0];

		const { docker, calls } = makeFakeDocker({ exitCode: 0 });
		const results = await installPendingLocalMcps({
			db,
			docker,
			containerId: 'c',
			companyId,
			projectId,
		});
		const result = results.find((r) => r.id === id);
		expect(result?.status).toBe('failed');
		expect(result?.error).toMatch(/unsafe package name/);
		// No exec call was made for this row
		expect(calls.some((c) => c.cmd[2]?.includes('rm -rf'))).toBe(false);
	});

	it('marks rows with no package as installed (operator-provided binary)', async () => {
		const { id } = (
			await db.query<{ id: string }>(
				`INSERT INTO mcp_connections (company_id, project_id, name, kind, config, install_status)
				 VALUES ($1, NULL, 'bring-your-own', 'local', $2::jsonb, 'pending') RETURNING id`,
				[companyId, JSON.stringify({ command: '/usr/local/bin/already-here' })],
			)
		).rows[0];

		const { docker, calls } = makeFakeDocker({ exitCode: 0 });
		const results = await installPendingLocalMcps({
			db,
			docker,
			containerId: 'c',
			companyId,
			projectId,
		});
		const result = results.find((r) => r.id === id);
		expect(result?.status).toBe('installed');
		// No exec call because there's no npm package to install
		expect(calls.find((c) => c.cmd[2]?.includes('npm install'))).toBeUndefined();
	});

	it('skips rows already in installed status (idempotent)', async () => {
		await db.query(
			`INSERT INTO mcp_connections (company_id, project_id, name, kind, config, install_status)
			 VALUES ($1, NULL, 'already-done', 'local', $2::jsonb, 'installed')`,
			[companyId, JSON.stringify({ command: '/x', package: 'foo' })],
		);

		const { docker, calls } = makeFakeDocker({ exitCode: 0 });
		const results = await installPendingLocalMcps({
			db,
			docker,
			containerId: 'c',
			companyId,
			projectId,
		});
		expect(results.find((r) => r.name === 'already-done')).toBeUndefined();
		expect(calls.find((c) => c.cmd[2]?.includes('already-done'))).toBeUndefined();
	});
});

describe('installLocalMcpById', () => {
	it('installs only the requested row', async () => {
		const { id } = (
			await db.query<{ id: string }>(
				`INSERT INTO mcp_connections (company_id, project_id, name, kind, config, install_status)
				 VALUES ($1, NULL, 'single', 'local', $2::jsonb, 'pending') RETURNING id`,
				[companyId, JSON.stringify({ command: '/x', package: 'pkg' })],
			)
		).rows[0];

		const { docker } = makeFakeDocker({ exitCode: 0 });
		const result = await installLocalMcpById(
			{ db, docker, containerId: 'c', companyId, projectId },
			id,
		);
		expect(result?.status).toBe('installed');
	});

	it("returns null for an id that doesn't belong to the company", async () => {
		const { docker } = makeFakeDocker({ exitCode: 0 });
		const result = await installLocalMcpById(
			{ db, docker, containerId: 'c', companyId, projectId },
			'00000000-0000-0000-0000-000000000000',
		);
		expect(result).toBeNull();
	});
});

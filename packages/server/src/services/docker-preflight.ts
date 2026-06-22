import { existsSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import type { DockerClient } from './docker';

/**
 * Canonical Docker install page, shown to operators when Docker is missing.
 * Covers Docker Engine (Linux), Docker Desktop (macOS/Windows), and the
 * post-install steps for starting the daemon.
 */
export const DOCKER_INSTALL_URL = 'https://docs.docker.com/get-docker/';

/**
 * Outcome of the startup Docker check:
 * - `ok`            — the daemon answered a ping; Hezo can run agents.
 * - `not-installed` — no `docker` executable on PATH and the socket is dead.
 * - `not-running`   — `docker` is installed but the daemon isn't reachable.
 */
export type DockerAvailability = 'ok' | 'not-installed' | 'not-running';

export interface DockerPreflightProbes {
	/** Resolves true when the Docker daemon answers a ping over its socket. */
	ping: () => Promise<boolean>;
	/** Resolves true when a `docker` executable is present on PATH. */
	binaryInstalled: () => boolean | Promise<boolean>;
}

/**
 * Decide Docker availability from two independent probes. The daemon ping is
 * the authoritative "can Hezo actually use Docker" signal; the binary probe
 * only disambiguates *why* a failed ping happened so we can show the right
 * guidance ("install it" vs "start it"). It is never used as a gate on its own.
 */
export async function checkDockerAvailability(
	probes: DockerPreflightProbes,
): Promise<DockerAvailability> {
	if (await probes.ping()) return 'ok';
	return (await probes.binaryInstalled()) ? 'not-running' : 'not-installed';
}

/**
 * Manual PATH scan for a `docker` executable. Used as the fallback when
 * `Bun.which` is unavailable (i.e. under Node/vitest). Pure and deterministic
 * given an `env`, so the preflight decision stays testable off the Bun runtime.
 */
export function dockerBinaryOnPath(env: NodeJS.ProcessEnv = process.env): boolean {
	const candidates = process.platform === 'win32' ? ['docker.exe', 'docker'] : ['docker'];
	const dirs = (env.PATH ?? '').split(delimiter).filter(Boolean);
	return dirs.some((dir) => candidates.some((name) => existsSync(join(dir, name))));
}

/**
 * Whether a `docker` executable is installed. Prefers Bun's native PATH
 * resolver in production; falls back to a manual scan under Node.
 */
export function dockerBinaryInstalled(env: NodeJS.ProcessEnv = process.env): boolean {
	const bunWhich = (globalThis as { Bun?: { which?: (cmd: string) => string | null } }).Bun?.which;
	if (typeof bunWhich === 'function') return bunWhich('docker') !== null;
	return dockerBinaryOnPath(env);
}

/**
 * Wire the real probes — the Docker client's socket ping plus a binary-on-PATH
 * check — and report availability. Callers gate startup on an `ok` result.
 */
export async function evaluateDockerPreflight(
	docker: Pick<DockerClient, 'ping'>,
	env: NodeJS.ProcessEnv = process.env,
): Promise<DockerAvailability> {
	return checkDockerAvailability({
		ping: () => docker.ping(),
		binaryInstalled: () => dockerBinaryInstalled(env),
	});
}

/**
 * Human-facing guidance for a non-`ok` preflight result, printed to the log
 * right before the server exits. Includes the install link for the
 * not-installed case and start instructions for the not-running case.
 */
export function formatDockerPreflightMessage(status: Exclude<DockerAvailability, 'ok'>): string {
	if (status === 'not-installed') {
		return [
			'Docker is required to run Hezo, but it does not appear to be installed.',
			'',
			"Hezo runs each project's agents in an isolated Docker container, so a working",
			'Docker installation is required. Install Docker, then start Hezo again:',
			'',
			`  ${DOCKER_INSTALL_URL}`,
			'',
			'For development without Docker (agents run in a no-op stub) set HEZO_SKIP_DOCKER=1.',
		].join('\n');
	}
	return [
		'Docker is installed but the Docker daemon is not reachable.',
		'',
		"Hezo runs each project's agents in an isolated Docker container, so the Docker",
		'daemon must be running. Start Docker Desktop, or on Linux run',
		'`sudo systemctl start docker`, then start Hezo again.',
		'',
		'If you just installed Docker, its docs cover starting it and post-install setup:',
		`  ${DOCKER_INSTALL_URL}`,
		'',
		'For development without Docker (agents run in a no-op stub) set HEZO_SKIP_DOCKER=1.',
	].join('\n');
}

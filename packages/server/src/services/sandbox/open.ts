import {
	isSandboxBackendName,
	redactSandboxApiUrl,
	type SandboxBackendInfo,
	type SandboxBackendName,
} from '../../lib/sandbox-backend-info';
import { logger } from '../../logger';
import { DockerClient } from '../docker';
import { DaytonaClient, DEFAULT_DAYTONA_API_URL } from './daytona/client';
import { DaytonaEngine } from './daytona/engine';
import { SandboxBackendError } from './errors';
import type { ContainerEngine } from './types';

const log = logger.child('sandbox-backend');

/** Preflight retry backoff - a briefly-restarting endpoint shouldn't kill startup. */
const CONNECT_RETRY_DELAYS_MS = [2000, 4000];

export interface OpenSandboxBackendOptions {
	/** `docker` (default) or a managed provider. */
	backend?: string;
	daytonaApiKey?: string;
	daytonaApiUrl?: string;
	/** Test hook: overrides the preflight retry backoff. */
	retryDelaysMs?: number[];
}

export interface OpenedSandboxBackend {
	engine: ContainerEngine;
	/** Pre-redacted metadata, safe to expose to the settings endpoint. */
	info: SandboxBackendInfo;
}

/**
 * Select and open the container engine - the single place one is constructed at
 * startup, mirroring `openDatabase` and `openAssetStorage`. Application code
 * depends only on `ContainerEngine`; the API key stops here, redacted into
 * `info` before anything else sees it.
 *
 * The contract those two already establish, and which this follows exactly:
 * no configuration means the local default, configuration present means the
 * managed driver plus a preflight, and a preflight that keeps failing is
 * **fatal**. There is deliberately no fallback to Docker - see
 * `SandboxBackendError`.
 */
export async function openSandboxBackend(
	options: OpenSandboxBackendOptions = {},
): Promise<OpenedSandboxBackend> {
	const name = resolveBackendName(options.backend);

	if (name === 'docker') {
		// No preflight here: the daemon gate already ran in `index.ts`, before the
		// server booted, so it could print install/start guidance rather than a
		// generic connection error.
		return {
			engine: new DockerClient(),
			info: { backend: 'docker', display: 'local Docker daemon' },
		};
	}

	const apiUrl = options.daytonaApiUrl || DEFAULT_DAYTONA_API_URL;
	const redacted = redactSandboxApiUrl(apiUrl);
	if (!options.daytonaApiKey) {
		// Caught before any network call: a missing key is a configuration
		// mistake, and reporting it as an unreachable API would send the operator
		// looking at the wrong thing.
		throw new SandboxBackendError(
			'The Daytona sandbox backend is selected but no API key is configured.\n' +
				'Set --daytona-api-key / HEZO_DAYTONA_API_KEY, or drop ' +
				'--sandbox-backend / HEZO_SANDBOX_BACKEND to run containers on local Docker.',
		);
	}

	const client = new DaytonaClient(options.daytonaApiKey, apiUrl);
	const delays = options.retryDelaysMs ?? CONNECT_RETRY_DELAYS_MS;
	for (let attempt = 0; ; attempt++) {
		if (await client.ping()) break;
		if (attempt < delays.length) {
			log.warn(
				`Daytona preflight failed (attempt ${attempt + 1}/${delays.length + 1}), retrying in ${delays[attempt]}ms...`,
			);
			await new Promise((resolve) => setTimeout(resolve, delays[attempt]));
			continue;
		}
		throw new SandboxBackendError(
			`Cannot reach the configured Daytona API at ${redacted}.\n` +
				'Check that --daytona-api-key / HEZO_DAYTONA_API_KEY is valid and not expired, that ' +
				'the key carries the sandbox permission scopes, and that --daytona-api-url / ' +
				'HEZO_DAYTONA_API_URL points at the right region. ' +
				'Drop --sandbox-backend / HEZO_SANDBOX_BACKEND to run containers on local Docker.',
		);
	}

	log.info(`Sandbox backend: Daytona (${redacted})`);
	return {
		engine: new DaytonaEngine(client),
		info: { backend: 'daytona', display: redacted },
	};
}

function resolveBackendName(raw?: string): SandboxBackendName {
	if (!raw) return 'docker';
	const value = raw.trim().toLowerCase();
	if (!isSandboxBackendName(value)) {
		throw new SandboxBackendError(
			`Unknown sandbox backend "${raw}".\n` +
				'Set --sandbox-backend / HEZO_SANDBOX_BACKEND to one of: docker, daytona.',
		);
	}
	return value;
}

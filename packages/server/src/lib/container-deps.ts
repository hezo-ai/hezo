import type { Context } from 'hono';
import type { ContainerDeps } from '../services/containers';
import type { Env } from './types';

/**
 * The container services, assembled from the request context.
 *
 * Extracted the moment a second route group needed it: the project routes and
 * the global container routes both drive `services/containers`, and a
 * hand-rolled second copy would differ in exactly the field nobody notices - an
 * omitted `logs` gives a container that provisions with no visible output, an
 * omitted `wsManager` one whose state change never reaches a client. Neither
 * fails; both just quietly do less.
 */
export function buildContainerDeps(c: Context<Env>): ContainerDeps {
	return {
		db: c.get('db'),
		docker: c.get('docker'),
		dataDir: c.get('dataDir'),
		wsManager: c.get('wsManager'),
		masterKeyManager: c.get('masterKeyManager'),
		logs: c.get('logs'),
		containerLogStreamer: c.get('containerLogStreamer'),
		sshAgentServer: c.get('sshAgentServer'),
		egressCAPath: c.get('egressProxy')?.caCertPath ?? null,
	};
}

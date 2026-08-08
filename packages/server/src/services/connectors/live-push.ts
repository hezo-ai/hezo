import type { Db } from '../../db/database';
import { logger } from '../../logger';
import type { ContainerEngine } from '../docker';

const log = logger.child('connector-live-push');

export interface LivePushDeps {
	db: Db;
	docker: ContainerEngine;
}

export interface LivePushInput {
	teamId: string;
	connectorId: string;
	/**
	 * Task whose container should pick up the connector ASAP. With the current
	 * agent runtime this is a no-op because each agent run boots a fresh
	 * per-heartbeat home dir and the injector writes adapter configs from
	 * scratch on every run — so the CredentialProvided wakeup that fires
	 * after a connector activates triggers a new run that naturally sees the
	 * new MCP. Kept as a parameter for forward compatibility if Hezo ever
	 * moves to long-lived per-task adapter processes that need explicit
	 * config reloads.
	 */
	syncTaskId?: string | null;
}

/**
 * No-op today. Cross-project propagation happens structurally:
 *
 * 1. Connector activation writes the row to `mcp_connections`.
 * 2. Every subsequent agent run (any project) calls the injector which
 *    reads from `mcp_connections` and writes per-adapter config files for
 *    that run's fresh home dir (`services/agent-runner.ts` → `mcp_injection`).
 * 3. The CredentialProvided wakeup on the calling task starts a new run via
 *    the normal wakeup pipeline, picking up the new connector.
 *
 * If Hezo ever moves to long-lived adapter processes inside per-team or
 * per-project containers, this is where we'd `docker exec` an adapter-config
 * reload. For now the runtime model handles propagation for free.
 */
export async function pushConnectorToTeamContainers(
	_deps: LivePushDeps,
	input: LivePushInput,
): Promise<void> {
	log.debug('connector activated; new runs will pick it up via the injector', input);
}

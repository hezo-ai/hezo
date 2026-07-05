import type { AuthType } from '@hezo/shared';
import type { MasterKeyManager } from '../crypto/master-key';
import type { Db } from '../db/database';
import type { DomainEventBus } from '../events/bus';
import type { AuthChallengeStore } from '../services/auth-challenges';
import type { CeoSessionManager } from '../services/ceo-session-manager';
import type { ContainerLogStreamer } from '../services/container-logs';
import type { DockerClient } from '../services/docker';
import type { EgressProxy } from '../services/egress';
import type { JobManager } from '../services/job-manager';
import type { LogStreamBroker } from '../services/log-stream-broker';
import type { PricingService } from '../services/pricing';
import type { SshAgentServer } from '../services/ssh-agent';
import type { WebSocketManager } from '../services/ws';

export type AuthInfo =
	| { type: typeof AuthType.Admin; userId: string; isSuperuser: boolean }
	| {
			/**
			 * An approved API key (see `api_keys`) — the instance-scoped MCP credential.
			 * It is admin-equivalent for data access: `isSuperuser`/`crossTeam` are literal
			 * `true` so it flows through the existing superuser/cross-team branches in
			 * `assertTeamAccess`/`getAccessibleTeamIds`/MCP tools — but it is deliberately
			 * NOT an `Admin`, so `requireSuperuser` still excludes it from minting,
			 * approving, or revoking keys. A `pending` key never reaches here (auth rejects
			 * it), so any principal of this type is already approved.
			 */
			type: typeof AuthType.ApiKey;
			apiKeyId: string;
			isSuperuser: true;
			crossTeam: true;
	  }
	| {
			type: typeof AuthType.Agent;
			memberId: string;
			teamId: string;
			/** The heartbeat run this token is bound to; null for a CEO chat session principal. */
			runId: string | null;
			taskId: string | null;
			projectId: string;
			crossProject: boolean;
			/** Set for a persistent CEO chat session token (validated against ceo_sessions). */
			sessionId?: string;
			/** Instance CEO session: may act across teams (the team-level analogue of crossProject). */
			crossTeam?: boolean;
	  };

export type Env = {
	Variables: {
		db: Db;
		masterKeyManager: MasterKeyManager;
		authChallenges: AuthChallengeStore;
		docker: DockerClient;
		wsManager: WebSocketManager;
		events: DomainEventBus;
		jobManager: JobManager;
		ceoSessionManager?: CeoSessionManager;
		logs: LogStreamBroker;
		containerLogStreamer: ContainerLogStreamer;
		auth: AuthInfo;
		dataDir: string;
		webUrl: string;
		sshAgentServer: SshAgentServer | null;
		egressProxy: EgressProxy | null;
		pricing?: PricingService;
		teamId?: string;
		projectId?: string;
	};
};

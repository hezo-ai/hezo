import type { PGlite } from '@electric-sql/pglite';
import type { AuthType } from '@hezo/shared';
import type { MasterKeyManager } from '../crypto/master-key';
import type { DockerClient } from '../services/docker';
import type { JobManager } from '../services/job-manager';
import type { LogStreamBroker } from '../services/log-stream-broker';
import type { SshAgentServer } from '../services/ssh-agent';
import type { WebSocketManager } from '../services/ws';

export type AuthInfo =
	| { type: typeof AuthType.Board; userId: string; isSuperuser: boolean }
	| { type: typeof AuthType.ApiKey; companyId: string }
	| { type: typeof AuthType.Agent; memberId: string; companyId: string; runId: string };

export type Env = {
	Variables: {
		db: PGlite;
		masterKeyManager: MasterKeyManager;
		docker: DockerClient;
		wsManager: WebSocketManager;
		jobManager: JobManager;
		logs: LogStreamBroker;
		auth: AuthInfo;
		dataDir: string;
		connectUrl: string;
		connectPublicKey: string;
		webUrl: string;
		sshAgentServer: SshAgentServer | null;
	};
};

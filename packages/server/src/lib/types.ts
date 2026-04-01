import type { PGlite } from '@electric-sql/pglite';
import type { AuthType } from '@hezo/shared';
import type { MasterKeyManager } from '../crypto/master-key';
import type { DockerClient } from '../services/docker';
import type { WebSocketManager } from '../services/ws';

export type AuthInfo =
	| { type: typeof AuthType.Board; userId: string; isSuperuser: boolean }
	| { type: typeof AuthType.ApiKey; companyId: string }
	| { type: typeof AuthType.Agent; memberId: string; companyId: string };

export type Env = {
	Variables: {
		db: PGlite;
		masterKeyManager: MasterKeyManager;
		docker: DockerClient;
		wsManager: WebSocketManager;
		auth: AuthInfo;
		dataDir: string;
		connectUrl: string;
		connectPublicKey: string;
	};
};

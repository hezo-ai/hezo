import type { PGlite } from '@electric-sql/pglite';
import type { MasterKeyManager } from '../crypto/master-key';
import type { DockerClient } from '../services/docker';
import type { WebSocketManager } from '../services/ws';

export type AuthInfo =
	| { type: 'board'; userId: string }
	| { type: 'api_key'; companyId: string }
	| { type: 'agent'; memberId: string; companyId: string };

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

import type { PGlite } from '@electric-sql/pglite';
import type { MasterKeyManager } from '../crypto/master-key';
import type { DockerClient } from '../services/docker';

export type AuthInfo =
	| { type: 'board'; userId: string }
	| { type: 'api_key'; companyId: string }
	| { type: 'agent'; memberId: string; companyId: string };

export type Env = {
	Variables: {
		db: PGlite;
		masterKeyManager: MasterKeyManager;
		docker: DockerClient;
		auth: AuthInfo;
		dataDir: string;
		connectUrl: string;
		connectPublicKey: string;
	};
};

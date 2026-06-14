export interface ConnectConfig {
	port: number;
	mode: 'self_hosted' | 'centrally_hosted';
	stateSigningKey: string;
	github?: {
		clientId: string;
		clientSecret: string;
	};
}

export type MasterKeyState = 'unset' | 'locked' | 'unlocked';

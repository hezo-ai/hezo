import { randomBytes } from 'node:crypto';
import { config as dotenvConfig } from 'dotenv';
import { get } from 'env-var';

export interface ConnectConfig {
	port: number;
	mode: 'self_hosted';
	stateSigningKey: string;
	github?: {
		clientId: string;
		clientSecret: string;
	};
}

export interface LoadConfigOptions {
	envPath?: string;
}

export function loadConfig(options?: LoadConfigOptions): ConnectConfig {
	dotenvConfig({ path: options?.envPath });

	const port = get('HEZO_CONNECT_PORT').default('4100').asPortNumber();

	let stateSigningKey = get('STATE_SIGNING_KEY').default('').asString();
	if (!stateSigningKey) {
		stateSigningKey = randomBytes(32).toString('hex');
		console.log('Auto-generated state signing key (set STATE_SIGNING_KEY env var to persist)');
	}

	const githubClientId = get('GITHUB_CLIENT_ID').asString();
	const githubClientSecret = get('GITHUB_CLIENT_SECRET').asString();

	return {
		port,
		mode: 'self_hosted',
		stateSigningKey,
		github:
			githubClientId && githubClientSecret
				? { clientId: githubClientId, clientSecret: githubClientSecret }
				: undefined,
	};
}

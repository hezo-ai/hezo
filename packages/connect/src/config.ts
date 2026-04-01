import { createPublicKey, generateKeyPairSync } from 'node:crypto';
import { config as dotenvConfig } from 'dotenv';
import { get } from 'env-var';

export interface ConnectConfig {
	port: number;
	mode: 'self_hosted';
	statePrivateKey: string; // PEM
	statePublicKey: string; // PEM
	github?: {
		clientId: string;
		clientSecret: string;
	};
}

export interface LoadConfigOptions {
	envPath?: string;
}

export function generateStateKeyPair(): { privateKey: string; publicKey: string } {
	const { privateKey, publicKey } = generateKeyPairSync('ed25519', {
		privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
		publicKeyEncoding: { type: 'spki', format: 'pem' },
	});
	return { privateKey, publicKey };
}

export function loadConfig(options?: LoadConfigOptions): ConnectConfig {
	dotenvConfig({ path: options?.envPath });

	const port = get('HEZO_CONNECT_PORT').default('4100').asPortNumber();

	const statePrivateKeyEnv = get('STATE_PRIVATE_KEY').default('').asString();

	let statePrivateKey: string;
	let statePublicKey: string;

	if (statePrivateKeyEnv) {
		statePrivateKey = statePrivateKeyEnv;
		const pubKey = createPublicKey(statePrivateKey);
		statePublicKey = pubKey.export({ type: 'spki', format: 'pem' }) as string;
	} else {
		const keypair = generateStateKeyPair();
		statePrivateKey = keypair.privateKey;
		statePublicKey = keypair.publicKey;
		console.log('Auto-generated Ed25519 state signing keypair (set STATE_PRIVATE_KEY env var to persist)');
	}

	const githubClientId = get('GITHUB_CLIENT_ID').asString();
	const githubClientSecret = get('GITHUB_CLIENT_SECRET').asString();

	return {
		port,
		mode: 'self_hosted',
		statePrivateKey,
		statePublicKey,
		github:
			githubClientId && githubClientSecret
				? { clientId: githubClientId, clientSecret: githubClientSecret }
				: undefined,
	};
}

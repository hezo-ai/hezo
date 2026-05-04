import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { generateCACertificate } from 'mockttp';
import { pki } from 'node-forge';
import { logger } from '../../logger';

const log = logger.child('egress-ca');

export interface HezoCA {
	/** PEM-encoded CA certificate (read from `certPath`). */
	cert: string;
	/** PEM-encoded CA private key (read from `keyPath`). */
	key: string;
	/** Filesystem path to the CA certificate PEM. Bind-mounted into agent containers. */
	certPath: string;
	/** Filesystem path to the CA private key PEM (mode 0600). */
	keyPath: string;
	/** Root directory of the CA layout, suitable for `http-mitm-proxy.sslCaDir`. */
	rootDir: string;
}

const CA_DIR_NAME = 'ca';

/**
 * Load the persistent egress CA from `<dataDir>/ca`, generating it on first
 * boot. The on-disk layout is the one http-mitm-proxy's CA loader expects:
 *
 *   <dataDir>/ca/certs/ca.pem            (CA certificate, mode 0644)
 *   <dataDir>/ca/keys/ca.private.key     (CA private key, mode 0600)
 *   <dataDir>/ca/keys/ca.public.key      (CA public key, derived from cert)
 *
 * Re-running is idempotent: if all three files exist, no new CA is generated.
 */
export async function loadOrCreateCA(dataDir: string): Promise<HezoCA> {
	const rootDir = join(dataDir, CA_DIR_NAME);
	const certsDir = join(rootDir, 'certs');
	const keysDir = join(rootDir, 'keys');
	const certPath = join(certsDir, 'ca.pem');
	const keyPath = join(keysDir, 'ca.private.key');
	const pubKeyPath = join(keysDir, 'ca.public.key');

	if (existsSync(certPath) && existsSync(keyPath) && existsSync(pubKeyPath)) {
		return {
			cert: readFileSync(certPath, 'utf8'),
			key: readFileSync(keyPath, 'utf8'),
			certPath,
			keyPath,
			rootDir,
		};
	}

	mkdirSync(certsDir, { recursive: true, mode: 0o755 });
	mkdirSync(keysDir, { recursive: true, mode: 0o700 });

	log.info('Generating Hezo egress CA (one-time, ~2s)…');
	const generated = await generateCACertificate({
		bits: 2048,
		subject: {
			commonName: 'Hezo Egress CA',
			organizationName: 'Hezo',
		},
	});

	const certForge = pki.certificateFromPem(generated.cert);
	const publicKeyPem = pki.publicKeyToPem(certForge.publicKey);

	// Cert is public: world-readable so the unprivileged in-container user
	// (often uid 1000) can verify TLS handshakes against it. The CA private
	// key stays 0600 — host-owner only.
	writeFileSync(certPath, generated.cert, { mode: 0o644 });
	writeFileSync(keyPath, generated.key, { mode: 0o600 });
	writeFileSync(pubKeyPath, publicKeyPem, { mode: 0o644 });
	log.info(`Hezo egress CA written to ${certPath}`);

	return { cert: generated.cert, key: generated.key, certPath, keyPath, rootDir };
}

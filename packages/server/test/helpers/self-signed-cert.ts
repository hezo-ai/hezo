import { generateCACertificate } from 'mockttp';
import { getCA } from 'mockttp/dist/util/certificates';

export interface GeneratedCert {
	cert: string;
	key: string;
}

/**
 * Generate a self-signed leaf cert by spinning up a transient CA from
 * mockttp's certificate utility and minting a cert for the given hostname.
 * The returned cert is for use with a test HTTPS upstream — anything that
 * needs to verify it must explicitly trust this CA.
 */
export async function generateSelfSignedCert(commonName: string): Promise<GeneratedCert> {
	const root = await generateCACertificate({
		subject: { commonName: `${commonName}-ca`, organizationName: 'Hezo Test' },
	});
	const ca = await getCA({ cert: root.cert, key: root.key });
	const leaf = await ca.generateCertificate(commonName);
	return { cert: leaf.cert, key: leaf.key };
}

/**
 * Mint a leaf cert from an existing CA. Used so the test HTTPS upstream
 * presents a cert chained to the same CA the proxy already trusts —
 * mirrors how production-trusted certs reach the egress proxy and sidesteps
 * the need to disable upstream verification.
 */
export async function mintCertFromCA(
	root: { cert: string; key: string },
	commonName: string,
): Promise<GeneratedCert> {
	const ca = await getCA({ cert: root.cert, key: root.key });
	const leaf = await ca.generateCertificate(commonName);
	return { cert: leaf.cert, key: leaf.key };
}

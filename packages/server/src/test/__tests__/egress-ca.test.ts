import { existsSync, mkdtempSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { loadOrCreateCA } from '../../services/egress/ca';

const dataDirs: string[] = [];

function newDataDir(): string {
	const d = mkdtempSync(join(tmpdir(), 'hezo-ca-'));
	dataDirs.push(d);
	return d;
}

afterAll(() => {
	const fs = require('node:fs') as typeof import('node:fs');
	for (const d of dataDirs) fs.rmSync(d, { recursive: true, force: true });
});

describe('loadOrCreateCA', () => {
	it('generates a fresh CA on first call and writes it 0600 inside dataDir/ca', async () => {
		const dataDir = newDataDir();
		const ca = await loadOrCreateCA(dataDir);
		expect(ca.certPath).toBe(join(dataDir, 'ca', 'certs', 'ca.pem'));
		expect(ca.keyPath).toBe(join(dataDir, 'ca', 'keys', 'ca.private.key'));
		expect(ca.rootDir).toBe(join(dataDir, 'ca'));
		expect(existsSync(ca.certPath)).toBe(true);
		expect(existsSync(ca.keyPath)).toBe(true);
		expect(existsSync(join(ca.rootDir, 'keys', 'ca.public.key'))).toBe(true);
		expect(ca.cert).toMatch(/-----BEGIN CERTIFICATE-----/);
		expect(ca.key).toMatch(/-----BEGIN.+PRIVATE KEY-----/);
		const keyMode = statSync(ca.keyPath).mode & 0o777;
		expect(keyMode & 0o077).toBe(0);
	}, 10_000);

	it('is idempotent across restarts: returns the persisted CA byte-for-byte', async () => {
		const dataDir = newDataDir();
		const first = await loadOrCreateCA(dataDir);
		const second = await loadOrCreateCA(dataDir);
		expect(second.cert).toBe(first.cert);
		expect(second.key).toBe(first.key);
		expect(readFileSync(first.certPath, 'utf8')).toBe(first.cert);
	}, 10_000);
});

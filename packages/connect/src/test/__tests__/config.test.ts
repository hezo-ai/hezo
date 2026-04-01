import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { generateStateKeyPair, loadConfig } from '../../config.js';

let tempDir: string;
const NONEXISTENT_ENV = () => join(tempDir, '.env.nonexistent');

beforeEach(() => {
	tempDir = join(tmpdir(), `hezo-config-test-${randomUUID()}`);
	mkdirSync(tempDir, { recursive: true });

	delete process.env.HEZO_CONNECT_PORT;
	delete process.env.STATE_PRIVATE_KEY;
	delete process.env.GITHUB_CLIENT_ID;
	delete process.env.GITHUB_CLIENT_SECRET;
});

afterEach(() => {
	delete process.env.HEZO_CONNECT_PORT;
	delete process.env.STATE_PRIVATE_KEY;
	delete process.env.GITHUB_CLIENT_ID;
	delete process.env.GITHUB_CLIENT_SECRET;
	rmSync(tempDir, { recursive: true, force: true });
});

describe('loadConfig defaults', () => {
	it('uses default port 4100 when HEZO_CONNECT_PORT is unset', () => {
		const config = loadConfig({ envPath: NONEXISTENT_ENV() });
		expect(config.port).toBe(4100);
	});

	it('sets mode to self_hosted', () => {
		const config = loadConfig({ envPath: NONEXISTENT_ENV() });
		expect(config.mode).toBe('self_hosted');
	});

	it('auto-generates Ed25519 keypair when STATE_PRIVATE_KEY is unset', () => {
		const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
		const config = loadConfig({ envPath: NONEXISTENT_ENV() });
		expect(config.statePrivateKey).toContain('-----BEGIN PRIVATE KEY-----');
		expect(config.statePublicKey).toContain('-----BEGIN PUBLIC KEY-----');
		expect(spy).toHaveBeenCalledWith(
			expect.stringContaining('Auto-generated Ed25519 state signing keypair'),
		);
		spy.mockRestore();
	});

	it('returns undefined github when neither client ID nor secret is set', () => {
		const config = loadConfig({ envPath: NONEXISTENT_ENV() });
		expect(config.github).toBeUndefined();
	});
});

describe('loadConfig with env vars', () => {
	it('reads custom port from HEZO_CONNECT_PORT', () => {
		process.env.HEZO_CONNECT_PORT = '8080';
		const config = loadConfig({ envPath: NONEXISTENT_ENV() });
		expect(config.port).toBe(8080);
	});

	it('uses STATE_PRIVATE_KEY when provided and derives public key', () => {
		const kp = generateStateKeyPair();
		process.env.STATE_PRIVATE_KEY = kp.privateKey;
		const config = loadConfig({ envPath: NONEXISTENT_ENV() });
		expect(config.statePrivateKey).toBe(kp.privateKey);
		expect(config.statePublicKey).toContain('-----BEGIN PUBLIC KEY-----');
	});

	it('returns github config when both client ID and secret are set', () => {
		process.env.GITHUB_CLIENT_ID = 'id-123';
		process.env.GITHUB_CLIENT_SECRET = 'secret-456';
		const config = loadConfig({ envPath: NONEXISTENT_ENV() });
		expect(config.github).toEqual({
			clientId: 'id-123',
			clientSecret: 'secret-456',
		});
	});

	it('returns undefined github when only client ID is set', () => {
		process.env.GITHUB_CLIENT_ID = 'id-123';
		const config = loadConfig({ envPath: NONEXISTENT_ENV() });
		expect(config.github).toBeUndefined();
	});

	it('returns undefined github when only client secret is set', () => {
		process.env.GITHUB_CLIENT_SECRET = 'secret-456';
		const config = loadConfig({ envPath: NONEXISTENT_ENV() });
		expect(config.github).toBeUndefined();
	});
});

describe('loadConfig port validation', () => {
	it('throws on non-numeric port', () => {
		process.env.HEZO_CONNECT_PORT = 'not-a-number';
		expect(() => loadConfig({ envPath: NONEXISTENT_ENV() })).toThrow();
	});

	it('accepts port 0 (OS-assigned)', () => {
		process.env.HEZO_CONNECT_PORT = '0';
		const config = loadConfig({ envPath: NONEXISTENT_ENV() });
		expect(config.port).toBe(0);
	});

	it('throws on port above 65535', () => {
		process.env.HEZO_CONNECT_PORT = '70000';
		expect(() => loadConfig({ envPath: NONEXISTENT_ENV() })).toThrow();
	});

	it('throws on negative port', () => {
		process.env.HEZO_CONNECT_PORT = '-1';
		expect(() => loadConfig({ envPath: NONEXISTENT_ENV() })).toThrow();
	});

	it('accepts port 1', () => {
		process.env.HEZO_CONNECT_PORT = '1';
		const config = loadConfig({ envPath: NONEXISTENT_ENV() });
		expect(config.port).toBe(1);
	});

	it('accepts port 65535', () => {
		process.env.HEZO_CONNECT_PORT = '65535';
		const config = loadConfig({ envPath: NONEXISTENT_ENV() });
		expect(config.port).toBe(65535);
	});
});

describe('loadConfig .env file loading', () => {
	it('reads variables from a .env file', () => {
		const envPath = join(tempDir, '.env');
		writeFileSync(
			envPath,
			['HEZO_CONNECT_PORT=9090', 'GITHUB_CLIENT_ID=env-id', 'GITHUB_CLIENT_SECRET=env-secret'].join(
				'\n',
			),
		);
		const config = loadConfig({ envPath });
		expect(config.port).toBe(9090);
		expect(config.github).toEqual({
			clientId: 'env-id',
			clientSecret: 'env-secret',
		});
	});

	it('handles missing .env file gracefully', () => {
		const config = loadConfig({ envPath: join(tempDir, '.env.does-not-exist') });
		expect(config.port).toBe(4100);
	});
});

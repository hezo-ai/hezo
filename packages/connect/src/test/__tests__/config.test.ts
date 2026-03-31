import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { loadConfig } from '../../config.js';

let tempDir: string;
const NONEXISTENT_ENV = () => join(tempDir, '.env.nonexistent');

beforeEach(() => {
	tempDir = join(tmpdir(), `hezo-config-test-${randomUUID()}`);
	mkdirSync(tempDir, { recursive: true });

	delete process.env.HEZO_CONNECT_PORT;
	delete process.env.STATE_SIGNING_KEY;
	delete process.env.GITHUB_CLIENT_ID;
	delete process.env.GITHUB_CLIENT_SECRET;
});

afterEach(() => {
	vi.unstubAllEnvs();
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

	it('auto-generates a 64-char hex signing key when STATE_SIGNING_KEY is unset', () => {
		const spy = vi.spyOn(console, 'log').mockImplementation(() => {});
		const config = loadConfig({ envPath: NONEXISTENT_ENV() });
		expect(config.stateSigningKey).toMatch(/^[a-f0-9]{64}$/);
		expect(spy).toHaveBeenCalledWith(expect.stringContaining('Auto-generated state signing key'));
		spy.mockRestore();
	});

	it('returns undefined github when neither client ID nor secret is set', () => {
		const config = loadConfig({ envPath: NONEXISTENT_ENV() });
		expect(config.github).toBeUndefined();
	});
});

describe('loadConfig with env vars', () => {
	it('reads custom port from HEZO_CONNECT_PORT', () => {
		vi.stubEnv('HEZO_CONNECT_PORT', '8080');
		const config = loadConfig({ envPath: NONEXISTENT_ENV() });
		expect(config.port).toBe(8080);
	});

	it('reads STATE_SIGNING_KEY when provided', () => {
		vi.stubEnv('STATE_SIGNING_KEY', 'my-secret-key');
		const config = loadConfig({ envPath: NONEXISTENT_ENV() });
		expect(config.stateSigningKey).toBe('my-secret-key');
	});

	it('returns github config when both client ID and secret are set', () => {
		vi.stubEnv('GITHUB_CLIENT_ID', 'id-123');
		vi.stubEnv('GITHUB_CLIENT_SECRET', 'secret-456');
		const config = loadConfig({ envPath: NONEXISTENT_ENV() });
		expect(config.github).toEqual({
			clientId: 'id-123',
			clientSecret: 'secret-456',
		});
	});

	it('returns undefined github when only client ID is set', () => {
		vi.stubEnv('GITHUB_CLIENT_ID', 'id-123');
		const config = loadConfig({ envPath: NONEXISTENT_ENV() });
		expect(config.github).toBeUndefined();
	});

	it('returns undefined github when only client secret is set', () => {
		vi.stubEnv('GITHUB_CLIENT_SECRET', 'secret-456');
		const config = loadConfig({ envPath: NONEXISTENT_ENV() });
		expect(config.github).toBeUndefined();
	});
});

describe('loadConfig port validation', () => {
	it('throws on non-numeric port', () => {
		vi.stubEnv('HEZO_CONNECT_PORT', 'not-a-number');
		expect(() => loadConfig({ envPath: NONEXISTENT_ENV() })).toThrow();
	});

	it('accepts port 0 (OS-assigned)', () => {
		vi.stubEnv('HEZO_CONNECT_PORT', '0');
		const config = loadConfig({ envPath: NONEXISTENT_ENV() });
		expect(config.port).toBe(0);
	});

	it('throws on port above 65535', () => {
		vi.stubEnv('HEZO_CONNECT_PORT', '70000');
		expect(() => loadConfig({ envPath: NONEXISTENT_ENV() })).toThrow();
	});

	it('throws on negative port', () => {
		vi.stubEnv('HEZO_CONNECT_PORT', '-1');
		expect(() => loadConfig({ envPath: NONEXISTENT_ENV() })).toThrow();
	});

	it('accepts port 1', () => {
		vi.stubEnv('HEZO_CONNECT_PORT', '1');
		const config = loadConfig({ envPath: NONEXISTENT_ENV() });
		expect(config.port).toBe(1);
	});

	it('accepts port 65535', () => {
		vi.stubEnv('HEZO_CONNECT_PORT', '65535');
		const config = loadConfig({ envPath: NONEXISTENT_ENV() });
		expect(config.port).toBe(65535);
	});
});

describe('loadConfig .env file loading', () => {
	it('reads variables from a .env file', () => {
		const envPath = join(tempDir, '.env');
		writeFileSync(
			envPath,
			[
				'HEZO_CONNECT_PORT=9090',
				'STATE_SIGNING_KEY=from-dotenv',
				'GITHUB_CLIENT_ID=env-id',
				'GITHUB_CLIENT_SECRET=env-secret',
			].join('\n'),
		);
		const config = loadConfig({ envPath });
		expect(config.port).toBe(9090);
		expect(config.stateSigningKey).toBe('from-dotenv');
		expect(config.github).toEqual({
			clientId: 'env-id',
			clientSecret: 'env-secret',
		});
	});

	it('process.env values take precedence over .env file', () => {
		const envPath = join(tempDir, '.env');
		writeFileSync(envPath, 'HEZO_CONNECT_PORT=9090\n');
		vi.stubEnv('HEZO_CONNECT_PORT', '7070');
		const config = loadConfig({ envPath });
		expect(config.port).toBe(7070);
	});

	it('handles missing .env file gracefully', () => {
		const config = loadConfig({ envPath: join(tempDir, '.env.does-not-exist') });
		expect(config.port).toBe(4100);
	});
});

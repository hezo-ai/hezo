import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { parseArgs } from '../../cli';

// Helper to build argv with the standard bun/node + script prefix
const argv = (...flags: string[]) => ['bun', 'src/index.ts', ...flags];

describe('parseArgs', () => {
	it('returns defaults when no args provided', () => {
		const config = parseArgs(argv());
		expect(config.port).toBe(3100);
		expect(config.dataDir).toBe(resolve(homedir(), '.hezo'));
		expect(config.masterKey).toBeUndefined();
		expect(config.reset).toBe(false);
		expect(config.open).toBe(false);
	});

	it('parses --port', () => {
		const config = parseArgs(argv('--port', '8080'));
		expect(config.port).toBe(8080);
	});

	it('throws on non-numeric port', () => {
		expect(() => parseArgs(argv('--port', 'abc'))).toThrow('Invalid port');
	});

	it('throws on port below valid range', () => {
		expect(() => parseArgs(argv('--port', '0'))).toThrow('Invalid port');
	});

	it('throws on port above valid range', () => {
		expect(() => parseArgs(argv('--port', '99999'))).toThrow('Invalid port');
	});

	it('parses --data-dir with absolute path', () => {
		const config = parseArgs(argv('--data-dir', '/custom/path'));
		expect(config.dataDir).toBe('/custom/path');
	});

	it('resolves tilde in --data-dir', () => {
		const config = parseArgs(argv('--data-dir', '~/custom'));
		expect(config.dataDir).toBe(resolve(homedir(), 'custom'));
	});

	it('parses --master-key', () => {
		const config = parseArgs(argv('--master-key', 'mykey'));
		expect(config.masterKey).toBe('mykey');
	});

	it('parses --reset', () => {
		const config = parseArgs(argv('--reset'));
		expect(config.reset).toBe(true);
	});

	it('parses --open', () => {
		const config = parseArgs(argv('--open'));
		expect(config.open).toBe(true);
	});

	it('handles multiple flags combined', () => {
		const config = parseArgs(
			argv(
				'--port',
				'9000',
				'--data-dir',
				'/tmp/hezo',
				'--master-key',
				'secret',
				'--reset',
				'--open',
			),
		);
		expect(config.port).toBe(9000);
		expect(config.dataDir).toBe('/tmp/hezo');
		expect(config.masterKey).toBe('secret');
		expect(config.reset).toBe(true);
		expect(config.open).toBe(true);
	});
});

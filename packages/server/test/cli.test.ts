import { homedir } from 'node:os';
import { resolve } from 'node:path';
import { deriveAuthKeyPair, deriveUnlockKey } from '@hezo/shared';
import { describe, expect, it } from 'vitest';
import { parseConfig, resolveDevDataDir, runVersion } from '../src/cli';
import { HEZO_VERSION } from '../src/version';

// Canonical BIP39 vector — parseMasterKey only accepts a valid mnemonic.
const PHRASE =
	'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

// Helper to build argv with the standard bun/node + script prefix
const argv = (...flags: string[]) => ['bun', 'src/index.ts', ...flags];

// Always pass an empty env so the test outcomes do not depend on the host
// process having or not having HEZO_* vars set.
const EMPTY_ENV: NodeJS.ProcessEnv = {};

describe('parseConfig', () => {
	it('returns defaults when no args provided', () => {
		const config = parseConfig(argv(), EMPTY_ENV);
		expect(config.port).toBe(3100);
		expect(config.dataDir).toBe(resolve(homedir(), '.hezo'));
		expect(config.masterKey).toBeUndefined();
		expect(config.reset).toBe(false);
		expect(config.open).toBe(true);
		expect(config.logLevel).toBe('info');
		expect(config.keepOldContainers).toBe(false);
	});

	it('parses --port', () => {
		const config = parseConfig(argv('--port', '8080'), EMPTY_ENV);
		expect(config.port).toBe(8080);
	});

	it('throws on non-numeric port', () => {
		expect(() => parseConfig(argv('--port', 'abc'), EMPTY_ENV)).toThrow('Invalid port');
	});

	it('throws on port below valid range', () => {
		expect(() => parseConfig(argv('--port', '0'), EMPTY_ENV)).toThrow('Invalid port');
	});

	it('throws on port above valid range', () => {
		expect(() => parseConfig(argv('--port', '99999'), EMPTY_ENV)).toThrow('Invalid port');
	});

	it('parses --data-dir with absolute path', () => {
		const config = parseConfig(argv('--data-dir', '/custom/path'), EMPTY_ENV);
		expect(config.dataDir).toBe('/custom/path');
	});

	it('resolves tilde in --data-dir', () => {
		const config = parseConfig(argv('--data-dir', '~/custom'), EMPTY_ENV);
		expect(config.dataDir).toBe(resolve(homedir(), 'custom'));
	});

	it('derives unlock key + auth public key from a --master-key phrase', () => {
		const config = parseConfig(argv('--master-key', PHRASE), EMPTY_ENV);
		expect(config.masterKey).toEqual({
			unlockKeyHex: deriveUnlockKey(PHRASE),
			publicKeyHex: deriveAuthKeyPair(PHRASE).publicKeyHex,
		});
	});

	it('rejects a --master-key that is not a valid mnemonic', () => {
		expect(() => parseConfig(argv('--master-key', 'not-a-phrase'), EMPTY_ENV)).toThrow(
			'Invalid master key',
		);
		// A raw derived hex key is no longer accepted either — it could never
		// enroll the auth public key.
		expect(() => parseConfig(argv('--master-key', 'ab'.repeat(32)), EMPTY_ENV)).toThrow(
			'Invalid master key',
		);
	});

	it('parses --reset', () => {
		const config = parseConfig(argv('--reset'), EMPTY_ENV);
		expect(config.reset).toBe(true);
	});

	it('defaults open to true and disables it with --no-open', () => {
		expect(parseConfig(argv(), EMPTY_ENV).open).toBe(true);
		expect(parseConfig(argv('--no-open'), EMPTY_ENV).open).toBe(false);
	});

	it('lets HEZO_OPEN override the default and --no-open', () => {
		// Env wins over both the default and the CLI flag.
		expect(parseConfig(argv(), { HEZO_OPEN: '0' }).open).toBe(false);
		expect(parseConfig(argv(), { HEZO_OPEN: 'false' }).open).toBe(false);
		expect(parseConfig(argv('--no-open'), { HEZO_OPEN: '1' }).open).toBe(true);
		// An empty env value falls through to the CLI/default.
		expect(parseConfig(argv(), { HEZO_OPEN: '' }).open).toBe(true);
	});

	it('parses --log-level', () => {
		const config = parseConfig(argv('--log-level', 'debug'), EMPTY_ENV);
		expect(config.logLevel).toBe('debug');
	});

	it('throws on invalid --log-level', () => {
		expect(() => parseConfig(argv('--log-level', 'trace'), EMPTY_ENV)).toThrow('Invalid log level');
	});

	it('parses --keep-old-containers', () => {
		const config = parseConfig(argv('--keep-old-containers'), EMPTY_ENV);
		expect(config.keepOldContainers).toBe(true);
	});

	it('handles multiple flags combined', () => {
		const config = parseConfig(
			argv(
				'--port',
				'9000',
				'--data-dir',
				'/tmp/hezo',
				'--master-key',
				PHRASE,
				'--reset',
				'--no-open',
			),
			EMPTY_ENV,
		);
		expect(config.port).toBe(9000);
		expect(config.dataDir).toBe('/tmp/hezo');
		expect(config.masterKey?.unlockKeyHex).toBe(deriveUnlockKey(PHRASE));
		expect(config.reset).toBe(true);
		expect(config.open).toBe(false);
	});

	describe('env vars take precedence over CLI args', () => {
		it('HEZO_PORT overrides --port', () => {
			const config = parseConfig(argv('--port', '8080'), { HEZO_PORT: '9090' });
			expect(config.port).toBe(9090);
		});

		it('HEZO_DATA_DIR overrides --data-dir', () => {
			const config = parseConfig(argv('--data-dir', '/cli/path'), { HEZO_DATA_DIR: '/env/path' });
			expect(config.dataDir).toBe('/env/path');
		});

		it('HEZO_LOG_LEVEL overrides --log-level', () => {
			const config = parseConfig(argv('--log-level', 'debug'), { HEZO_LOG_LEVEL: 'warn' });
			expect(config.logLevel).toBe('warn');
		});

		it('HEZO_KEEP_OLD_CONTAINERS overrides absence of CLI flag', () => {
			const config = parseConfig(argv(), { HEZO_KEEP_OLD_CONTAINERS: '1' });
			expect(config.keepOldContainers).toBe(true);
		});

		it('HEZO_RESET=false overrides --reset', () => {
			const config = parseConfig(argv('--reset'), { HEZO_RESET: 'false' });
			expect(config.reset).toBe(false);
		});

		it('empty env value falls through to CLI', () => {
			const config = parseConfig(argv('--port', '8080'), { HEZO_PORT: '' });
			expect(config.port).toBe(8080);
		});
	});
});

describe('runVersion', () => {
	it('prints the version and returns true for --version', () => {
		const lines: string[] = [];
		expect(runVersion(argv('--version'), (l) => lines.push(l))).toBe(true);
		expect(lines).toEqual([HEZO_VERSION]);
	});

	it('handles the -V short flag', () => {
		const lines: string[] = [];
		expect(runVersion(argv('-V'), (l) => lines.push(l))).toBe(true);
		expect(lines).toEqual([HEZO_VERSION]);
	});

	it('handles the `version` subcommand', () => {
		const lines: string[] = [];
		expect(runVersion(argv('version'), (l) => lines.push(l))).toBe(true);
		expect(lines).toEqual([HEZO_VERSION]);
	});

	it('returns false and prints nothing when no version is requested', () => {
		const lines: string[] = [];
		expect(runVersion(argv('--port', '8080'), (l) => lines.push(l))).toBe(false);
		expect(lines).toEqual([]);
	});
});

describe('resolveDevDataDir', () => {
	// `bun run dev` passes an absolute project-local default here.
	const DEFAULT = '/repo/.hezo-dev';

	it('uses the project-local default when neither env nor flag is set', () => {
		const r = resolveDevDataDir(DEFAULT, undefined, EMPTY_ENV);
		expect(r.dataDir).toBe(resolve(DEFAULT));
		expect(r.usedDefault).toBe(true);
	});

	it('honors --data-dir over the default', () => {
		const r = resolveDevDataDir(DEFAULT, '/cli/path', EMPTY_ENV);
		expect(r.dataDir).toBe('/cli/path');
		expect(r.usedDefault).toBe(false);
	});

	it('HEZO_DATA_DIR wins over --data-dir', () => {
		const r = resolveDevDataDir(DEFAULT, '/cli/path', { HEZO_DATA_DIR: '/env/path' });
		expect(r.dataDir).toBe('/env/path');
		expect(r.usedDefault).toBe(false);
	});

	it('expands a leading ~ in HEZO_DATA_DIR like the server does', () => {
		const r = resolveDevDataDir(DEFAULT, undefined, { HEZO_DATA_DIR: '~/custom' });
		expect(r.dataDir).toBe(resolve(homedir(), 'custom'));
		expect(r.usedDefault).toBe(false);
	});

	it('expands a leading ~ in --data-dir', () => {
		const r = resolveDevDataDir(DEFAULT, '~/custom', EMPTY_ENV);
		expect(r.dataDir).toBe(resolve(homedir(), 'custom'));
		expect(r.usedDefault).toBe(false);
	});

	it('ignores an empty HEZO_DATA_DIR and falls back to the default', () => {
		const r = resolveDevDataDir(DEFAULT, undefined, { HEZO_DATA_DIR: '' });
		expect(r.dataDir).toBe(resolve(DEFAULT));
		expect(r.usedDefault).toBe(true);
	});
});

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { deriveAuthKeyPair, deriveUnlockKey } from '@hezo/shared';
import { afterAll, describe, expect, it } from 'vitest';
import { resolveConfig, resolveDevDataDir, runConfigValidation, runVersion } from '../src/cli';
import { HEZO_VERSION } from '../src/version';

// Canonical BIP39 vector — parseMasterKey only accepts a valid mnemonic.
const PHRASE =
	'abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon abandon about';

// Helper to build argv with the standard bun/node + script prefix
const argv = (...flags: string[]) => ['bun', 'src/index.ts', ...flags];

// Always pass an empty env so the test outcomes do not depend on the host
// process having or not having HEZO_* vars set. HEZO_MASTER_KEY is the only
// setting still read from it.
const EMPTY_ENV: NodeJS.ProcessEnv = {};

// Config files are real modules on disk — `require` caches by resolved path, so
// each one needs its own name rather than a rewritten shared file.
const configDir = mkdtempSync(join(tmpdir(), 'hezo-cli-config-'));
let configSeq = 0;
afterAll(() => rmSync(configDir, { recursive: true, force: true }));

/** Write a config file and return its path. */
function configFile(body: string): string {
	const path = join(configDir, `hezo.${configSeq++}.config.cjs`);
	writeFileSync(path, body);
	return path;
}

describe('runConfigValidation', () => {
	it('ignores other commands', () => {
		expect(runConfigValidation(argv())).toBe(false);
	});

	it('loads and validates a CommonJS config without starting the server', () => {
		const path = configFile("module.exports = { dataDir: '/srv/hezo' };");
		const output: string[] = [];
		expect(
			runConfigValidation(argv('config', 'validate', '--config', path), output.push.bind(output)),
		).toBe(true);
		expect(output).toEqual([`Valid Hezo config: ${path}`]);
	});

	it('rejects syntax-invalid and schema-invalid CommonJS configs', () => {
		const syntaxInvalid = configFile("module.exports = { dataDir: '/srv/hezo' ");
		const schemaInvalid = configFile("module.exports = { dataDIr: '/srv/hezo' };");
		expect(() =>
			runConfigValidation(argv('config', 'validate', '--config', syntaxInvalid)),
		).toThrow(/Could not load the config file/);
		expect(() =>
			runConfigValidation(argv('config', 'validate', '--config', schemaInvalid)),
		).toThrow(/dataDIr/);
	});
});

/** Build argv that loads a config file exporting `obj`. */
const withConfig = (obj: unknown, ...flags: string[]) =>
	argv('--config', configFile(`module.exports = ${JSON.stringify(obj)};`), ...flags);

describe('resolveConfig', () => {
	it('leaves the database URL unset by default (embedded database)', () => {
		expect(resolveConfig(argv(), EMPTY_ENV).database.url).toBeUndefined();
	});

	it('accepts --database-url and lets the flag win over the config file', () => {
		expect(
			resolveConfig(argv('--database-url', 'postgres://u:p@h:5432/db'), EMPTY_ENV).database.url,
		).toBe('postgres://u:p@h:5432/db');
		expect(
			resolveConfig(
				withConfig(
					{ database: { url: 'postgres://file@h/db' } },
					'--database-url',
					'postgres://cli@h/db',
				),
				EMPTY_ENV,
			).database.url,
		).toBe('postgres://cli@h/db');
	});

	it('rejects --reset combined with an external database URL', () => {
		expect(() =>
			resolveConfig(argv('--database-url', 'postgres://u:p@h/db', '--reset'), EMPTY_ENV),
		).toThrow('embedded database only');
		expect(() =>
			resolveConfig(withConfig({ database: { url: 'postgres://u:p@h/db' } }, '--reset'), EMPTY_ENV),
		).toThrow('embedded database only');
	});

	it('returns defaults when no args provided', () => {
		const config = resolveConfig(argv(), EMPTY_ENV);
		expect(config.port).toBe(3100);
		expect(config.dataDir).toBe(resolve(homedir(), '.hezo'));
		expect(config.masterKey).toBeUndefined();
		expect(config.reset).toBe(false);
		expect(config.open).toBe(true);
		expect(config.logLevel).toBe('info');
		expect(config.containers.keepOld).toBe(false);
		expect(config.updates.autoInstall).toBe(false);
		expect(config.telemetry.enabled).toBe(true);
		expect(config.telemetry.endpoint).toBe('https://hezo.ai/api/telemetry');
	});

	it('enables auto-install of updates with --auto-install-updates', () => {
		expect(resolveConfig(argv('--auto-install-updates'), EMPTY_ENV).updates.autoInstall).toBe(true);
	});

	it('enables auto-install of updates from the config file', () => {
		expect(
			resolveConfig(withConfig({ updates: { autoInstall: true } }), EMPTY_ENV).updates.autoInstall,
		).toBe(true);
	});

	it('lets the --auto-install-updates flag win over a config file that disables it', () => {
		expect(
			resolveConfig(
				withConfig({ updates: { autoInstall: false } }, '--auto-install-updates'),
				EMPTY_ENV,
			).updates.autoInstall,
		).toBe(true);
	});

	it('disables telemetry with --disable-telemetry', () => {
		const config = resolveConfig(argv('--disable-telemetry'), EMPTY_ENV);
		expect(config.telemetry.enabled).toBe(false);
	});

	it('disables telemetry from the config file', () => {
		const config = resolveConfig(withConfig({ telemetry: { enabled: false } }), EMPTY_ENV);
		expect(config.telemetry.enabled).toBe(false);
	});

	it('lets --disable-telemetry win over a config file that enables it', () => {
		const config = resolveConfig(
			withConfig({ telemetry: { enabled: true } }, '--disable-telemetry'),
			EMPTY_ENV,
		);
		expect(config.telemetry.enabled).toBe(false);
	});

	it('overrides the telemetry endpoint via flag and config file', () => {
		expect(
			resolveConfig(argv('--telemetry-endpoint', 'https://x.test/t'), EMPTY_ENV).telemetry.endpoint,
		).toBe('https://x.test/t');
		expect(
			resolveConfig(withConfig({ telemetry: { endpoint: 'https://file.test/t' } }), EMPTY_ENV)
				.telemetry.endpoint,
		).toBe('https://file.test/t');
	});

	it('parses --port', () => {
		const config = resolveConfig(argv('--port', '8080'), EMPTY_ENV);
		expect(config.port).toBe(8080);
	});

	it('throws on non-numeric port', () => {
		expect(() => resolveConfig(argv('--port', 'abc'), EMPTY_ENV)).toThrow('Invalid port');
	});

	it('throws on port below valid range', () => {
		expect(() => resolveConfig(argv('--port', '0'), EMPTY_ENV)).toThrow('Invalid port');
	});

	it('throws on port above valid range', () => {
		expect(() => resolveConfig(argv('--port', '99999'), EMPTY_ENV)).toThrow('Invalid port');
	});

	it('parses --data-dir with absolute path', () => {
		const config = resolveConfig(argv('--data-dir', '/custom/path'), EMPTY_ENV);
		expect(config.dataDir).toBe('/custom/path');
	});

	it('resolves tilde in --data-dir', () => {
		const config = resolveConfig(argv('--data-dir', '~/custom'), EMPTY_ENV);
		expect(config.dataDir).toBe(resolve(homedir(), 'custom'));
	});

	it('derives unlock key + auth public key from a --master-key phrase', () => {
		const config = resolveConfig(argv('--master-key', PHRASE), EMPTY_ENV);
		expect(config.masterKey).toEqual({
			unlockKeyHex: deriveUnlockKey(PHRASE),
			publicKeyHex: deriveAuthKeyPair(PHRASE).publicKeyHex,
		});
	});

	it('rejects a --master-key that is not a valid mnemonic', () => {
		expect(() => resolveConfig(argv('--master-key', 'not-a-phrase'), EMPTY_ENV)).toThrow(
			'Invalid master key',
		);
		// A raw derived hex key is no longer accepted either — it could never
		// enroll the auth public key.
		expect(() => resolveConfig(argv('--master-key', 'ab'.repeat(32)), EMPTY_ENV)).toThrow(
			'Invalid master key',
		);
	});

	it('parses --reset', () => {
		const config = resolveConfig(argv('--reset'), EMPTY_ENV);
		expect(config.reset).toBe(true);
	});

	it('defaults open to true and disables it with --no-open', () => {
		expect(resolveConfig(argv(), EMPTY_ENV).open).toBe(true);
		expect(resolveConfig(argv('--no-open'), EMPTY_ENV).open).toBe(false);
	});

	it('lets the config file disable open, and --no-open win over a file that enables it', () => {
		expect(resolveConfig(withConfig({ open: false }), EMPTY_ENV).open).toBe(false);
		expect(resolveConfig(withConfig({ open: true }, '--no-open'), EMPTY_ENV).open).toBe(false);
	});

	it('parses --log-level', () => {
		const config = resolveConfig(argv('--log-level', 'debug'), EMPTY_ENV);
		expect(config.logLevel).toBe('debug');
	});

	it('throws on invalid --log-level', () => {
		expect(() => resolveConfig(argv('--log-level', 'trace'), EMPTY_ENV)).toThrow(
			'Invalid log level',
		);
	});

	it('parses --keep-old-containers', () => {
		const config = resolveConfig(argv('--keep-old-containers'), EMPTY_ENV);
		expect(config.containers.keepOld).toBe(true);
	});

	it('reads the master key from HEZO_MASTER_KEY, the one setting still on the env', () => {
		const config = resolveConfig(argv(), { HEZO_MASTER_KEY: PHRASE });
		expect(config.masterKey?.unlockKeyHex).toBe(deriveUnlockKey(PHRASE));
	});

	it('handles multiple flags combined', () => {
		const config = resolveConfig(
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

	describe('CLI flags take precedence over the config file', () => {
		it('--port overrides the file', () => {
			expect(resolveConfig(withConfig({ port: 9090 }, '--port', '8080'), EMPTY_ENV).port).toBe(
				8080,
			);
		});

		it('--data-dir overrides the file', () => {
			expect(
				resolveConfig(withConfig({ dataDir: '/file/path' }, '--data-dir', '/cli/path'), EMPTY_ENV)
					.dataDir,
			).toBe('/cli/path');
		});

		it('--log-level overrides the file', () => {
			expect(
				resolveConfig(withConfig({ logLevel: 'warn' }, '--log-level', 'debug'), EMPTY_ENV).logLevel,
			).toBe('debug');
		});

		it('the file applies when the flag is absent', () => {
			const config = resolveConfig(
				withConfig({ port: 9090, logLevel: 'warn', containers: { keepOld: true } }),
				EMPTY_ENV,
			);
			expect(config.port).toBe(9090);
			expect(config.logLevel).toBe('warn');
			expect(config.containers.keepOld).toBe(true);
		});

		it('falls back to the built-in default for anything neither sets', () => {
			const config = resolveConfig(withConfig({ port: 9090 }), EMPTY_ENV);
			expect(config.logLevel).toBe('info');
			expect(config.jobs.wakeupCron).toBe('*/5 * * * * *');
			expect(config.database.poolSize).toBe(10);
		});

		it('applies the previously env-only settings from the file', () => {
			const config = resolveConfig(
				withConfig({
					database: { poolSize: 42 },
					jobs: { heartbeatCron: '0 0 * * * *', inboxRetentionDays: 7 },
					logCompaction: { batch: 5 },
					marketplace: { ref: 'my-fork' },
					github: { oauthClientId: 'Iv1.deadbeef' },
					containers: { skipMountCheck: true, agentBaseImage: 'ghcr.io/me/agent:1' },
					egress: { debug: true },
					updates: { disabled: true },
				}),
				EMPTY_ENV,
			);
			expect(config.database.poolSize).toBe(42);
			expect(config.jobs.heartbeatCron).toBe('0 0 * * * *');
			expect(config.jobs.inboxRetentionDays).toBe(7);
			// A partial group keeps the defaults for the keys it does not name.
			expect(config.jobs.wakeupCron).toBe('*/5 * * * * *');
			expect(config.logCompaction.batch).toBe(5);
			expect(config.logCompaction.maxPerTick).toBe(500);
			expect(config.marketplace.ref).toBe('my-fork');
			expect(config.github.oauthClientId).toBe('Iv1.deadbeef');
			expect(config.containers.skipMountCheck).toBe(true);
			expect(config.containers.agentBaseImage).toBe('ghcr.io/me/agent:1');
			expect(config.egress.debug).toBe(true);
			expect(config.updates.disabled).toBe(true);
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

	it('uses the project-local default when neither flag nor config file sets one', () => {
		const r = resolveDevDataDir(DEFAULT, undefined, undefined);
		expect(r.dataDir).toBe(resolve(DEFAULT));
		expect(r.usedDefault).toBe(true);
	});

	it('honors --data-dir over the default', () => {
		const r = resolveDevDataDir(DEFAULT, '/cli/path', undefined);
		expect(r.dataDir).toBe('/cli/path');
		expect(r.usedDefault).toBe(false);
	});

	it('--data-dir wins over the config file', () => {
		const path = configFile("module.exports = { dataDir: '/file/path' };");
		const r = resolveDevDataDir(DEFAULT, '/cli/path', path);
		expect(r.dataDir).toBe('/cli/path');
		expect(r.usedDefault).toBe(false);
	});

	it("uses the config file's dataDir when no flag is given", () => {
		const path = configFile("module.exports = { dataDir: '/file/path' };");
		const r = resolveDevDataDir(DEFAULT, undefined, path);
		expect(r.dataDir).toBe('/file/path');
		expect(r.usedDefault).toBe(false);
	});

	it('expands a leading ~ from the config file like the server does', () => {
		const path = configFile("module.exports = { dataDir: '~/custom' };");
		const r = resolveDevDataDir(DEFAULT, undefined, path);
		expect(r.dataDir).toBe(resolve(homedir(), 'custom'));
		expect(r.usedDefault).toBe(false);
	});

	it('expands a leading ~ in --data-dir', () => {
		const r = resolveDevDataDir(DEFAULT, '~/custom', undefined);
		expect(r.dataDir).toBe(resolve(homedir(), 'custom'));
		expect(r.usedDefault).toBe(false);
	});

	it('falls back to the default when the config file sets no dataDir', () => {
		const path = configFile('module.exports = { port: 1234 };');
		const r = resolveDevDataDir(DEFAULT, undefined, path);
		expect(r.dataDir).toBe(resolve(DEFAULT));
		expect(r.usedDefault).toBe(true);
	});
});

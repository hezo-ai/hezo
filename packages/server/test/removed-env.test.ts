import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { resolveConfig } from '../src/cli';
import {
	detectRemovedEnvVars,
	formatRemovedEnvFatal,
	formatRemovedEnvWarning,
	REMOVED_ENV_VARS,
	type ResolvedDataLocation,
} from '../src/config/removed-env';

const REPO_ROOT = join(import.meta.dirname, '../../..');

const at = (dataDir: string, extra: Partial<ResolvedDataLocation> = {}): ResolvedDataLocation => ({
	dataDir,
	database: {},
	assetStorage: {},
	...extra,
});

describe('detectRemovedEnvVars', () => {
	it('is fatal when HEZO_DATA_DIR would have pointed somewhere else', () => {
		// The 0.50 upgrade regression: systemd still exports the old variable, the
		// binary ignores it and opens an empty database under the default path.
		const { fatal, warnings } = detectRemovedEnvVars(
			{ HEZO_DATA_DIR: '/var/lib/hezo' },
			at('/root/.hezo'),
		);
		expect(warnings).toEqual([]);
		expect(fatal).toHaveLength(1);
		expect(fatal[0].name).toBe('HEZO_DATA_DIR');
		expect(fatal[0].value).toBe('/var/lib/hezo');
		expect(fatal[0].inEffect).toBe('/root/.hezo');
	});

	it('stays quiet when the ignored variable agrees with the resolved data dir', () => {
		// An operator who migrated to --config but left EnvironmentFile= in place is
		// not being surprised by anything, so blocking them would be noise.
		const { fatal } = detectRemovedEnvVars({ HEZO_DATA_DIR: '/var/lib/hezo' }, at('/var/lib/hezo'));
		expect(fatal).toEqual([]);
	});

	it('compares data dirs after normalisation, not as raw strings', () => {
		const { fatal } = detectRemovedEnvVars(
			{ HEZO_DATA_DIR: '/var/lib/hezo/' },
			at('/var/lib/hezo'),
		);
		expect(fatal).toEqual([]);
	});

	it('is fatal for an ignored external database, and never prints its credentials', () => {
		const { fatal } = detectRemovedEnvVars(
			{ HEZO_DATABASE_URL: 'postgres://hezo:hunter2@db.internal:5432/hezo' },
			at('/var/lib/hezo'),
		);
		expect(fatal).toHaveLength(1);
		expect(fatal[0].name).toBe('HEZO_DATABASE_URL');
		expect(fatal[0].value).not.toContain('hunter2');
		// The embedded database is what it would silently fall back to.
		expect(fatal[0].inEffect).toBeUndefined();
	});

	it('is fatal for an ignored asset store, redacted the same way', () => {
		const { fatal } = detectRemovedEnvVars(
			{ HEZO_ASSET_STORAGE_URL: 's3://AKIAKEY:supersecret@s3.example.com/bucket' },
			at('/var/lib/hezo'),
		);
		expect(fatal).toHaveLength(1);
		expect(fatal[0].name).toBe('HEZO_ASSET_STORAGE_URL');
		expect(fatal[0].value).not.toContain('supersecret');
	});

	it('reports every ignored data-location variable at once', () => {
		const { fatal } = detectRemovedEnvVars(
			{ HEZO_DATA_DIR: '/var/lib/hezo', HEZO_DATABASE_URL: 'postgres://h/db' },
			at('/root/.hezo'),
		);
		expect(fatal.map((f) => f.name)).toEqual(['HEZO_DATABASE_URL', 'HEZO_DATA_DIR']);
	});

	it('only warns for a setting that merely reverted to its default', () => {
		const { fatal, warnings } = detectRemovedEnvVars(
			{ HEZO_LOG_LEVEL: 'debug', HEZO_PORT: '8080', HEZO_WAKEUP_CRON: '* * * * * *' },
			at('/var/lib/hezo'),
		);
		expect(fatal).toEqual([]);
		expect(warnings.map((w) => w.name)).toEqual([
			'HEZO_LOG_LEVEL',
			'HEZO_PORT',
			'HEZO_WAKEUP_CRON',
		]);
		expect(warnings[0].replacement).toContain('logLevel');
	});

	it('redacts the Daytona API key even though it only warns', () => {
		const { warnings } = detectRemovedEnvVars({ HEZO_DAYTONA_API_KEY: 'dtn_live_abc' }, at('/d'));
		expect(warnings[0].value).not.toContain('dtn_live_abc');
	});

	it('ignores an empty value, which sets nothing', () => {
		expect(detectRemovedEnvVars({ HEZO_DATA_DIR: '' }, at('/root/.hezo')).fatal).toEqual([]);
	});

	it('never reports an env var that is still read', () => {
		// A prefix scan over HEZO_* would break every one of these.
		const live = {
			HEZO_MASTER_KEY: 'abandon abandon abandon',
			HEZO_WORKER: '1',
			HEZO_SKIP_DOCKER: '1',
			HEZO_TEST_SCRYPT_LOG_N: '1',
			HEZO_TEAM_ID: 'team-uuid',
			HEZO_MARKETPLACE_DIR: '/repo/marketplace',
		};
		const report = detectRemovedEnvVars(live, at('/var/lib/hezo'));
		expect(report).toEqual({ fatal: [], warnings: [] });
	});
});

describe('the removed-variable table', () => {
	it('names no variable the server still reads', () => {
		// A variable listed here but still read would make the check lie: the
		// operator is told it does nothing while it quietly keeps working.
		const src = join(import.meta.dirname, '../src');
		const files: string[] = [];
		const walk = (dir: string): void => {
			for (const entry of readdirSync(dir, { withFileTypes: true })) {
				const path = join(dir, entry.name);
				if (entry.isDirectory()) walk(path);
				else if (entry.name.endsWith('.ts') && entry.name !== 'removed-env.ts') files.push(path);
			}
		};
		walk(src);

		const stillRead: string[] = [];
		for (const name of Object.keys(REMOVED_ENV_VARS)) {
			const read = new RegExp(`env(\\.${name}\\b|\\[['"\`]${name}['"\`]\\])`);
			for (const file of files) {
				if (read.test(readFileSync(file, 'utf8'))) {
					stillRead.push(`${name} in ${file.slice(src.length + 1)}`);
					break;
				}
			}
		}
		expect(stillRead).toEqual([]);
	});

	it('gives every entry a replacement naming a config key or a flag', () => {
		for (const [name, spec] of Object.entries(REMOVED_ENV_VARS)) {
			expect(spec.replacement, name).toMatch(/config-file key|--/);
		}
	});

	it('marks exactly the three data-location variables fatal', () => {
		const fatal = Object.entries(REMOVED_ENV_VARS)
			.filter(([, spec]) => spec.severity === 'fatal')
			.map(([name]) => name)
			.sort();
		expect(fatal).toEqual(['HEZO_ASSET_STORAGE_URL', 'HEZO_DATABASE_URL', 'HEZO_DATA_DIR']);
	});
});

describe('the operator-facing messages', () => {
	it('says what was ignored, what is in effect, and how to fix it', () => {
		const { fatal } = detectRemovedEnvVars({ HEZO_DATA_DIR: '/var/lib/hezo' }, at('/root/.hezo'));
		const message = formatRemovedEnvFatal(fatal);
		expect(message).toContain('HEZO_DATA_DIR=/var/lib/hezo');
		expect(message).toContain('/root/.hezo');
		expect(message).toContain('--data-dir');
		expect(message).toContain('hezo.ai/docs/deployment/configuration');
		// The symptom the operator actually saw, so they can match the two up.
		expect(message).toContain('master-key setup page');
	});

	it('counts them when more than one is ignored, which is the managed-hosting case', () => {
		// An instance on external Postgres plus object storage loses both at once,
		// so the plural branch is the one those operators actually read.
		const { fatal } = detectRemovedEnvVars(
			{
				HEZO_DATA_DIR: '/var/lib/hezo',
				HEZO_DATABASE_URL: 'postgres://hezo:pw@db.example.com:5432/hezo',
				HEZO_ASSET_STORAGE_URL: 's3://k:s@account.r2.cloudflarestorage.com/bucket',
			},
			at('/root/.hezo'),
		);
		const message = formatRemovedEnvFatal(fatal);
		expect(message).toContain('3 environment variables are set');
		for (const name of ['HEZO_DATA_DIR', 'HEZO_DATABASE_URL', 'HEZO_ASSET_STORAGE_URL']) {
			expect(message, name).toContain(name);
		}
		// Neither credential survives into the message.
		expect(message).not.toContain('pw@');
		expect(message).not.toContain('k:s@');
		// Both fall back to a built-in default rather than to another configured value.
		expect(message).toContain('(the built-in default)');
	});

	it('lists each ignored setting once in the warning', () => {
		const { warnings } = detectRemovedEnvVars(
			{ HEZO_PORT: '8080', HEZO_TELEMETRY_ENABLED: '0' },
			at('/d'),
		);
		const message = formatRemovedEnvWarning(warnings);
		expect(message).toContain('HEZO_PORT -> ');
		expect(message).toContain('HEZO_TELEMETRY_ENABLED -> ');
	});

	it('uses no em or en dash, which operator-facing prose bans', () => {
		const { fatal } = detectRemovedEnvVars({ HEZO_DATA_DIR: '/a' }, at('/b'));
		const { warnings } = detectRemovedEnvVars({ HEZO_PORT: '1' }, at('/b'));
		expect(formatRemovedEnvFatal(fatal)).not.toMatch(/[–—]/);
		expect(formatRemovedEnvWarning(warnings)).not.toMatch(/[–—]/);
		for (const spec of Object.values(REMOVED_ENV_VARS)) {
			expect(spec.replacement).not.toMatch(/[–—]/);
		}
	});
});

describe('resolveConfig', () => {
	const argv = (...rest: string[]): string[] => ['bun', 'hezo', ...rest];

	it('refuses to start when a removed variable moves the data dir', () => {
		expect(() => resolveConfig(argv(), { HEZO_DATA_DIR: '/var/lib/hezo' })).toThrow(
			/HEZO_DATA_DIR/,
		);
	});

	it('starts when the flag matches the variable that is no longer read', () => {
		const config = resolveConfig(argv('--data-dir', '/var/lib/hezo'), {
			HEZO_DATA_DIR: '/var/lib/hezo',
		});
		expect(config.dataDir).toBe('/var/lib/hezo');
	});

	it('starts, but does not honour, a removed variable that only warns', () => {
		const config = resolveConfig(argv(), { HEZO_PORT: '8080' });
		expect(config.port).not.toBe(8080);
	});

	it('still accepts HEZO_MASTER_KEY, the one env var that survived', () => {
		const config = resolveConfig(argv(), {
			HEZO_MASTER_KEY:
				'legal winner thank year wave sausage worth useful legal winner thank yellow',
		});
		expect(config.masterKey?.unlockKeyHex).toBeTruthy();
	});
});

describe('configuration documentation after the environment-variable migration', () => {
	it('keeps the active hosted design on config-file settings', () => {
		const design = readFileSync(join(REPO_ROOT, '.dev/hosted-architecture.md'), 'utf8');
		const hezoEnvNames = [...new Set(design.match(/\bHEZO_[A-Z0-9_]+\b/g) ?? [])].sort();

		expect(design).toContain('/etc/hezo/hezo.config.cjs');
		expect(design).not.toContain('/etc/hezo/hezo.env');
		expect(design).toContain('`sso.issuerUrl`');
		expect(design).toContain('`sso.logoutUrl`');
		expect(design).toContain('`sso.issuerPublicKey`');
		expect(design).toContain('`sso.ownerSubject`');
		expect(design).toContain('`sso.audience`');
		expect(hezoEnvNames).toEqual(['HEZO_IMAGE_BUILD', 'HEZO_MASTER_KEY']);
	});

	it('keeps hosted recovery and logout claims consistent with runtime state', () => {
		const design = readFileSync(join(REPO_ROOT, '.dev/hosted-architecture.md'), 'utf8');
		const oneClick = readFileSync(join(REPO_ROOT, 'docs/deployment/one-click.md'), 'utf8');
		const cloud = readFileSync(join(REPO_ROOT, 'docs/deployment/cloud.md'), 'utf8');
		const publicDocs = `${oneClick}\n${cloud}`;

		expect(design).toMatch(/the\s+droplet still carries required local state/);
		expect(design).toMatch(/Restore `\/var\/lib\/hezo` from backup/);
		expect(design).toContain('The export bundle includes `/var/lib/hezo`');
		expect(design).toMatch(/The cold archive includes\s+the final `\/var\/lib\/hezo` snapshot/);
		expect(design).toMatch(
			/verify the `\/var\/lib\/hezo` snapshot before destroying\s+the droplet/,
		);
		expect(design).toContain(
			'`dataDir` | `/var/lib/hezo` | persistent workspaces, worktrees, and instance keys',
		);
		expect(design).toContain('database dump + bucket export + `dataDir` archive');
		expect(design).toMatch(/Logout is a two-session browser flow/);
		expect(design).toMatch(/Neither step revokes the instance JWT\s+server-side/);
		expect(design).toContain('SSO tokens assert identity only');
		expect(design).toContain('historical planning record');
		expect(design).toMatch(
			/The former\s+`unlock_key` field and `system:unlock` subject are obsolete/,
		);
		expect(oneClick).toContain('Managed backends do not make the server disposable');
		expect(oneClick).toContain('`/var/lib/hezo` still holds workspaces and keys');
		expect(oneClick).toMatch(
			/`\/var\/lib\/hezo` still holds workspaces and keys\s+-\s+keep backing it up/,
		);
		expect(cloud).toContain('Managed backends do not replace a `dataDir` backup');
		expect(cloud).toContain('workspaces, worktrees, and instance keys');
		expect(publicDocs).not.toContain('little worth losing');
		expect(publicDocs).not.toContain('nearly stateless');
		expect(design).not.toContain('near-stateless');
		expect(design).not.toContain('without data loss');
		expect(design).not.toContain('scratch only');
		expect(design).not.toContain('Logout stays instance-local');
		expect(design).not.toContain('the token carries the unlock key');
		expect(design.match(/unlock_key/g)).toHaveLength(1);
		expect(design.match(/system:unlock/g)).toHaveLength(1);
		expect(design).not.toContain('unlock-key custody');
		expect(design).not.toContain('proactive re-unlock');
		expect(design).not.toContain('auto-unlock');
	});

	it.each([
		'docs/getting-started/installation.md',
		'docs/deployment/container-runtimes.md',
	])('%s describes the configuration reference as config-file settings and flags', (rel) => {
		const doc = readFileSync(join(REPO_ROOT, rel), 'utf8');
		expect(doc).toMatch(/config-file settings\s+and flags/);
		expect(doc).not.toContain('every flag and environment variable');
	});
});

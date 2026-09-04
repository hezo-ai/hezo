import { execFileSync, spawnSync } from 'node:child_process';
import {
	existsSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = join(import.meta.dirname, '../../..');

/**
 * The deploy scripts run as root on a fresh host, install packages and rewrite
 * the firewall. Nothing here can execute them, so this covers the two things a
 * static check genuinely can: that they parse, and that the behind-a-gateway
 * flag actually gates the parts that would fight the gateway.
 *
 * A syntax error in one of these is invisible until a real provision run fails
 * halfway through, having already half-configured the host.
 */

const DEPLOY = join(REPO_ROOT, 'deploy');
const PROVISION = readFileSync(join(DEPLOY, 'provision.sh'), 'utf8');
const CLOUD_INIT = readFileSync(join(DEPLOY, 'cloud-init/hezo.cloud-config.yaml'), 'utf8');
const ONE_CLICK = readFileSync(join(REPO_ROOT, 'docs/deployment/one-click.md'), 'utf8');
const SELF_HOSTING = readFileSync(join(REPO_ROOT, 'docs/deployment/self-hosting.md'), 'utf8');
const SECURE_REMOTE_ACCESS = readFileSync(
	join(REPO_ROOT, 'docs/deployment/secure-remote-access.md'),
	'utf8',
);
const BACKUP = readFileSync(join(REPO_ROOT, 'docs/deployment/backup-and-recovery.md'), 'utf8');
const CLOUD = readFileSync(join(REPO_ROOT, 'docs/deployment/cloud.md'), 'utf8');
const CONFIGURATION = readFileSync(join(REPO_ROOT, 'docs/deployment/configuration.md'), 'utf8');
const CLI = readFileSync(join(REPO_ROOT, 'docs/reference/cli.md'), 'utf8');
const FIRST_RUN = readFileSync(join(REPO_ROOT, 'docs/getting-started/first-run.md'), 'utf8');
const MASTER_KEY = readFileSync(join(REPO_ROOT, 'docs/security/master-key.md'), 'utf8');
const ARCHITECTURE = readFileSync(join(REPO_ROOT, '.dev/architecture.md'), 'utf8');
const HOSTED_ARCHITECTURE = readFileSync(join(REPO_ROOT, '.dev/hosted-architecture.md'), 'utf8');
const CLOUD_REQUIREMENTS = readFileSync(join(REPO_ROOT, '.dev/hezo-cloud-requirements.md'), 'utf8');
const GCP_TUTORIAL = readFileSync(join(REPO_ROOT, 'deploy/gcp/tutorial.md'), 'utf8');

function shellScripts(dir: string): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) out.push(...shellScripts(path));
		else if (entry.name.endsWith('.sh')) out.push(path);
	}
	return out;
}

/**
 * The provisioner's config adapter, lifted out of provision.sh so it can run
 * against a throwaway /etc/hezo. Sections 1a and 4 are taken verbatim; the only
 * substitution is the validator, which in production shells out to the binary
 * section 3 just installed and here calls the same `loadConfigFile` directly.
 */
function configAdapterScript(): string {
	const RULE = '# ---------------------------------------------------------------------------';
	function between(from: string, to: string, after = 0): string {
		const start = PROVISION.indexOf(from, after);
		const end = PROVISION.indexOf(to, start + from.length);
		expect(start, `provision.sh boundary: ${from}`).toBeGreaterThan(-1);
		expect(end, `provision.sh boundary: ${to}`).toBeGreaterThan(start);
		return PROVISION.slice(start, end);
	}

	const productionValidator = `import { loadConfigFile } from ${JSON.stringify(join(REPO_ROOT, 'packages/server/src/config/load.ts'))}; loadConfigFile(process.argv[1]);`;
	return (
		[
			'log() { :; }',
			// Serializer constants and json_string.
			between('GENERATED_CONFIG_HEADER=', RULE),
			// load_env_file and the deploy.env read.
			between('# Cloud-init can seed optional settings', '# Resolved once so every branch below'),
			// Section 1a: the provenance helpers.
			between("# Hezo's real CommonJS loader", `${RULE}\n# 1. Swap file`),
			// Section 4, as far as the data directory: classify, then carry the legacy file.
			between('CONFIG_PROVEN_GENERATED=""', '# The data directory the config above will name'),
			// `install -d "${DATA_DIR}"` sits between these two slices and is deliberately
			// skipped: tests name absolute paths to pin down how a value is serialized, and
			// a harness must not create directories on the machine running it.
			// The rest of section 4: generate, install, retire the legacy sources.
			`${between('CONFIG_CANDIDATE=""', `${RULE}\n# 5. Caddy`)}\ntrue`,
		]
			.join('\n')
			// The one path the harness redirects, so a test can point at its own temp dir.
			.replace('LEGACY_ENV="/etc/hezo/hezo.env"', `LEGACY_ENV="\${LEGACY_ENV}"`)
			.replace(
				`/usr/local/bin/hezo config validate --config "\${path}" >/dev/null 2>&1`,
				`bun -e ${JSON.stringify(productionValidator)} "\${path}" >/dev/null 2>&1`,
			)
	);
}

interface GeneratedConfig {
	dataDir: string;
	webUrl: string;
	database?: { url?: string; poolSize?: number };
	assetStorage?: { url: string };
}

/** The starting state of one throwaway /etc/hezo, plus how to disturb the run. */
interface ProvisionSetup {
	/** Exact bytes already at the config path. Omitted means a host with none. */
	config?: string | ((paths: ProvisionPaths) => string);
	/** Exact bytes of deploy.env. Defaults to empty. */
	deployEnv?: string;
	/** Exact bytes of a pre-0.50 hezo.env. Omitted means a host without one. */
	legacy?: string;
	/** Shell inputs, overriding the defaults below. */
	env?: Record<string, string>;
	/** Rewrite the script to force a failure partway, as an interrupted run would. */
	mutate?: (script: string) => string;
	/** Give the web-url side file a name with quotes and a backslash in it. */
	awkwardWebUrlPath?: boolean;
}

interface ProvisionPaths {
	dir: string;
	configFile: string;
	deployEnvFile: string;
	legacyFile: string;
	webUrlFile: string;
	dataDir: string;
	/** A path the run must never create: proof no value was executed as shell. */
	commandMarker: string;
}

interface ProvisionResult extends ProvisionPaths {
	status: number;
	stderr: string;
	/** The three credential-bearing files as they were before the run. */
	before: { config: string; deployEnv: string; legacy: string };
	configExists: boolean;
	configText: string;
	configMode?: number;
	/** The config as Node loads it, or undefined when it is absent or unloadable. */
	config?: GeneratedConfig;
	deployEnvText: string;
	legacyText: string;
	legacyMigrated: boolean;
	commandExecuted: boolean;
	/** Candidate files the run should have cleaned up after itself. */
	leftoverCandidates: string[];
}

function readIfPresent(path: string): string {
	return existsSync(path) ? readFileSync(path, 'utf8') : '';
}

/**
 * Run the config adapter over a fresh throwaway directory, hand the outcome to
 * `assertions`, and remove the directory whether or not they pass.
 */
function withProvision(setup: ProvisionSetup, assertions: (r: ProvisionResult) => void): void {
	const dir = mkdtempSync(join(tmpdir(), 'hezo-provision-'));
	try {
		const paths: ProvisionPaths = {
			dir,
			configFile: join(dir, 'hezo.config.cjs'),
			deployEnvFile: join(dir, 'deploy.env'),
			legacyFile: join(dir, 'hezo.env'),
			// Quotes and a backslash in the side-file path too: the same serializer
			// writes it as writes every credential the config carries.
			webUrlFile: join(dir, setup.awkwardWebUrlPath ? 'web-\'url\\"path' : 'web-url'),
			dataDir: join(dir, 'data'),
			commandMarker: join(dir, 'command-ran'),
		};
		const seedConfig = typeof setup.config === 'function' ? setup.config(paths) : setup.config;
		if (seedConfig !== undefined) writeFileSync(paths.configFile, seedConfig);
		writeFileSync(
			paths.deployEnvFile,
			(setup.deployEnv ?? '').replaceAll('__COMMAND_MARKER__', paths.commandMarker),
		);
		if (setup.legacy !== undefined) writeFileSync(paths.legacyFile, setup.legacy);
		const before = {
			config: readIfPresent(paths.configFile),
			deployEnv: readIfPresent(paths.deployEnvFile),
			legacy: readIfPresent(paths.legacyFile),
		};

		const base = configAdapterScript();
		const script = setup.mutate ? setup.mutate(base) : base;
		if (setup.mutate) expect(script, 'mutate() changed nothing').not.toBe(base);
		const run = spawnSync('bash', ['-c', `set -euo pipefail\n${script}`], {
			encoding: 'utf8',
			env: {
				...process.env,
				CONFIG_FILE: paths.configFile,
				DEPLOY_ENV: paths.deployEnvFile,
				LEGACY_ENV: paths.legacyFile,
				WEB_URL_FILE: paths.webUrlFile,
				DATA_DIR: paths.dataDir,
				LEGACY_ENV_CARRIED: '',
				BEHIND_GATEWAY: '',
				...setup.env,
			},
		});

		const configExists = existsSync(paths.configFile);
		let config: GeneratedConfig | undefined;
		if (configExists) {
			try {
				config = JSON.parse(
					execFileSync(
						process.execPath,
						[
							'-e',
							'process.stdout.write(JSON.stringify(require(process.argv[1])))',
							paths.configFile,
						],
						{ encoding: 'utf8', stdio: 'pipe' },
					),
				) as GeneratedConfig;
			} catch {
				config = undefined;
			}
		}

		assertions({
			...paths,
			status: run.status ?? 1,
			stderr: run.stderr,
			before,
			configExists,
			configText: readIfPresent(paths.configFile),
			configMode: configExists ? statSync(paths.configFile).mode & 0o777 : undefined,
			config,
			deployEnvText: readIfPresent(paths.deployEnvFile),
			legacyText: readIfPresent(paths.legacyFile),
			legacyMigrated: existsSync(`${paths.legacyFile}.migrated`),
			commandExecuted: existsSync(paths.commandMarker),
			leftoverCandidates: readdirSync(dir).filter((name) =>
				name.startsWith('hezo.config.cjs.tmp.'),
			),
		});
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
}

/** Assert a run left every credential-bearing file exactly as it found it. */
function expectNothingTouched(r: ProvisionResult): void {
	expect(r.configText).toBe(r.before.config);
	expect(r.deployEnvText).toBe(r.before.deployEnv);
	expect(r.legacyText).toBe(r.before.legacy);
	expect(r.legacyMigrated).toBe(false);
	expect(r.leftoverCandidates).toEqual([]);
}
function loadEnvFileDefinition(): string {
	const start = PROVISION.indexOf('load_env_file() {');
	const end = PROVISION.indexOf('\n}\n', start);
	expect(start).toBeGreaterThan(-1);
	expect(end).toBeGreaterThan(start);
	return PROVISION.slice(start, end + 3);
}

function legacyGeneratedConfigPrefix(webUrlFile: string, dataDir: string): string {
	return [
		'// Hezo configuration. Edit and restart: systemctl restart hezo',
		'// Reference: https://hezo.ai/docs/deployment/configuration',
		'//',
		'// Do NOT put your master key in this file. Hezo keeps it in memory only and comes up',
		'// locked after each restart by design; unlock it from the browser gate. A copy of the',
		'// key on disk next to the encrypted data would let anyone who reads this box decrypt',
		'// your vault.',
		"const { existsSync, readFileSync } = require('node:fs');",
		'',
		'// Written by hezo-firstboot on first boot (see /usr/local/sbin/hezo-firstboot.sh).',
		`const webUrlFile = '${webUrlFile}';`,
		'',
		'module.exports = {',
		`\tdataDir: '${dataDir}',`,
		"\twebUrl: existsSync(webUrlFile) ? readFileSync(webUrlFile, 'utf8').trim() : '',",
	].join('\n');
}

function completeLegacyGeneratedConfig(webUrlFile: string, dataDir: string): string {
	return [
		'// Hezo configuration. Edit and restart: systemctl restart hezo',
		'// Reference: https://hezo.ai/docs/deployment/configuration',
		'//',
		'// Do NOT put your master key in this file. Hezo keeps it in memory only and comes up',
		'// locked after each restart by design; unlock it from the browser gate. A copy of the',
		'// key on disk next to the encrypted data would let anyone who reads this box decrypt',
		'// your vault.',
		"const { existsSync, readFileSync } = require('node:fs');",
		'',
		'// Written by hezo-firstboot on first boot (see /usr/local/sbin/hezo-firstboot.sh).',
		`const webUrlFile = ${JSON.stringify(webUrlFile)};`,
		'',
		'module.exports = {',
		`\tdataDir: ${JSON.stringify(dataDir)},`,
		"\twebUrl: existsSync(webUrlFile) ? readFileSync(webUrlFile, 'utf8').trim() : '',",
		'\tdatabase: {',
		`\t\turl: ${JSON.stringify('postgres://hezo:legacy@db-host:5432/hezo?sslmode=require')},`,
		'\t\tpoolSize: 23,',
		'\t},',
		`\tassetStorage: { url: ${JSON.stringify('s3://legacy:secret@storage-host/bucket')} },`,
		'};',
		'',
	].join('\n');
}

describe('deploy shell scripts', () => {
	const scripts = shellScripts(DEPLOY);

	it('finds the scripts it means to check', () => {
		expect(scripts.length).toBeGreaterThan(0);
		expect(scripts.some((s) => s.endsWith('provision.sh'))).toBe(true);
	});

	it.each(
		shellScripts(DEPLOY).map((s) => [s.slice(REPO_ROOT.length + 1), s]),
	)('%s parses', (_name, path) => {
		expect(() => execFileSync('bash', ['-n', path], { stdio: 'pipe' })).not.toThrow();
	});
});

describe('the behind-a-gateway seam in provision.sh', () => {
	const script = PROVISION;

	/** The lines of the `if`/`else` arm that `marker` sits in. */
	function guardAbove(marker: string): string {
		const index = script.indexOf(marker);
		expect(index).toBeGreaterThan(-1);
		return script.slice(0, index);
	}

	// A second TLS listener races the gateway for port 80, then tries to answer an
	// ACME challenge for a name the gateway owns.
	it('gates the Caddy install', () => {
		expect(guardAbove('apt-get install -y caddy')).toMatch(
			/if \[\[ "\$\{BEHIND_GATEWAY\}" == "1" \]\]; then[\s\S]*else[\s\S]*$/,
		);
	});

	it('gates the public 80/443 rules', () => {
		const before = guardAbove('ufw allow 80/tcp');
		expect(before).toMatch(/if \[\[ "\$\{BEHIND_GATEWAY\}" == "1" \]\]; then[\s\S]*else\s*$/);
	});

	it('opens the app port to private ranges instead', () => {
		expect(script).toMatch(/ufw allow from "[$]\{cidr\}" to any port "[$]\{APP_PORT\}" proto tcp/);
		for (const cidr of ['10.0.0.0/8', '172.16.0.0/12', '192.168.0.0/16']) {
			expect(script).toContain(cidr);
		}
	});

	// The gateway owns the name; this host's own address is not it, and a derived
	// <ip>.sslip.io would resolve somewhere nothing is listening.
	it('refuses the flag without a domain override', () => {
		expect(script).toMatch(
			/BEHIND_GATEWAY\}" == "1" && -z "\$\{HEZO_DOMAIN_OVERRIDE:-\}"[\s\S]{0,400}exit 1/,
		);
	});

	it('names the app port once, so the proxy target and the firewall cannot drift', () => {
		expect(script.match(/\b3100\b/g) ?? []).toHaveLength(1);
		expect(script).toContain('APP_PORT=3100');
	});

	it('documents the flag where an operator reading the script will find it', () => {
		expect(script).toMatch(/^#\s+BEHIND_GATEWAY\s/m);
	});
});
describe('the one-click managed-backend configuration contract', () => {
	it.each([
		['the checked-in cloud-init file', CLOUD_INIT],
		['the one-click documentation sample', ONE_CLICK],
	])('%s seeds both managed-backend URLs through deploy.env', (_name, sample) => {
		expect(sample).toContain('/etc/hezo/deploy.env');
		expect(sample).toMatch(/provision\.sh persists them into the CommonJS config/);
		expect(sample).toMatch(
			/HEZO_DATABASE_URL=postgres:\/\/hezo:PASSWORD@db-host:5432\/hezo\?sslmode=require.*>> \/etc\/hezo\/deploy\.env/,
		);
		expect(sample).toMatch(
			/HEZO_ASSET_STORAGE_URL=s3:\/\/ACCESS_KEY:SECRET@endpoint\/bucket.*>> \/etc\/hezo\/deploy\.env/,
		);
	});

	// Everything the adapter can validate runs through the binary section 3 installs,
	// so nothing above may ask the binary the host arrived with.
	it('classifies the config only after the binary that validates it is in place', () => {
		const binaryInstall = PROVISION.indexOf('chmod +x /usr/local/bin/hezo');
		const validatorCall = PROVISION.indexOf(`generated_config_complete "\${CONFIG_FILE}"`);
		expect(binaryInstall).toBeGreaterThan(-1);
		expect(validatorCall).toBeGreaterThan(binaryInstall);
	});

	it('carries deploy.env inputs into the generated CommonJS config', () => {
		expect(PROVISION).toContain('DEPLOY_ENV="/etc/hezo/deploy.env"');
		expect(PROVISION).toContain('CONFIG_FILE="/etc/hezo/hezo.config.cjs"');
		expect(PROVISION).toContain('ExecStart=/usr/local/bin/hezo --config /etc/hezo/hezo.config.cjs');

		const databaseUrl = 'postgres://hezo:secret@db-host:5432/hezo?sslmode=require';
		const assetStorageUrl = 's3://access:secret@storage-host/bucket';
		withProvision(
			{
				deployEnv: [
					`HEZO_DATABASE_URL=${databaseUrl}`,
					'HEZO_DATABASE_POOL_SIZE=17',
					`HEZO_ASSET_STORAGE_URL=${assetStorageUrl}`,
					'',
				].join('\n'),
			},
			(r) => {
				expect(r.status).toBe(0);
				expect(r.config?.database).toEqual({ url: databaseUrl, poolSize: 17 });
				expect(r.config?.assetStorage).toEqual({ url: assetStorageUrl });
				expect(r.deployEnvText).toBe('');
				expect(r.configMode).toBe(0o600);
			},
		);

		expect(ONE_CLICK).toMatch(
			/At provision time[\s\S]*\/etc\/hezo\/deploy\.env[\s\S]*persists them into `\/etc\/hezo\/hezo\.config\.cjs`/,
		);
		expect(ONE_CLICK).toMatch(
			/Post-boot, or on an existing server[\s\S]*\/etc\/hezo\/hezo\.config\.cjs[\s\S]*database: \{ url: 'postgres:\/\/hezo:PASSWORD@db-host:5432\/hezo\?sslmode=require' \},[\s\S]*assetStorage: \{ url: 's3:\/\/ACCESS_KEY:SECRET@endpoint\/bucket' \},[\s\S]*systemctl restart hezo/,
		);
	});

	it('keeps literal firstboot settings while removing managed credentials from deploy.env', () => {
		withProvision(
			{
				deployEnv: [
					'HEZO_DOMAIN_OVERRIDE=hezo.example.test',
					'HEZO_SWAP_SIZE=2G',
					'BEHIND_GATEWAY=1',
					'HEZO_DATABASE_URL=postgres://hezo:password@db-host:5432/hezo',
					'HEZO_ASSET_STORAGE_URL=s3://key:secret@endpoint/bucket',
					'',
				].join('\n'),
			},
			(r) => {
				expect(r.status).toBe(0);
				expect(r.deployEnvText).toBe(
					[
						'HEZO_DOMAIN_OVERRIDE=hezo.example.test',
						'HEZO_SWAP_SIZE=2G',
						'BEHIND_GATEWAY=1',
						'',
					].join('\n'),
				);
			},
		);
	});

	// Every value below reaches the config through the same serializer, so a missed
	// escape in any one of them writes CommonJS that will not parse.
	it('preserves quotes and backslashes from deploy.env in every generated string value', () => {
		const dataDir = '/var/lib/hezo/user\'s\\"data';
		const databaseUrl = 'postgres://hezo:pa\'ss\\"word@db-host:5432/hezo';
		const assetUrl = 's3://key:sec\'ret\\"piece@endpoint/bucket';
		withProvision(
			{
				awkwardWebUrlPath: true,
				deployEnv: [
					`HEZO_DATA_DIR=${dataDir}`,
					`HEZO_ASSET_STORAGE_URL=${assetUrl}`,
					`HEZO_DATABASE_URL=${databaseUrl}`,
					'',
				].join('\n'),
			},
			(r) => {
				expect(r.stderr).toBe('');
				expect(r.status).toBe(0);
				expect(r.config).toMatchObject({
					assetStorage: { url: assetUrl },
					database: { url: databaseUrl },
					dataDir,
				});
			},
		);
	});

	it('serializes shell-provided control characters without changing their values', () => {
		const dataDir = '/var/lib/hezo/control\b\f\r\t';
		withProvision({ env: { DATA_DIR: dataDir } }, (r) => {
			expect(r.status).toBe(0);
			expect(r.config?.dataDir).toBe(dataDir);
		});
	});

	it('serializes persisted paths and managed-backend values as literal data', () => {
		expect(PROVISION).not.toMatch(/(?:^|\n)\s*(?:[.]|source)\s+\/etc\/hezo\/deploy\.env/m);
		const commandLiteral = '$(touch __COMMAND_MARKER__)';
		const databaseUrl = `postgres://hezo:pa'ss\\word\t${commandLiteral}@db-host:5432/hezo?note=`;
		const assetStorageUrl = `s3://access:se'cret\\word\t${commandLiteral}@storage-host/bucket?note=`;
		withProvision(
			{
				awkwardWebUrlPath: true,
				deployEnv: [
					`HEZO_DATABASE_URL=${databaseUrl}`,
					'HEZO_DATABASE_POOL_SIZE=17',
					`HEZO_ASSET_STORAGE_URL=${assetStorageUrl}`,
					'',
				].join('\n'),
			},
			(r) => {
				expect(r.status).toBe(0);
				const expectedDatabaseUrl = databaseUrl.replace('__COMMAND_MARKER__', r.commandMarker);
				const expectedAssetUrl = assetStorageUrl.replace('__COMMAND_MARKER__', r.commandMarker);
				expect(r.config?.dataDir).toBe(r.dataDir);
				expect(r.config?.database).toEqual({ url: expectedDatabaseUrl, poolSize: 17 });
				expect(r.config?.assetStorage).toEqual({ url: expectedAssetUrl });
				expect(r.commandExecuted).toBe(false);
				expect(r.deployEnvText).toBe('');
			},
		);
	});

	it('treats command substitutions in deploy.env values as data and removes the credential copy', () => {
		withProvision(
			{ deployEnv: 'HEZO_DATABASE_URL=postgres://hezo:$(touch __COMMAND_MARKER__)@db-host/hezo\n' },
			(r) => {
				expect(r.status).toBe(0);
				expect(r.commandExecuted).toBe(false);
				expect(r.config?.database?.url).toContain('$(touch ');
				expect(r.deployEnvText).toBe('');
			},
		);
	});

	it('parses the final managed setting without a trailing newline', () => {
		const assetStorageUrl = 's3://access:last-record@storage-host/bucket';
		withProvision({ deployEnv: `HEZO_ASSET_STORAGE_URL=${assetStorageUrl}` }, (r) => {
			expect(r.status).toBe(0);
			expect(r.config?.assetStorage?.url).toBe(assetStorageUrl);
		});
	});

	it.each([
		['1', 1],
		['100', 100],
	])('accepts database pool-size boundary %s', (poolSize, expected) => {
		withProvision({ deployEnv: `HEZO_DATABASE_POOL_SIZE=${poolSize}\n` }, (r) => {
			expect(r.status).toBe(0);
			expect(r.config?.database).toEqual({ poolSize: expected });
		});
	});

	// The pool size is the one value interpolated unquoted, so anything but a bare
	// integer lands as executable JavaScript in the generated config.
	it.each([
		'0',
		'101',
		'1; globalThis.injected = true',
		'10.5',
	])('rejects invalid database pool size %s before writing config', (poolSize) => {
		withProvision({ deployEnv: `HEZO_DATABASE_POOL_SIZE=${poolSize}\n` }, (r) => {
			expect(r.status).not.toBe(0);
			expect(r.configExists).toBe(false);
			expect(r.stderr).toContain('HEZO_DATABASE_POOL_SIZE must be an integer from 1 to 100');
		});
	});

	it('leaves an existing config untouched even when stale provision inputs are invalid', () => {
		withProvision(
			{
				config: 'module.exports = { dataDir: "/existing" };\n',
				deployEnv: 'HEZO_DATABASE_POOL_SIZE=not-a-number\n',
			},
			(r) => {
				expect(r.status).toBe(0);
				expect(r.config?.dataDir).toBe('/existing');
				expect(r.configText).toBe(r.before.config);
			},
		);
	});

	it('carries legacy values exactly and retires the legacy env only after writing config', () => {
		const dataDir = "/srv/hezo/legacy's\\data";
		const databaseUrl = "postgres://hezo:old'pass\\word@db-host:5432/hezo";
		const assetUrl = "s3://key:old'secret\\part@endpoint/bucket";
		withProvision(
			{
				legacy: [
					`HEZO_DATA_DIR=${dataDir}`,
					'HEZO_WEB_URL=https://legacy.example.test',
					`HEZO_DATABASE_URL=${databaseUrl}`,
					'HEZO_DATABASE_POOL_SIZE=17',
					`HEZO_ASSET_STORAGE_URL=${assetUrl}`,
					'',
				].join('\n'),
			},
			(r) => {
				expect(r.status).toBe(0);
				expect(r.config).toMatchObject({
					assetStorage: { url: assetUrl },
					database: { poolSize: 17, url: databaseUrl },
					dataDir,
					webUrl: 'https://legacy.example.test',
				});
				expect(r.legacyMigrated).toBe(true);
			},
		);
	});

	it('does not publish or scrub credentials after an interrupted config write', () => {
		withProvision(
			{
				deployEnv: 'HEZO_DATABASE_URL=postgres://hezo:sole-copy@db-host/hezo\n',
				mutate: (s) =>
					s.replace(
						`\techo "};" >>"\${CONFIG_CANDIDATE}"`,
						`\tprintf 'module.exports = {\\n' >>"\${CONFIG_CANDIDATE}"\n\tfalse`,
					),
			},
			(r) => {
				expect(r.status).not.toBe(0);
				expect(r.configExists).toBe(false);
				expectNothingTouched(r);
			},
		);
	});

	it('leaves the destination and newline-less credential source unchanged when validation fails', () => {
		withProvision(
			{
				config: (p) => legacyGeneratedConfigPrefix(p.webUrlFile, p.dataDir),
				deployEnv: 'HEZO_DATABASE_URL=postgres://hezo:sole-copy@db-host/hezo',
				mutate: (s) =>
					s.replace(`if ! generated_config_complete "\${CONFIG_CANDIDATE}" ||`, 'if ! false ||'),
			},
			(r) => {
				expect(r.status).not.toBe(0);
				expectNothingTouched(r);
			},
		);
	});

	it('replaces an interrupted generated config before scrubbing its credential source', () => {
		const databaseUrl = 'postgres://hezo:recovered@db-host:5432/hezo';
		withProvision(
			{ config: 'module.exports = {', deployEnv: `HEZO_DATABASE_URL=${databaseUrl}\n` },
			(r) => {
				expect(r.status).toBe(0);
				expect(r.config?.database?.url).toBe(databaseUrl);
				expect(r.deployEnvText).toBe('');
				expect(r.configMode).toBe(0o600);
			},
		);
	});

	it('recovers the complete legacy heredoc prefix left before the object closes', () => {
		const databaseUrl = 'postgres://hezo:recovered-prefix@db-host/hezo';
		withProvision(
			{
				config: (p) => legacyGeneratedConfigPrefix(p.webUrlFile, p.dataDir),
				deployEnv: `HEZO_DATABASE_URL=${databaseUrl}\n`,
			},
			(r) => {
				// The seeded prefix is an unterminated object: it cannot load at all.
				expect(r.before.config).not.toContain('};');
				expect(r.status).toBe(0);
				expect(r.config?.database?.url).toBe(databaseUrl);
				expect(r.deployEnvText).toBe('');
			},
		);
	});

	it('finishes legacy cleanup after config publication was interrupted before the rename', () => {
		const originalLegacy = 'HEZO_DATA_DIR=/srv/hezo-legacy';
		const seed = { config: 'module.exports = {', deployEnv: '', legacy: originalLegacy };
		withProvision(
			{
				...seed,
				mutate: (s) => s.replace(`mv "\${LEGACY_ENV}" "\${LEGACY_ENV}.migrated"`, 'false'),
			},
			(r) => {
				// The config is published, but the legacy source is still in place.
				expect(r.status).not.toBe(0);
				expect(r.config?.dataDir).toBe('/srv/hezo-legacy');
				expect(r.legacyText).toBe(originalLegacy);
				expect(r.legacyMigrated).toBe(false);

				// A rerun over that exact state finishes the rename rather than stalling.
				withProvision({ ...seed, config: r.configText }, (rerun) => {
					expect(rerun.status).toBe(0);
					expect(rerun.legacyMigrated).toBe(true);
					expect(rerun.configText).toBe(r.configText);
				});
			},
		);
	});

	it('finishes legacy cleanup for the complete config written by the pre-marker provisioner', () => {
		withProvision(
			{
				config: (p) => completeLegacyGeneratedConfig(p.webUrlFile, p.dataDir),
				deployEnv: '',
				legacy: [
					'HEZO_DATA_DIR=/srv/hezo-legacy',
					'HEZO_DATABASE_URL=postgres://hezo:legacy@db-host:5432/hezo?sslmode=require',
					'HEZO_DATABASE_POOL_SIZE=23',
					'HEZO_ASSET_STORAGE_URL=s3://legacy:secret@storage-host/bucket',
				].join('\n'),
			},
			(r) => {
				expect(r.status).toBe(0);
				// Recognized as this script's own earlier output, so cleanup is authorized -
				// but the config itself is not rewritten.
				expect(r.configText).toBe(r.before.config);
				expect(r.legacyMigrated).toBe(true);
			},
		);
	});

	it('recovers an interrupted pre-0.50 migration with every legacy setting intact', () => {
		const dataDir = '/srv/hezo-legacy-data';
		const databaseUrl = 'postgres://hezo:legacy@db-host:5432/hezo?sslmode=require';
		const assetStorageUrl = 's3://legacy:secret@storage-host/bucket';
		const webUrl = 'https://legacy.example.test';
		const originalLegacy = [
			`HEZO_DATA_DIR=${dataDir}`,
			`HEZO_WEB_URL=${webUrl}`,
			`HEZO_DATABASE_URL=${databaseUrl}`,
			'HEZO_DATABASE_POOL_SIZE=23',
			`HEZO_ASSET_STORAGE_URL=${assetStorageUrl}`,
		].join('\n');
		const seed = {
			config: [
				'// hezo-provision: generated',
				'// Hezo configuration. Edit and restart: systemctl restart hezo',
				'module.exports = {',
			].join('\n'),
			deployEnv: '',
			legacy: originalLegacy,
		};

		// A run that dies before the completion marker publishes nothing and retires
		// nothing, so the legacy file is still the only copy of these settings.
		withProvision(
			{
				...seed,
				mutate: (s) =>
					s.replace(
						`echo "\${GENERATED_CONFIG_COMPLETE_MARKER}" >>"\${CONFIG_CANDIDATE}"`,
						'false',
					),
			},
			(r) => {
				expect(r.status).not.toBe(0);
				expect(r.legacyText).toBe(originalLegacy);
				expect(r.legacyMigrated).toBe(false);
			},
		);

		withProvision(seed, (r) => {
			expect(r.status).toBe(0);
			expect(r.config).toMatchObject({
				assetStorage: { url: assetStorageUrl },
				database: { poolSize: 23, url: databaseUrl },
				dataDir,
				webUrl,
			});
			expect(r.legacyMigrated).toBe(true);
		});
	});

	it.each([
		[
			'a completion marker it kept',
			'/srv/hezo-operator',
			[
				'// Hezo configuration. Edit and restart: systemctl restart hezo',
				"const config = { dataDir: '/srv/hezo-operator' };",
				'module.exports = config;',
				'// hezo-provision: complete',
				'',
			].join('\n'),
		],
		[
			'the generated header and no marker',
			'/srv/hezo-markerless',
			[
				'// Hezo configuration. Edit and restart: systemctl restart hezo',
				"const config = { dataDir: '/srv/hezo-markerless' };",
				'module.exports = config;',
				'',
			].join('\n'),
		],
		[
			'the generated header and the generated export shape',
			'/srv/hezo-shaped',
			[
				'// Hezo configuration. Edit and restart: systemctl restart hezo',
				'module.exports = {',
				"\tdataDir: '/srv/hezo-shaped',",
				'};',
				'',
			].join('\n'),
		],
		[
			'a generated-start marker and no completion marker',
			'/srv/hezo-start-marker',
			[
				'// hezo-provision: generated',
				'// Hezo configuration. Edit and restart: systemctl restart hezo',
				"const config = { dataDir: '/srv/hezo-start-marker' };",
				'module.exports = config;',
				'',
			].join('\n'),
		],
	])('preserves a valid operator config byte-for-byte, and its credential sources, given %s', (_name, dataDir, operatorConfig) => {
		withProvision(
			{
				config: operatorConfig,
				// The sole remaining copy of this credential, with no trailing newline.
				deployEnv: 'HEZO_DATABASE_URL=postgres://hezo:sole-copy@db-host/hezo',
				legacy: 'HEZO_DATA_DIR=/srv/hezo-legacy',
			},
			(r) => {
				expect(r.status).toBe(0);
				expect(r.config?.dataDir).toBe(dataDir);
				expectNothingTouched(r);
			},
		);
	});

	it.each([
		[
			'CommonJS that cannot load',
			[
				'// Hezo configuration. Edit and restart: systemctl restart hezo',
				'module.exports = {',
				"\tdatabase: { url: 'postgres://hezo:pa'ss@db-host/hezo' },",
				'};',
			].join('\n'),
		],
		[
			'a syntactically valid but schema-invalid config',
			[
				'// Hezo configuration. Edit and restart: systemctl restart hezo',
				'module.exports = {',
				"\tdataDir: '/srv/hezo-operator',",
				'\tdatabase: { poolSize: 0 },',
				'};',
				'',
			].join('\n'),
		],
	])('stops loudly on %s, changing nothing', (_name, badConfig) => {
		withProvision(
			{
				config: badConfig,
				deployEnv: 'HEZO_DATABASE_URL=postgres://hezo:sole-copy@db-host/hezo',
				legacy: 'HEZO_DATA_DIR=/srv/hezo-legacy',
			},
			(r) => {
				expect(r.status).not.toBe(0);
				expect(r.stderr).toContain('does not load');
				expect(r.stderr).toContain('hezo config validate --config');
				expectNothingTouched(r);
			},
		);
	});

	it.each([
		[
			'web URL file expression',
			(config: string) =>
				config.replace(
					/^const webUrlFile = (.*);$/m,
					'const webUrlFile = $1; const operatorPath = "/operator/path";',
				),
		],
		[
			'data directory line',
			(config: string) =>
				config.replace(/^\tdataDir: (.*),$/m, '\tdataDir: $1, telemetry: { enabled: false },'),
		],
		[
			'database URL line',
			(config: string) => config.replace(/^\t\turl: (.*),$/m, '\t\turl: $1, poolSize: 31,'),
		],
		[
			'database pool expression',
			(config: string) => config.replace(/^\t\tpoolSize: 23,$/m, '\t\tpoolSize: 20 + 3,'),
		],
		[
			'asset storage line',
			(config: string) =>
				config.replace(
					/^\tassetStorage: \{ url: (.*) \},$/m,
					'\tassetStorage: { url: $1 }, telemetry: { endpoint: "https://operator.example" },',
				),
		],
	])('does not treat operator content on the generated %s as pre-marker provenance', (_name, edit) => {
		withProvision(
			{
				config: (p) => edit(completeLegacyGeneratedConfig(p.webUrlFile, p.dataDir)),
				legacy: 'HEZO_DATABASE_URL=postgres://hezo:sole-copy@db-host/hezo',
			},
			(r) => {
				expect(r.before.config).not.toBe(completeLegacyGeneratedConfig(r.webUrlFile, r.dataDir));
				expect(r.status).toBe(0);
				expectNothingTouched(r);
			},
		);
	});

	it('keeps hosted instances on the normal user-confirmed update flow', () => {
		expect(CLOUD_REQUIREMENTS).toMatch(/hosted writes no\s+`updates` block at all/);
		expect(CLOUD_REQUIREMENTS).toMatch(
			/hosted tenant confirms its own updates exactly like a self-hoster/,
		);
		expect(HOSTED_ARCHITECTURE).toMatch(/normal user-confirmed update\s+flow/i);
		expect(HOSTED_ARCHITECTURE).toMatch(/Hosted does not write an `updates`\s+block/);
		expect(HOSTED_ARCHITECTURE).not.toMatch(
			/hezo-fleet-agent|fleet agent|fleet state API|desired_version|fleet_token_hash|updates\.disabled/,
		);
		expect(HOSTED_ARCHITECTURE).toMatch(
			/supervised in-app update restart[^.]*hands the unlock key to the new process[^.]*memory/i,
		);
		expect(HOSTED_ARCHITECTURE).toMatch(
			/reboot, crash, or\s+direct service restart[^.]*locked[^.]*one-shot[^.]*--master-key[^.]*HEZO_MASTER_KEY/i,
		);
		expect(HOSTED_ARCHITECTURE).not.toMatch(/Updates and reboots[^.]*locked/i);
		expect(HOSTED_ARCHITECTURE).not.toMatch(/A restart leaves the\s+instance locked/i);
	});

	it.each([
		['backup guide', BACKUP],
		['self-hosting guide', SELF_HOSTING],
		['GCP tutorial', GCP_TUTORIAL],
		['cloud guide', CLOUD],
		['configuration guide', CONFIGURATION],
		['CLI reference', CLI],
		['architecture guide', ARCHITECTURE],
		['hosted design record', HOSTED_ARCHITECTURE],
	])('%s includes runtime inputs in full host recovery', (_name, guide) => {
		expect(guide).toMatch(/config file/i);
		expect(guide).toMatch(/backend credentials/i);
		expect(guide).toMatch(
			/referenced\s+files|files\s+(?:it|the config)\s+references|files referenced by\s+the config/i,
		);
		expect(guide).toMatch(/service\s+(?:definition|settings)|startup\s+flags/i);
	});

	it('separates cloud host reachability from unlocked agent execution', () => {
		expect(CLOUD).toMatch(
			/keeps the host reachable[\s\S]*Agent execution continues while the instance is unlocked/,
		);
		expect(CLOUD).not.toMatch(/keep working around the clock/i);
		expect(ONE_CLICK).toMatch(/host stays reachable[\s\S]*agent execution pauses/i);
		expect(ONE_CLICK).not.toMatch(/public, always-on Hezo/i);
	});

	it('puts the post-edit unlock step beside the one-click service restart', () => {
		expect(ONE_CLICK).toMatch(
			/systemctl restart hezo[\s\S]{0,300}unlock Hezo from the browser gate unless that startup received\s+one-shot `--master-key` or `HEZO_MASTER_KEY` input/i,
		);
	});

	it.each([
		['one-click guide', ONE_CLICK],
		['first-run guide', FIRST_RUN],
		['self-hosting guide', SELF_HOSTING],
		['master-key guide', MASTER_KEY],
		['secure remote-access guide', SECURE_REMOTE_ACCESS],
		['cloud guide', CLOUD],
		['hosted design record', HOSTED_ARCHITECTURE],
	])('%s states the complete restart and unlock boundary', (_name, guide) => {
		expect(guide).toMatch(
			/new (?:Hezo )?process[^.]*starts?[^.]*locked|default state for a new process/i,
		);
		expect(guide).toMatch(/in-app update|update restart/i);
		expect(guide).toMatch(/supervis(?:ed|or)/i);
		expect(guide).toMatch(/in memory/i);
		expect(guide).toMatch(/--master-key/);
		expect(guide).toMatch(/HEZO_MASTER_KEY/);
		expect(guide).toMatch(/reboot,\s+crash,\s+or\s+(?:direct\s+)?service restart[^.]*locked/i);
	});

	it.each([
		['architecture', '.dev/architecture.md'],
		['master-key manager', 'packages/server/src/crypto/master-key.ts'],
		['shared auth derivation', 'packages/shared/src/crypto/auth.ts'],
		['sandbox backend startup', 'packages/server/src/services/sandbox/backend-store.ts'],
		['sandbox backend store test', 'packages/server/test/sandbox-backend-store.test.ts'],
		['deferred backend startup test', 'packages/server/test/startup-deferred-backend.test.ts'],
		['pending sandbox backend', 'packages/server/src/services/sandbox/pending.ts'],
		['server startup', 'packages/server/src/startup.ts'],
		['runtime configuration types', 'packages/server/src/config/types.ts'],
		['unlock handoff', 'packages/server/src/lib/unlock-handoff.ts'],
		['job startup reconciliation', 'packages/server/src/services/job-manager.ts'],
		['chat startup reconciliation', 'packages/server/src/services/chat-session-manager.ts'],
		['auth throttle', 'packages/server/src/routes/auth.ts'],
		['SSO replay cache', 'packages/server/src/services/sso.ts'],
		['browser master-key authentication', 'packages/web/src/lib/auth.ts'],
		['English message catalog', 'packages/web/src/lib/i18n/catalog/en.json'],
		['configuration guide', 'docs/deployment/configuration.md'],
		['provisioner', 'deploy/provision.sh'],
	])('%s states the complete process unlock lifecycle', (_name, rel) => {
		const source = readFileSync(join(REPO_ROOT, rel), 'utf8');
		expect(source).toMatch(/new (?:Hezo )?process[^.]*locked by\s+(?:[*]\s*)?default/i);
		expect(source).toMatch(/supervis(?:ed|or)[^.]*in[- ]memory|in[- ]memory[^.]*supervisor/i);
		expect(source).toMatch(/--master-key[^.]*HEZO_MASTER_KEY|HEZO_MASTER_KEY[^.]*--master-key/i);
		expect(source).not.toMatch(
			/transits? (?:only|solely|exactly twice)|(?:comes back|boots?|starts?) locked after every restart|service restart[^.]*re-locks the instance|master key stays in memory until the process restarts/i,
		);
	});

	it.each([
		['architecture', '.dev/architecture.md'],
		['cloud requirements', '.dev/hezo-cloud-requirements.md'],
		['agent guidance', 'AGENTS.md'],
		['master-key manager', 'packages/server/src/crypto/master-key.ts'],
		['shared auth derivation', 'packages/shared/src/crypto/auth.ts'],
		['sandbox backend startup', 'packages/server/src/services/sandbox/backend-store.ts'],
		['sandbox backend store test', 'packages/server/test/sandbox-backend-store.test.ts'],
		['deferred backend startup test', 'packages/server/test/startup-deferred-backend.test.ts'],
		['pending sandbox backend', 'packages/server/src/services/sandbox/pending.ts'],
		['server startup', 'packages/server/src/startup.ts'],
		['runtime configuration types', 'packages/server/src/config/types.ts'],
		['unlock handoff', 'packages/server/src/lib/unlock-handoff.ts'],
		['job startup reconciliation', 'packages/server/src/services/job-manager.ts'],
		['chat startup reconciliation', 'packages/server/src/services/chat-session-manager.ts'],
		['auth throttle', 'packages/server/src/routes/auth.ts'],
		['SSO replay cache', 'packages/server/src/services/sso.ts'],
		['browser master-key authentication', 'packages/web/src/lib/auth.ts'],
		['update route', 'packages/server/src/routes/updates.ts'],
		['update banner', 'packages/web/src/components/update-banner.tsx'],
		['update status hook', 'packages/web/src/hooks/use-update-check.ts'],
		['master-key gate', 'packages/web/src/components/master-key-gate.tsx'],
		['locale switcher', 'packages/web/src/components/locale/locale-switcher.tsx'],
		['locale settings hook', 'packages/web/src/hooks/use-locale-settings.ts'],
		['root route', 'packages/web/src/routes/__root.tsx'],
		['SSO gate browser test', 'test/browser/sso-gate.spec.ts'],
		['English message catalog', 'packages/web/src/lib/i18n/catalog/en.json'],
		['configuration guide', 'docs/deployment/configuration.md'],
		['self-hosting guide', 'docs/deployment/self-hosting.md'],
		['provisioner', 'deploy/provision.sh'],
	])('%s contains no contradictory restart-lifecycle shorthand', (_name, rel) => {
		const source = readFileSync(join(REPO_ROOT, rel), 'utf8');
		expect(source).not.toMatch(
			/only by passing the master key on the command line|unless the master key was passed on the command line|survive a restart at all|no way in after any reboot|coming up locked after a restart is intended|cannot bring itself back unlocked|confirmation that warns about the master-key re-unlock|master key is configured at startup|unlock-on-restart|post-restart unlock|locked after a restart|locked is normal after any restart/i,
		);
	});

	it('marks the local-Docker hosted plan as superseded by Daytona', () => {
		expect(HOSTED_ARCHITECTURE).toMatch(/current authority[\s\S]*agent containers on Daytona/);
		expect(HOSTED_ARCHITECTURE).toMatch(/## Superseded historical recommendation/);
		expect(HOSTED_ARCHITECTURE).toMatch(/## Superseded historical topology/);
		expect(HOSTED_ARCHITECTURE).toMatch(/## Superseded historical DigitalOcean provisioning plan/);
		expect(HOSTED_ARCHITECTURE).not.toMatch(/^## Recommendation:/m);
	});

	it('parses retained first-boot settings as literal data', () => {
		// firstboot gets the provisioner's own parser verbatim, so the two cannot
		// drift into one that reads deploy.env as shell and one that does not.
		expect(PROVISION).toContain('declare -f load_env_file >>/usr/local/sbin/hezo-firstboot.sh');
		const call =
			"load_env_file /etc/hezo/deploy.env '^(HEZO_DOMAIN_OVERRIDE|HEZO_SWAP_SIZE|BEHIND_GATEWAY)$'";
		expect(PROVISION).toContain(call);
		expect(PROVISION).not.toMatch(/(?:^|\n)\s*(?:[.]|source)\s+\/etc\/hezo\/deploy\.env/m);

		const dir = mkdtempSync(join(tmpdir(), 'hezo-firstboot-literal-data-'));
		const deployEnv = join(dir, 'deploy.env');
		const executed = join(dir, 'literal-executed');
		const domain = `host-'\\-\t-$(touch ${executed})`;
		// No trailing newline: the sole retained setting must still be read.
		writeFileSync(deployEnv, `HEZO_SWAP_SIZE=6G\nHEZO_DOMAIN_OVERRIDE=${domain}`);
		try {
			const parser = [
				loadEnvFileDefinition(),
				call.replace('/etc/hezo/deploy.env', JSON.stringify(deployEnv)),
			].join('\n');
			const parsed = execFileSync(
				'bash',
				[
					'-c',
					`set -euo pipefail\n${parser}\nprintf '%s\\n%s' "\${HEZO_SWAP_SIZE}" "\${HEZO_DOMAIN_OVERRIDE}"`,
				],
				{ encoding: 'utf8' },
			);
			expect(parsed).toBe(`6G\n${domain}`);
			expect(() => readFileSync(executed)).toThrow();
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it('documents explicit backup flags above the config file and default', () => {
		expect(BACKUP).toMatch(
			/explicit\s+`--data-dir` flag first, then the `--config` file, then the default `~\/\.hezo`/,
		);
	});
});

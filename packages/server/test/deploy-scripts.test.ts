import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
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

function configAdapterScript(): string {
	const serializerStart = PROVISION.indexOf('GENERATED_CONFIG_HEADER=');
	const serializerEnd = PROVISION.indexOf(
		'# ---------------------------------------------------------------------------',
		serializerStart,
	);
	const envStart = PROVISION.indexOf('# Cloud-init can seed optional settings');
	const envEnd = PROVISION.indexOf('# Resolved once so every branch below');
	const migrationStart = PROVISION.indexOf('# 1a. Migrate a pre-0.50');
	const prepareStart = PROVISION.indexOf('CONFIG_READY=""', migrationStart);
	const prepareEnd = PROVISION.indexOf(
		'# ---------------------------------------------------------------------------',
		prepareStart,
	);
	const configSection = PROVISION.indexOf('# 4. Data directory + Hezo config file');
	const configStart = PROVISION.indexOf('CONFIG_CANDIDATE=""', configSection);
	const configEnd = PROVISION.indexOf(
		'# Now that the settings live in the config file',
		configStart,
	);
	const cleanupEnd = PROVISION.indexOf('# 5. Caddy', configEnd);
	for (const boundary of [
		serializerStart,
		serializerEnd,
		envStart,
		envEnd,
		migrationStart,
		prepareStart,
		prepareEnd,
		configSection,
		configStart,
		configEnd,
		cleanupEnd,
	]) {
		expect(boundary).toBeGreaterThan(-1);
	}
	const productionValidator = `import { loadConfigFile } from ${JSON.stringify(join(REPO_ROOT, 'packages/server/src/config/load.ts'))}; loadConfigFile(process.argv[1]);`;
	return [
		'log() { :; }',
		PROVISION.slice(serializerStart, serializerEnd),
		PROVISION.slice(envStart, envEnd),
		PROVISION.slice(migrationStart, prepareEnd).replace(
			'LEGACY_ENV="/etc/hezo/hezo.env"',
			`LEGACY_ENV="\${LEGACY_ENV:-/etc/hezo/hezo.env}"`,
		),
		`${PROVISION.slice(configStart, cleanupEnd)}\ntrue`,
	]
		.join('\n')
		.replace(
			`/usr/local/bin/hezo config validate --config "\${path}" >/dev/null 2>&1`,
			`bun -e ${JSON.stringify(productionValidator)} "\${path}" >/dev/null 2>&1`,
		);
}

/** The `load_env_file` definition provision.sh also copies into hezo-firstboot.sh. */
function loadEnvFileDefinition(): string {
	const start = PROVISION.indexOf('load_env_file() {');
	const end = PROVISION.indexOf('\n}\n', start);
	expect(start).toBeGreaterThan(-1);
	expect(end).toBeGreaterThan(start);
	return PROVISION.slice(start, end + 3);
}

function sha256(path: string): string {
	return createHash('sha256').update(readFileSync(path)).digest('hex');
}

interface GeneratedConfig {
	dataDir: string;
	webUrl: string;
	database?: { url?: string; poolSize?: number };
	assetStorage?: { url: string };
}

/**
 * Run the provisioner's config adapter over a throwaway /etc/hezo, and report
 * what it left behind. `mode` picks the starting state: a host with no config,
 * one an operator already edited, or one still carrying a pre-0.50 hezo.env.
 */
function runConfigAdapter(
	env: Record<string, string>,
	mode: 'fresh' | 'existing' | 'legacy' = 'fresh',
): {
	config?: GeneratedConfig;
	configExists: boolean;
	commandExecuted: boolean;
	deployEnvContents: string;
	legacyMigrated: boolean;
	stderr: string;
	status: number;
} {
	const dir = mkdtempSync(join(tmpdir(), 'hezo-provision-config-'));
	try {
		const configFile = join(dir, 'hezo.config.cjs');
		const commandMarker = join(dir, 'command-ran');
		const deployEnv = join(dir, 'deploy.env');
		const legacyEnv = join(dir, 'hezo.env');
		// Quotes and a backslash in the side-file path too: it is serialized by the
		// same function as every credential the config carries.
		const webUrlFile = join(dir, 'web-\'url\\"path');
		const { DEPLOY_CONTENT = '', LEGACY_CONTENT = '', ...adapterEnv } = env;
		writeFileSync(deployEnv, DEPLOY_CONTENT.replaceAll('__COMMAND_MARKER__', commandMarker));
		if (mode === 'legacy') writeFileSync(legacyEnv, LEGACY_CONTENT);
		if (mode === 'existing')
			writeFileSync(configFile, 'module.exports = { dataDir: "/existing" };\n');
		const result = spawnSync('bash', ['-c', `set -euo pipefail\n${configAdapterScript()}`], {
			encoding: 'utf8',
			env: {
				...process.env,
				CONFIG_FILE: configFile,
				DEPLOY_ENV: deployEnv,
				LEGACY_ENV: legacyEnv,
				WEB_URL_FILE: webUrlFile,
				DATA_DIR: join(dir, 'data'),
				LEGACY_ENV_CARRIED: '',
				BEHIND_GATEWAY: '',
				...adapterEnv,
			},
		});
		const configExists = existsSync(configFile);
		const config = configExists
			? (JSON.parse(
					execFileSync(
						process.execPath,
						['-e', 'process.stdout.write(JSON.stringify(require(process.argv[1])))', configFile],
						{ encoding: 'utf8' },
					),
				) as GeneratedConfig)
			: undefined;
		return {
			config,
			configExists,
			commandExecuted: existsSync(commandMarker),
			deployEnvContents: readFileSync(deployEnv, 'utf8'),
			legacyMigrated: existsSync(`${legacyEnv}.migrated`),
			stderr: result.stderr,
			status: result.status ?? 1,
		};
	} finally {
		rmSync(dir, { recursive: true, force: true });
	}
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

	it('carries deploy.env inputs into the generated CommonJS config', () => {
		expect(PROVISION).toContain('DEPLOY_ENV="/etc/hezo/deploy.env"');
		expect(PROVISION).toContain('CONFIG_FILE="/etc/hezo/hezo.config.cjs"');
		expect(PROVISION).toContain('ExecStart=/usr/local/bin/hezo --config /etc/hezo/hezo.config.cjs');

		const dir = mkdtempSync(join(tmpdir(), 'hezo-deploy-contract-'));
		const deployEnv = join(dir, 'deploy.env');
		const configFile = join(dir, 'hezo.config.cjs');
		const webUrlFile = join(dir, 'web-url');
		const legacyEnv = join(dir, 'hezo.env');
		const databaseUrl = 'postgres://hezo:secret@db-host:5432/hezo?sslmode=require';
		const assetStorageUrl = 's3://access:secret@storage-host/bucket';
		writeFileSync(
			deployEnv,
			[
				`HEZO_DATABASE_URL=${databaseUrl}`,
				'HEZO_DATABASE_POOL_SIZE=17',
				`HEZO_ASSET_STORAGE_URL=${assetStorageUrl}`,
				'',
			].join('\n'),
		);

		try {
			execFileSync(
				'bash',
				[
					'-c',
					[
						'set -euo pipefail',
						`DEPLOY_ENV=${JSON.stringify(deployEnv)}`,
						`CONFIG_FILE=${JSON.stringify(configFile)}`,
						`WEB_URL_FILE=${JSON.stringify(webUrlFile)}`,
						`DATA_DIR=${JSON.stringify(join(dir, 'data'))}`,
						`LEGACY_ENV=${JSON.stringify(legacyEnv)}`,
						'LEGACY_ENV_CARRIED=',
						'BEHIND_GATEWAY=',
						configAdapterScript(),
					].join('\n'),
				],
				{ stdio: 'pipe' },
			);

			const generated = JSON.parse(
				execFileSync(
					process.execPath,
					['-e', `process.stdout.write(JSON.stringify(require(${JSON.stringify(configFile)})))`],
					{ encoding: 'utf8' },
				),
			) as {
				database?: { url?: string; poolSize?: number };
				assetStorage?: { url?: string };
			};
			expect(generated.database).toEqual({ url: databaseUrl, poolSize: 17 });
			expect(generated.assetStorage).toEqual({ url: assetStorageUrl });
			expect(readFileSync(deployEnv, 'utf8')).toBe('');
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}

		expect(ONE_CLICK).toMatch(
			/At provision time[\s\S]*\/etc\/hezo\/deploy\.env[\s\S]*persists them into `\/etc\/hezo\/hezo\.config\.cjs`/,
		);
		expect(ONE_CLICK).toMatch(
			/Post-boot, or on an existing server[\s\S]*\/etc\/hezo\/hezo\.config\.cjs[\s\S]*database: \{ url: 'postgres:\/\/hezo:PASSWORD@db-host:5432\/hezo\?sslmode=require' \},[\s\S]*assetStorage: \{ url: 's3:\/\/ACCESS_KEY:SECRET@endpoint\/bucket' \},[\s\S]*systemctl restart hezo/,
		);
	});

	it('keeps literal firstboot settings while removing managed credentials from deploy.env', () => {
		const result = runConfigAdapter({
			DEPLOY_CONTENT: [
				'HEZO_DOMAIN_OVERRIDE=hezo.example.test',
				'HEZO_SWAP_SIZE=2G',
				'BEHIND_GATEWAY=1',
				'HEZO_DATABASE_URL=postgres://hezo:password@db-host:5432/hezo',
				'HEZO_ASSET_STORAGE_URL=s3://key:secret@endpoint/bucket',
				'',
			].join('\n'),
		});
		expect(result).toMatchObject({
			deployEnvContents: [
				'HEZO_DOMAIN_OVERRIDE=hezo.example.test',
				'HEZO_SWAP_SIZE=2G',
				'BEHIND_GATEWAY=1',
				'',
			].join('\n'),
			status: 0,
		});
	});

	// Every value below reaches the config through the same serializer, so a
	// missed escape in any one of them writes CommonJS that will not parse.
	it('preserves quotes and backslashes from deploy.env in every generated string value', () => {
		const dataDir = '/var/lib/hezo/user\'s\\"data';
		const databaseUrl = 'postgres://hezo:pa\'ss\\"word@db-host:5432/hezo';
		const assetUrl = 's3://key:sec\'ret\\"piece@endpoint/bucket';
		const result = runConfigAdapter({
			DEPLOY_CONTENT: [
				`HEZO_DATA_DIR=${dataDir}`,
				`HEZO_ASSET_STORAGE_URL=${assetUrl}`,
				`HEZO_DATABASE_URL=${databaseUrl}`,
				'',
			].join('\n'),
		});
		expect(result.status).toBe(0);
		expect(result.stderr).toBe('');
		expect(result.config).toMatchObject({
			assetStorage: { url: assetUrl },
			database: { url: databaseUrl },
			dataDir,
		});
	});

	it('treats command substitutions in deploy.env values as data and removes the credential copy', () => {
		const databaseUrl = 'postgres://hezo:$(touch __COMMAND_MARKER__)@db-host:5432/hezo';
		const result = runConfigAdapter({
			DEPLOY_CONTENT: `HEZO_DATABASE_URL=${databaseUrl}\n`,
		});
		expect(result).toMatchObject({
			commandExecuted: false,
			config: { database: { url: expect.stringContaining('$(touch ') } },
			deployEnvContents: '',
			status: 0,
		});
	});

	it('serializes shell-provided control characters without changing their values', () => {
		const dataDir = '/var/lib/hezo/control\b\f\r\t';
		const result = runConfigAdapter({ DATA_DIR: dataDir });
		expect(result).toMatchObject({ config: { dataDir }, status: 0 });
	});

	it('leaves an existing config untouched even when stale provision inputs are invalid', () => {
		const result = runConfigAdapter(
			{ DEPLOY_CONTENT: 'HEZO_DATABASE_POOL_SIZE=not-a-number\n' },
			'existing',
		);
		expect(result).toMatchObject({
			config: { dataDir: '/existing' },
			status: 0,
		});
	});

	it.each([
		['1', 1],
		['100', 100],
	])('accepts database pool-size boundary %s', (poolSize, expected) => {
		const result = runConfigAdapter({
			DEPLOY_CONTENT: `HEZO_DATABASE_POOL_SIZE=${poolSize}\n`,
		});
		expect(result).toMatchObject({
			config: { database: { poolSize: expected } },
			status: 0,
		});
	});

	// An unvalidated pool size is interpolated unquoted, so anything but a bare
	// integer lands as executable JavaScript in the generated config.
	it.each([
		'0',
		'101',
		'1; globalThis.injected = true',
		'10.5',
	])('rejects invalid database pool size %s before writing config', (poolSize) => {
		const result = runConfigAdapter({
			DEPLOY_CONTENT: `HEZO_DATABASE_POOL_SIZE=${poolSize}\n`,
		});
		expect(result.status).not.toBe(0);
		expect(result.configExists).toBe(false);
		expect(result.stderr).toContain('HEZO_DATABASE_POOL_SIZE must be an integer from 1 to 100');
	});

	it('carries legacy values exactly and retires the legacy env only after writing config', () => {
		const dataDir = "/srv/hezo/legacy's\\data";
		const databaseUrl = "postgres://hezo:old'pass\\word@db-host:5432/hezo";
		const assetUrl = "s3://key:old'secret\\part@endpoint/bucket";
		const result = runConfigAdapter(
			{
				LEGACY_CONTENT: [
					`HEZO_DATA_DIR=${dataDir}`,
					'HEZO_WEB_URL=https://legacy.example.test',
					`HEZO_DATABASE_URL=${databaseUrl}`,
					'HEZO_DATABASE_POOL_SIZE=17',
					`HEZO_ASSET_STORAGE_URL=${assetUrl}`,
					'',
				].join('\n'),
			},
			'legacy',
		);
		expect(result).toMatchObject({
			config: {
				assetStorage: { url: assetUrl },
				database: { poolSize: 17, url: databaseUrl },
				dataDir,
				webUrl: 'https://legacy.example.test',
			},
			legacyMigrated: true,
			status: 0,
		});
	});

	it('does not publish or scrub credentials after an interrupted config write', () => {
		const dir = mkdtempSync(join(tmpdir(), 'hezo-deploy-interrupted-'));
		const deployEnv = join(dir, 'deploy.env');
		const configFile = join(dir, 'hezo.config.cjs');
		const databaseUrl = 'postgres://hezo:only-copy@db-host:5432/hezo';
		const originalEnv = `HEZO_DATABASE_URL=${databaseUrl}\n`;
		writeFileSync(deployEnv, originalEnv);

		try {
			const interrupted = configAdapterScript().replace(
				`echo "};" >>"\${CONFIG_CANDIDATE}"`,
				`printf 'module.exports = {\\n' >>"\${CONFIG_CANDIDATE}"\nfalse`,
			);
			expect(interrupted).not.toBe(configAdapterScript());
			expect(() =>
				execFileSync('bash', ['-c', `set -euo pipefail\n${interrupted}`], {
					env: {
						...process.env,
						DEPLOY_ENV: deployEnv,
						CONFIG_FILE: configFile,
						WEB_URL_FILE: join(dir, 'web-url'),
						DATA_DIR: join(dir, 'data'),
						LEGACY_ENV: join(dir, 'hezo.env'),
						LEGACY_ENV_CARRIED: '',
						BEHIND_GATEWAY: '',
					},
					stdio: 'pipe',
				}),
			).toThrow();
			expect(existsSync(configFile)).toBe(false);
			expect(readdirSync(dir).some((name) => name.startsWith('hezo.config.cjs.tmp.'))).toBe(false);
			expect(readFileSync(deployEnv, 'utf8')).toBe(originalEnv);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it('does not trust a structurally complete legacy config that CommonJS cannot load', () => {
		const dir = mkdtempSync(join(tmpdir(), 'hezo-deploy-invalid-legacy-config-'));
		const deployEnv = join(dir, 'deploy.env');
		const configFile = join(dir, 'hezo.config.cjs');
		writeFileSync(deployEnv, "HEZO_DATABASE_URL=postgres://hezo:pa'ss@db-host/hezo");
		writeFileSync(
			configFile,
			[
				'// Hezo configuration. Edit and restart: systemctl restart hezo',
				'module.exports = {',
				"\tdatabase: { url: 'postgres://hezo:pa'ss@db-host/hezo' },",
				'};',
			].join('\n'),
		);
		const configHash = sha256(configFile);
		const sourceHash = sha256(deployEnv);

		try {
			expect(() =>
				execFileSync(process.execPath, ['-e', `require(${JSON.stringify(configFile)})`], {
					stdio: 'pipe',
				}),
			).toThrow();
			execFileSync('bash', ['-c', `set -euo pipefail\n${configAdapterScript()}`], {
				env: {
					...process.env,
					DEPLOY_ENV: deployEnv,
					CONFIG_FILE: configFile,
					WEB_URL_FILE: join(dir, 'web-url'),
					DATA_DIR: join(dir, 'data'),
					LEGACY_ENV: join(dir, 'hezo.env'),
					BEHIND_GATEWAY: '',
				},
				stdio: 'pipe',
			});

			expect(sha256(configFile)).toBe(configHash);
			expect(sha256(deployEnv)).toBe(sourceHash);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it('leaves the destination and newline-less credential source unchanged when validation fails', () => {
		const dir = mkdtempSync(join(tmpdir(), 'hezo-deploy-validation-failure-'));
		const deployEnv = join(dir, 'deploy.env');
		const configFile = join(dir, 'hezo.config.cjs');
		const webUrlFile = join(dir, 'web-url');
		const dataDir = join(dir, 'data');
		writeFileSync(deployEnv, 'HEZO_DATABASE_URL=postgres://hezo:sole-copy@db-host/hezo');
		writeFileSync(configFile, legacyGeneratedConfigPrefix(webUrlFile, dataDir));
		const configHash = sha256(configFile);
		const sourceHash = sha256(deployEnv);
		const validationFailure = configAdapterScript().replace(
			`if ! generated_config_complete "\${CONFIG_CANDIDATE}" ||`,
			'if ! false ||',
		);
		expect(validationFailure).not.toBe(configAdapterScript());

		try {
			expect(() =>
				execFileSync('bash', ['-c', `set -euo pipefail\n${validationFailure}`], {
					env: {
						...process.env,
						DEPLOY_ENV: deployEnv,
						CONFIG_FILE: configFile,
						WEB_URL_FILE: webUrlFile,
						DATA_DIR: dataDir,
						LEGACY_ENV: join(dir, 'hezo.env'),
						BEHIND_GATEWAY: '',
					},
					stdio: 'pipe',
				}),
			).toThrow();
			expect(sha256(configFile)).toBe(configHash);
			expect(sha256(deployEnv)).toBe(sourceHash);
			expect(readdirSync(dir).some((name) => name.startsWith('hezo.config.cjs.tmp.'))).toBe(false);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it('replaces an interrupted generated config before scrubbing its credential source', () => {
		const dir = mkdtempSync(join(tmpdir(), 'hezo-deploy-recovery-'));
		const deployEnv = join(dir, 'deploy.env');
		const configFile = join(dir, 'hezo.config.cjs');
		const databaseUrl = 'postgres://hezo:recovered@db-host:5432/hezo';
		writeFileSync(deployEnv, `HEZO_DATABASE_URL=${databaseUrl}\n`);
		writeFileSync(configFile, 'module.exports = {');

		try {
			execFileSync('bash', ['-c', `set -euo pipefail\n${configAdapterScript()}`], {
				env: {
					...process.env,
					DEPLOY_ENV: deployEnv,
					CONFIG_FILE: configFile,
					WEB_URL_FILE: join(dir, 'web-url'),
					DATA_DIR: join(dir, 'data'),
					LEGACY_ENV: join(dir, 'hezo.env'),
					LEGACY_ENV_CARRIED: '',
					BEHIND_GATEWAY: '',
				},
				stdio: 'pipe',
			});
			const generated = JSON.parse(
				execFileSync(
					process.execPath,
					['-e', `process.stdout.write(JSON.stringify(require(${JSON.stringify(configFile)})))`],
					{ encoding: 'utf8' },
				),
			) as { database?: { url?: string } };
			expect(generated.database?.url).toBe(databaseUrl);
			expect(readFileSync(deployEnv, 'utf8')).toBe('');
			expect(statSync(configFile).mode & 0o777).toBe(0o600);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it('recovers the complete legacy heredoc prefix left before the object closes', () => {
		const dir = mkdtempSync(join(tmpdir(), 'hezo-deploy-legacy-prefix-recovery-'));
		const deployEnv = join(dir, 'deploy.env');
		const configFile = join(dir, 'hezo.config.cjs');
		const webUrlFile = join(dir, 'web-url');
		const databaseUrl = 'postgres://hezo:recovered-prefix@db-host/hezo';
		writeFileSync(deployEnv, `HEZO_DATABASE_URL=${databaseUrl}\n`);
		writeFileSync(configFile, legacyGeneratedConfigPrefix(webUrlFile, join(dir, 'data')));

		try {
			expect(() =>
				execFileSync(process.execPath, ['-e', `require(${JSON.stringify(configFile)})`], {
					stdio: 'pipe',
				}),
			).toThrow();
			execFileSync('bash', ['-c', `set -euo pipefail\n${configAdapterScript()}`], {
				env: {
					...process.env,
					DEPLOY_ENV: deployEnv,
					CONFIG_FILE: configFile,
					WEB_URL_FILE: webUrlFile,
					DATA_DIR: join(dir, 'data'),
					LEGACY_ENV: join(dir, 'hezo.env'),
					BEHIND_GATEWAY: '',
				},
				stdio: 'pipe',
			});
			const generated = JSON.parse(
				execFileSync(
					process.execPath,
					['-e', `process.stdout.write(JSON.stringify(require(${JSON.stringify(configFile)})))`],
					{ encoding: 'utf8' },
				),
			) as { database?: { url?: string } };
			expect(generated.database?.url).toBe(databaseUrl);
			expect(readFileSync(deployEnv, 'utf8')).toBe('');
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it('preserves a valid operator-edited CommonJS config byte-for-byte on rerun', () => {
		const dir = mkdtempSync(join(tmpdir(), 'hezo-deploy-operator-config-'));
		const configFile = join(dir, 'hezo.config.cjs');
		const operatorConfig = [
			'// Hezo configuration. Edit and restart: systemctl restart hezo',
			"const config = { dataDir: '/srv/hezo-operator' };",
			'module.exports = config;',
			'// hezo-provision: complete',
			'',
		].join('\n');
		writeFileSync(configFile, operatorConfig);

		try {
			const loaded = JSON.parse(
				execFileSync(
					process.execPath,
					['-e', `process.stdout.write(JSON.stringify(require(${JSON.stringify(configFile)})))`],
					{ encoding: 'utf8' },
				),
			) as { dataDir?: string };
			expect(loaded.dataDir).toBe('/srv/hezo-operator');

			execFileSync('bash', ['-c', `set -euo pipefail\n${configAdapterScript()}`], {
				env: {
					...process.env,
					DEPLOY_ENV: join(dir, 'deploy.env'),
					CONFIG_FILE: configFile,
					WEB_URL_FILE: join(dir, 'web-url'),
					DATA_DIR: join(dir, 'data'),
					LEGACY_ENV: join(dir, 'hezo.env'),
					BEHIND_GATEWAY: '',
				},
				stdio: 'pipe',
			});

			expect(readFileSync(configFile, 'utf8')).toBe(operatorConfig);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it('preserves a valid markerless operator config even when it retains the generated header', () => {
		const dir = mkdtempSync(join(tmpdir(), 'hezo-deploy-markerless-operator-config-'));
		const configFile = join(dir, 'hezo.config.cjs');
		const legacyEnv = join(dir, 'hezo.env');
		const originalLegacy = 'HEZO_DATA_DIR=/srv/hezo-legacy';
		const operatorConfig = [
			'// Hezo configuration. Edit and restart: systemctl restart hezo',
			"const config = { dataDir: '/srv/hezo-markerless' };",
			'module.exports = config;',
			'',
		].join('\n');
		writeFileSync(configFile, operatorConfig);
		writeFileSync(legacyEnv, originalLegacy);

		try {
			execFileSync('bash', ['-c', `set -euo pipefail\n${configAdapterScript()}`], {
				env: {
					...process.env,
					DEPLOY_ENV: join(dir, 'deploy.env'),
					CONFIG_FILE: configFile,
					WEB_URL_FILE: join(dir, 'web-url'),
					DATA_DIR: join(dir, 'data'),
					LEGACY_ENV: legacyEnv,
					BEHIND_GATEWAY: '',
				},
				stdio: 'pipe',
			});

			expect(readFileSync(configFile, 'utf8')).toBe(operatorConfig);
			expect(readFileSync(legacyEnv, 'utf8')).toBe(originalLegacy);
			expect(existsSync(`${legacyEnv}.migrated`)).toBe(false);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it('preserves a valid header-bearing operator config and its newline-less sole credential source', () => {
		const dir = mkdtempSync(join(tmpdir(), 'hezo-deploy-header-operator-config-'));
		const deployEnv = join(dir, 'deploy.env');
		const configFile = join(dir, 'hezo.config.cjs');
		const operatorConfig = [
			'// Hezo configuration. Edit and restart: systemctl restart hezo',
			'module.exports = {',
			"\tdataDir: '/srv/hezo-operator',",
			'};',
			'',
		].join('\n');
		writeFileSync(configFile, operatorConfig);
		writeFileSync(deployEnv, 'HEZO_DATABASE_URL=postgres://hezo:sole-copy@db-host/hezo');
		const configHash = sha256(configFile);
		const sourceHash = sha256(deployEnv);

		try {
			execFileSync('bash', ['-c', `set -euo pipefail\n${configAdapterScript()}`], {
				env: {
					...process.env,
					DEPLOY_ENV: deployEnv,
					CONFIG_FILE: configFile,
					WEB_URL_FILE: join(dir, 'web-url'),
					DATA_DIR: join(dir, 'data'),
					LEGACY_ENV: join(dir, 'hezo.env'),
					BEHIND_GATEWAY: '',
				},
				stdio: 'pipe',
			});

			expect(sha256(configFile)).toBe(configHash);
			expect(sha256(deployEnv)).toBe(sourceHash);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it('preserves a syntactically valid but schema-invalid config and its credential source', () => {
		const dir = mkdtempSync(join(tmpdir(), 'hezo-deploy-schema-invalid-config-'));
		const deployEnv = join(dir, 'deploy.env');
		const configFile = join(dir, 'hezo.config.cjs');
		const invalidConfig = [
			'// Hezo configuration. Edit and restart: systemctl restart hezo',
			'module.exports = {',
			"\tdataDir: '/srv/hezo-operator',",
			'\tdatabase: { poolSize: 0 },',
			'};',
			'',
		].join('\n');
		writeFileSync(configFile, invalidConfig);
		writeFileSync(deployEnv, 'HEZO_DATABASE_URL=postgres://hezo:sole-copy@db-host/hezo');
		const configHash = sha256(configFile);
		const sourceHash = sha256(deployEnv);
		expect(() =>
			execFileSync(process.execPath, ['-e', `require(${JSON.stringify(configFile)})`], {
				stdio: 'pipe',
			}),
		).not.toThrow();

		try {
			execFileSync('bash', ['-c', `set -euo pipefail\n${configAdapterScript()}`], {
				env: {
					...process.env,
					DEPLOY_ENV: deployEnv,
					CONFIG_FILE: configFile,
					WEB_URL_FILE: join(dir, 'web-url'),
					DATA_DIR: join(dir, 'data'),
					LEGACY_ENV: join(dir, 'hezo.env'),
					BEHIND_GATEWAY: '',
				},
				stdio: 'pipe',
			});

			expect(sha256(configFile)).toBe(configHash);
			expect(sha256(deployEnv)).toBe(sourceHash);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it('preserves a valid operator config with a generated-start marker and no completion marker', () => {
		const dir = mkdtempSync(join(tmpdir(), 'hezo-deploy-marked-operator-config-'));
		const configFile = join(dir, 'hezo.config.cjs');
		const operatorConfig = [
			'// hezo-provision: generated',
			'// Hezo configuration. Edit and restart: systemctl restart hezo',
			"const config = { dataDir: '/srv/hezo-marked-operator' };",
			'module.exports = config;',
			'',
		].join('\n');
		writeFileSync(configFile, operatorConfig);

		try {
			const loaded = JSON.parse(
				execFileSync(
					process.execPath,
					['-e', `process.stdout.write(JSON.stringify(require(${JSON.stringify(configFile)})))`],
					{ encoding: 'utf8' },
				),
			) as { dataDir?: string };
			expect(loaded.dataDir).toBe('/srv/hezo-marked-operator');

			execFileSync('bash', ['-c', `set -euo pipefail\n${configAdapterScript()}`], {
				env: {
					...process.env,
					DEPLOY_ENV: join(dir, 'deploy.env'),
					CONFIG_FILE: configFile,
					WEB_URL_FILE: join(dir, 'web-url'),
					DATA_DIR: join(dir, 'data'),
					LEGACY_ENV: join(dir, 'hezo.env'),
					BEHIND_GATEWAY: '',
				},
				stdio: 'pipe',
			});

			expect(readFileSync(configFile, 'utf8')).toBe(operatorConfig);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it('recovers an interrupted pre-0.50 migration with every legacy setting intact', () => {
		const dir = mkdtempSync(join(tmpdir(), 'hezo-deploy-legacy-recovery-'));
		const deployEnv = join(dir, 'deploy.env');
		const configFile = join(dir, 'hezo.config.cjs');
		const webUrlFile = join(dir, 'web-url');
		const legacyEnv = join(dir, 'hezo.env');
		const dataDir = join(dir, 'legacy-data');
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
		writeFileSync(deployEnv, '');
		writeFileSync(legacyEnv, originalLegacy);
		writeFileSync(
			configFile,
			[
				'// hezo-provision: generated',
				'// Hezo configuration. Edit and restart: systemctl restart hezo',
				'module.exports = {',
			].join('\n'),
		);

		const env = {
			...process.env,
			DEPLOY_ENV: deployEnv,
			CONFIG_FILE: configFile,
			WEB_URL_FILE: webUrlFile,
			DATA_DIR: join(dir, 'default-data'),
			LEGACY_ENV: legacyEnv,
			BEHIND_GATEWAY: '',
		};

		try {
			const interrupted = configAdapterScript().replace(
				`echo "\${GENERATED_CONFIG_COMPLETE_MARKER}" >>"\${CONFIG_CANDIDATE}"`,
				'false',
			);
			expect(interrupted).not.toBe(configAdapterScript());
			expect(() =>
				execFileSync('bash', ['-c', `set -euo pipefail\n${interrupted}`], {
					env,
					stdio: 'pipe',
				}),
			).toThrow();
			expect(readFileSync(legacyEnv, 'utf8')).toBe(originalLegacy);
			expect(existsSync(`${legacyEnv}.migrated`)).toBe(false);

			execFileSync('bash', ['-c', `set -euo pipefail\n${configAdapterScript()}`], {
				env,
				stdio: 'pipe',
			});
			const generated = JSON.parse(
				execFileSync(
					process.execPath,
					['-e', `process.stdout.write(JSON.stringify(require(${JSON.stringify(configFile)})))`],
					{ encoding: 'utf8' },
				),
			) as {
				dataDir?: string;
				webUrl?: string;
				database?: { url?: string; poolSize?: number };
				assetStorage?: { url?: string };
			};
			expect(generated).toEqual({
				dataDir,
				webUrl,
				database: { url: databaseUrl, poolSize: 23 },
				assetStorage: { url: assetStorageUrl },
			});
			expect(existsSync(legacyEnv)).toBe(false);
			expect(readFileSync(`${legacyEnv}.migrated`, 'utf8')).toBe(originalLegacy);
			expect(statSync(configFile).mode & 0o777).toBe(0o600);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it('finishes legacy cleanup after config publication was interrupted before the rename', () => {
		const dir = mkdtempSync(join(tmpdir(), 'hezo-deploy-idempotent-legacy-cleanup-'));
		const deployEnv = join(dir, 'deploy.env');
		const configFile = join(dir, 'hezo.config.cjs');
		const legacyEnv = join(dir, 'hezo.env');
		const originalLegacy = 'HEZO_DATA_DIR=/srv/hezo-legacy';
		writeFileSync(deployEnv, '');
		writeFileSync(legacyEnv, originalLegacy);
		writeFileSync(configFile, 'module.exports = {');
		const env = {
			...process.env,
			DEPLOY_ENV: deployEnv,
			CONFIG_FILE: configFile,
			WEB_URL_FILE: join(dir, 'web-url'),
			DATA_DIR: join(dir, 'default-data'),
			LEGACY_ENV: legacyEnv,
			BEHIND_GATEWAY: '',
		};

		try {
			const interruptedCleanup = configAdapterScript().replace(
				`mv "\${LEGACY_ENV}" "\${LEGACY_ENV}.migrated"`,
				'false',
			);
			expect(interruptedCleanup).not.toBe(configAdapterScript());
			expect(() =>
				execFileSync('bash', ['-c', `set -euo pipefail\n${interruptedCleanup}`], {
					env,
					stdio: 'pipe',
				}),
			).toThrow();
			expect(existsSync(configFile)).toBe(true);
			expect(readFileSync(legacyEnv, 'utf8')).toBe(originalLegacy);

			execFileSync('bash', ['-c', `set -euo pipefail\n${configAdapterScript()}`], {
				env,
				stdio: 'pipe',
			});
			expect(existsSync(legacyEnv)).toBe(false);
			expect(readFileSync(`${legacyEnv}.migrated`, 'utf8')).toBe(originalLegacy);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it('finishes legacy cleanup for the complete config written by the pre-marker provisioner', () => {
		const dir = mkdtempSync(join(tmpdir(), 'hezo-deploy-pre-marker-legacy-cleanup-'));
		const deployEnv = join(dir, 'deploy.env');
		const configFile = join(dir, 'hezo.config.cjs');
		const legacyEnv = join(dir, 'hezo.env');
		const originalLegacy = [
			`HEZO_DATA_DIR=${join(dir, 'legacy-data')}`,
			'HEZO_DATABASE_URL=postgres://hezo:legacy@db-host:5432/hezo?sslmode=require',
			'HEZO_DATABASE_POOL_SIZE=23',
			'HEZO_ASSET_STORAGE_URL=s3://legacy:secret@storage-host/bucket',
		].join('\n');
		const originalConfig = completeLegacyGeneratedConfig(
			join(dir, 'web-url'),
			join(dir, 'legacy-data'),
		);
		writeFileSync(deployEnv, '');
		writeFileSync(legacyEnv, originalLegacy);
		writeFileSync(configFile, originalConfig);

		try {
			execFileSync('bash', ['-c', `set -euo pipefail\n${configAdapterScript()}`], {
				env: {
					...process.env,
					DEPLOY_ENV: deployEnv,
					CONFIG_FILE: configFile,
					WEB_URL_FILE: join(dir, 'web-url'),
					DATA_DIR: join(dir, 'default-data'),
					LEGACY_ENV: legacyEnv,
					LEGACY_ENV_CARRIED: '',
					BEHIND_GATEWAY: '',
				},
				stdio: 'pipe',
			});

			expect(readFileSync(configFile, 'utf8')).toBe(originalConfig);
			expect(existsSync(legacyEnv)).toBe(false);
			expect(readFileSync(`${legacyEnv}.migrated`, 'utf8')).toBe(originalLegacy);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
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
	])('does not treat operator content on the generated %s as pre-marker provenance', (_name, mutate) => {
		const dir = mkdtempSync(join(tmpdir(), 'hezo-deploy-pre-marker-negative-'));
		const configFile = join(dir, 'hezo.config.cjs');
		const legacyEnv = join(dir, 'hezo.env');
		const operatorConfig = mutate(
			completeLegacyGeneratedConfig(join(dir, 'web-url'), join(dir, 'data')),
		);
		writeFileSync(configFile, operatorConfig);
		writeFileSync(legacyEnv, 'HEZO_DATABASE_URL=postgres://hezo:sole-copy@db-host/hezo');
		const configHash = sha256(configFile);
		const sourceHash = sha256(legacyEnv);

		try {
			execFileSync('bash', ['-c', `set -euo pipefail\n${configAdapterScript()}`], {
				env: {
					...process.env,
					DEPLOY_ENV: join(dir, 'deploy.env'),
					CONFIG_FILE: configFile,
					WEB_URL_FILE: join(dir, 'web-url'),
					DATA_DIR: join(dir, 'data'),
					LEGACY_ENV: legacyEnv,
					BEHIND_GATEWAY: '',
				},
				stdio: 'pipe',
			});

			expect(sha256(configFile)).toBe(configHash);
			expect(sha256(legacyEnv)).toBe(sourceHash);
			expect(existsSync(`${legacyEnv}.migrated`)).toBe(false);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it('parses the final managed setting without a trailing newline', () => {
		const dir = mkdtempSync(join(tmpdir(), 'hezo-deploy-no-final-newline-'));
		const deployEnv = join(dir, 'deploy.env');
		const configFile = join(dir, 'hezo.config.cjs');
		const assetStorageUrl = 's3://access:last-record@storage-host/bucket';
		writeFileSync(deployEnv, `HEZO_ASSET_STORAGE_URL=${assetStorageUrl}`);

		try {
			execFileSync('bash', ['-c', `set -euo pipefail\n${configAdapterScript()}`], {
				env: {
					...process.env,
					DEPLOY_ENV: deployEnv,
					CONFIG_FILE: configFile,
					WEB_URL_FILE: join(dir, 'web-url'),
					DATA_DIR: join(dir, 'data'),
					LEGACY_ENV: join(dir, 'hezo.env'),
					LEGACY_ENV_CARRIED: '',
					BEHIND_GATEWAY: '',
				},
				stdio: 'pipe',
			});
			const generated = JSON.parse(
				execFileSync(
					process.execPath,
					['-e', `process.stdout.write(JSON.stringify(require(${JSON.stringify(configFile)})))`],
					{ encoding: 'utf8' },
				),
			) as { assetStorage?: { url?: string } };
			expect(generated.assetStorage?.url).toBe(assetStorageUrl);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
	});

	it('serializes persisted paths and managed-backend values as literal data', () => {
		const dir = mkdtempSync(join(tmpdir(), 'hezo-deploy-literal-data-'));
		const deployEnv = join(dir, 'deploy.env');
		const configFile = join(dir, 'hezo.config.cjs');
		const webUrlFile = join(dir, 'web-url');
		const legacyEnv = join(dir, 'hezo.env');
		const executed = join(dir, 'literal-executed');
		const commandLiteral = `$(touch ${executed})`;
		const dataDir = join(dir, `data-'\\-\t-${commandLiteral}`);
		const databaseUrl = `postgres://hezo:pa'ss\\word\t${commandLiteral}@db-host:5432/hezo?note=\u0001`;
		const assetStorageUrl = `s3://access:se'cret\\word\t${commandLiteral}@storage-host/bucket?note=\u0002`;
		writeFileSync(
			deployEnv,
			[
				`HEZO_DATABASE_URL=${databaseUrl}`,
				'HEZO_DATABASE_POOL_SIZE=17',
				`HEZO_ASSET_STORAGE_URL=${assetStorageUrl}`,
				'',
			].join('\n'),
		);

		try {
			execFileSync('bash', ['-c', ['set -euo pipefail', configAdapterScript()].join('\n')], {
				env: {
					...process.env,
					DEPLOY_ENV: deployEnv,
					CONFIG_FILE: configFile,
					WEB_URL_FILE: webUrlFile,
					DATA_DIR: dataDir,
					LEGACY_ENV: legacyEnv,
					LEGACY_ENV_CARRIED: '',
					BEHIND_GATEWAY: '',
				},
				stdio: 'pipe',
			});

			const generated = JSON.parse(
				execFileSync(
					process.execPath,
					['-e', `process.stdout.write(JSON.stringify(require(${JSON.stringify(configFile)})))`],
					{ encoding: 'utf8' },
				),
			) as {
				dataDir?: string;
				database?: { url?: string; poolSize?: number };
				assetStorage?: { url?: string };
			};
			expect(generated.dataDir).toBe(dataDir);
			expect(generated.database).toEqual({ url: databaseUrl, poolSize: 17 });
			expect(generated.assetStorage).toEqual({ url: assetStorageUrl });
			const restarted = JSON.parse(
				execFileSync(
					process.execPath,
					['-e', `process.stdout.write(JSON.stringify(require(${JSON.stringify(configFile)})))`],
					{ encoding: 'utf8' },
				),
			);
			expect(restarted).toEqual(generated);
			expect(readFileSync(deployEnv, 'utf8')).toBe('');
			expect(() => readFileSync(executed)).toThrow();
			expect(PROVISION).not.toMatch(/(?:^|\n)\s*(?:[.]|source)\s+\/etc\/hezo\/deploy\.env/m);
		} finally {
			rmSync(dir, { recursive: true, force: true });
		}
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

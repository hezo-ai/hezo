import { execFileSync, spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const REPO_ROOT = join(import.meta.dirname, '../../..');

/**
 * The deploy scripts run as root on a fresh host, install packages and rewrite
 * the firewall. Static checks cover their syntax and gateway guards. The
 * config adapter is isolated in shell functions, so its file migration and
 * generated CommonJS can run against a temporary directory here.
 *
 * A syntax error in one of these is invisible until a real provision run fails
 * halfway through, having already half-configured the host.
 */

const DEPLOY = join(REPO_ROOT, 'deploy');
const PROVISION = readFileSync(join(DEPLOY, 'provision.sh'), 'utf8');
const CLOUD_INIT = readFileSync(join(DEPLOY, 'cloud-init/hezo.cloud-config.yaml'), 'utf8');
const ONE_CLICK = readFileSync(join(REPO_ROOT, 'docs/deployment/one-click.md'), 'utf8');

const CONFIG_FUNCTIONS_START = '# BEGIN CONFIG ADAPTER FUNCTIONS';
const CONFIG_FUNCTIONS_END = '# END CONFIG ADAPTER FUNCTIONS';

function configFunctions(): string {
	const start = PROVISION.indexOf(CONFIG_FUNCTIONS_START);
	const end = PROVISION.indexOf(CONFIG_FUNCTIONS_END);
	expect(start, 'config helper start marker').toBeGreaterThan(-1);
	expect(end, 'config helper end marker').toBeGreaterThan(start);
	return PROVISION.slice(start + CONFIG_FUNCTIONS_START.length, end);
}

interface GeneratedConfig {
	dataDir: string;
	webUrl: string;
	database?: { url?: string; poolSize?: number };
	assetStorage?: { url: string };
}

function runConfigAdapter(
	env: Record<string, string>,
	mode: 'existing' | 'legacy' | 'managed' = 'managed',
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
		const webUrlFile = join(dir, 'web-\'url\\"path');
		const { DEPLOY_CONTENT = '', LEGACY_CONTENT = '', ...adapterEnv } = env;
		if (DEPLOY_CONTENT)
			writeFileSync(deployEnv, DEPLOY_CONTENT.replaceAll('__COMMAND_MARKER__', commandMarker));
		if (mode === 'legacy') writeFileSync(legacyEnv, LEGACY_CONTENT);
		if (mode === 'existing')
			writeFileSync(configFile, 'module.exports = { dataDir: "/existing" };');
		const harness = join(dir, 'config-harness.sh');
		writeFileSync(
			harness,
			`set -euo pipefail\n${configFunctions()}\nlog() { :; }\n` +
				'load_env_file "$DEPLOY_ENV" \'^(HEZO_[A-Z_]+|BEHIND_GATEWAY)$\'\n' +
				`BEHIND_GATEWAY="\${BEHIND_GATEWAY:-}"\n` +
				'if [[ "$1" == "legacy" ]]; then\n' +
				'  load_legacy_config\n' +
				'fi\n' +
				`DATA_DIR="\${HEZO_DATA_DIR:-\${DATA_DIR}}"\n` +
				'if [[ ! -f "$CONFIG_FILE" ]]; then prepare_config_values || exit $?; fi\n' +
				'write_hezo_config\n' +
				'if [[ "$1" == "legacy" ]]; then retire_legacy_config; fi\n' +
				'write_firstboot_env\n',
		);
		const result = spawnSync('bash', [harness, mode], {
			encoding: 'utf8',
			env: {
				PATH: process.env.PATH ?? '/usr/bin:/bin',
				CONFIG_FILE: configFile,
				DEPLOY_ENV: deployEnv,
				LEGACY_ENV: legacyEnv,
				WEB_URL_FILE: webUrlFile,
				DATA_DIR: '/var/lib/hezo',
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

function shellScripts(dir: string): string[] {
	const out: string[] = [];
	for (const entry of readdirSync(dir, { withFileTypes: true })) {
		const path = join(dir, entry.name);
		if (entry.isDirectory()) out.push(...shellScripts(path));
		else if (entry.name.endsWith('.sh')) out.push(path);
	}
	return out;
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

	it('carries ordinary deploy.env inputs into the generated CommonJS config', () => {
		expect(PROVISION).toContain('DEPLOY_ENV="/etc/hezo/deploy.env"');
		expect(PROVISION).toContain(`done <"\${path}"`);
		expect(PROVISION).toContain(`export "\${key}=\${value}"`);
		expect(PROVISION).not.toMatch(/(?:^|\n)\s*(?:[.]|source)\s+\/etc\/hezo\/deploy\.env/m);
		expect(PROVISION).toContain('declare -f load_env_file >>/usr/local/sbin/hezo-firstboot.sh');
		expect(PROVISION).toContain(
			"load_env_file /etc/hezo/deploy.env '^(HEZO_DOMAIN_OVERRIDE|HEZO_SWAP_SIZE|BEHIND_GATEWAY)$'",
		);
		const result = runConfigAdapter({
			DEPLOY_CONTENT: [
				'HEZO_ASSET_STORAGE_URL=s3://ACCESS_KEY:SECRET@endpoint/bucket',
				'HEZO_DATABASE_POOL_SIZE=25',
				'HEZO_DATABASE_URL=postgres://hezo:PASSWORD@db-host:5432/hezo?sslmode=require',
				'',
			].join('\n'),
		});
		expect(result).toMatchObject({
			config: {
				assetStorage: { url: 's3://ACCESS_KEY:SECRET@endpoint/bucket' },
				database: {
					poolSize: 25,
					url: 'postgres://hezo:PASSWORD@db-host:5432/hezo?sslmode=require',
				},
			},
			deployEnvContents: '',
			status: 0,
		});
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
		const dataDir = '/var/lib/hezo/control\b\f\n\r\t\u0001';
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
});

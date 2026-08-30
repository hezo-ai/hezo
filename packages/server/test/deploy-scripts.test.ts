import { execFileSync } from 'node:child_process';
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
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
const BACKUP = readFileSync(join(REPO_ROOT, 'docs/deployment/backup-and-recovery.md'), 'utf8');
const HOSTED_ARCHITECTURE = readFileSync(join(REPO_ROOT, '.dev/hosted-architecture.md'), 'utf8');
const CLOUD_REQUIREMENTS = readFileSync(join(REPO_ROOT, '.dev/hezo-cloud-requirements.md'), 'utf8');

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
	const serializerStart = PROVISION.indexOf('json_string() {');
	const serializerEnd = PROVISION.indexOf(
		'# ---------------------------------------------------------------------------',
		serializerStart,
	);
	const envStart = PROVISION.indexOf('# Cloud-init can seed optional settings');
	const envEnd = PROVISION.indexOf('# Resolved once so every branch below');
	const dataDirStart = PROVISION.indexOf(`DATA_DIR="\${HEZO_DATA_DIR:-\${DATA_DIR}}"`);
	const prepareStart = PROVISION.indexOf(`if [[ ! -f "\${CONFIG_FILE}" ]]`, dataDirStart);
	const prepareEnd = PROVISION.indexOf(
		'# ---------------------------------------------------------------------------',
		prepareStart,
	);
	const configSection = PROVISION.indexOf('# 4. Data directory + Hezo config file');
	const configStart = PROVISION.indexOf(`if [[ ! -f "\${CONFIG_FILE}" ]]`, configSection);
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
		dataDirStart,
		prepareStart,
		prepareEnd,
		configSection,
		configStart,
		configEnd,
		cleanupEnd,
	]) {
		expect(boundary).toBeGreaterThan(-1);
	}
	return [
		PROVISION.slice(serializerStart, serializerEnd),
		PROVISION.slice(envStart, envEnd),
		PROVISION.slice(prepareStart, prepareEnd),
		`${PROVISION.slice(configStart, cleanupEnd)}\ntrue`,
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
	});

	it('parses retained first-boot settings as literal data', () => {
		const parserStart = PROVISION.indexOf('if [[ -f /etc/hezo/deploy.env ]]');
		const parserEnd = PROVISION.indexOf('# Ensure host swap exists', parserStart);
		expect(parserStart).toBeGreaterThan(-1);
		expect(parserEnd).toBeGreaterThan(parserStart);

		const dir = mkdtempSync(join(tmpdir(), 'hezo-firstboot-literal-data-'));
		const deployEnv = join(dir, 'deploy.env');
		const executed = join(dir, 'literal-executed');
		const domain = `host-'\\-\t-$(touch ${executed})`;
		writeFileSync(deployEnv, `HEZO_DOMAIN_OVERRIDE=${domain}\n`);
		try {
			const parser = PROVISION.slice(parserStart, parserEnd).replaceAll(
				'/etc/hezo/deploy.env',
				JSON.stringify(deployEnv),
			);
			const parsed = execFileSync(
				'bash',
				['-c', `set -euo pipefail\n${parser}\nprintf %s "\${HEZO_DOMAIN_OVERRIDE}"`],
				{ encoding: 'utf8' },
			);
			expect(parsed).toBe(domain);
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

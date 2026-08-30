import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
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

	it('carries deploy.env inputs into the generated CommonJS config', () => {
		expect(PROVISION).toContain('DEPLOY_ENV="/etc/hezo/deploy.env"');
		expect(PROVISION).toContain(`done <"\${DEPLOY_ENV}"`);
		expect(PROVISION).toContain(`export "\${key}=\${value}"`);
		expect(PROVISION).toMatch(
			/cat >"\$\{CONFIG_FILE\}" <<EOF[\s\S]*module\.exports = \{[\s\S]*dataDir:/,
		);
		expect(PROVISION).toContain(`url: '\${HEZO_DATABASE_URL}',`);
		expect(PROVISION).toContain(`poolSize: \${HEZO_DATABASE_POOL_SIZE},`);
		expect(PROVISION).toContain(`assetStorage: { url: '\${HEZO_ASSET_STORAGE_URL}' },`);
		expect(ONE_CLICK).toMatch(
			/At provision time[\s\S]*\/etc\/hezo\/deploy\.env[\s\S]*persists them into `\/etc\/hezo\/hezo\.config\.cjs`/,
		);
		expect(ONE_CLICK).toMatch(
			/Post-boot, or on an existing server[\s\S]*\/etc\/hezo\/hezo\.config\.cjs[\s\S]*database: \{ url: 'postgres:\/\/hezo:PASSWORD@db-host:5432\/hezo\?sslmode=require' \},[\s\S]*assetStorage: \{ url: 's3:\/\/ACCESS_KEY:SECRET@endpoint\/bucket' \},[\s\S]*systemctl restart hezo/,
		);
	});

	it('documents explicit backup flags above the config file and default', () => {
		expect(BACKUP).toMatch(
			/explicit\s+`--data-dir` flag first, then the `--config` file, then the default `~\/\.hezo`/,
		);
	});
});

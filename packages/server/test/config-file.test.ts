import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { loadConfigFile } from '../src/config/load';
import { resetRuntimeConfig, runtimeConfig, setRuntimeConfig } from '../src/config/runtime';
import { DEFAULT_CONFIG } from '../src/config/types';

// `require` caches by resolved path, so every fixture needs its own filename
// rather than one file rewritten between cases.
const dir = mkdtempSync(join(tmpdir(), 'hezo-config-file-'));
let seq = 0;
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function write(body: string): string {
	const path = join(dir, `c${seq++}.cjs`);
	writeFileSync(path, body);
	return path;
}

describe('loadConfigFile', () => {
	it('loads a plain object export', () => {
		const path = write("module.exports = { port: 4321, logLevel: 'debug' };");
		expect(loadConfigFile(path)).toEqual({ port: 4321, logLevel: 'debug' });
	});

	it('loads nested groups', () => {
		const path = write(
			"module.exports = { database: { url: 'postgres://h/db', poolSize: 20 }, jobs: { wakeupCron: '* * * * * *' } };",
		);
		expect(loadConfigFile(path)).toEqual({
			database: { url: 'postgres://h/db', poolSize: 20 },
			jobs: { wakeupCron: '* * * * * *' },
		});
	});

	it('runs the file as real JavaScript, so it can compute values', () => {
		// The property a `.cjs` config buys over a static format: an operator can
		// read a side file, which is how the systemd deploy supplies its webUrl.
		const side = join(dir, 'side-value');
		writeFileSync(side, '  https://hezo.example.com\n');
		const path = write(
			`const { readFileSync } = require('node:fs');\nmodule.exports = { webUrl: readFileSync(${JSON.stringify(side)}, 'utf8').trim() };`,
		);
		expect(loadConfigFile(path).webUrl).toBe('https://hezo.example.com');
	});

	it('names the path, not the compiled binary, when the file is missing', () => {
		const missing = join(dir, 'does-not-exist.cjs');
		// The module resolver's own message blames `/$bunfs/root/…` as the requiring
		// module in a compiled binary, which reads as a Hezo bug rather than a typo.
		expect(() => loadConfigFile(missing)).toThrow(/No config file at .*does-not-exist\.cjs/);
		expect(() => loadConfigFile(missing)).not.toThrow(/bunfs/);
	});

	it('surfaces a syntax error in the file', () => {
		const path = write('module.exports = { port: ;;; };');
		expect(() => loadConfigFile(path)).toThrow(/Could not load the config file/);
	});

	it('surfaces an error the file itself throws', () => {
		const path = write("throw new Error('operator blew up');");
		expect(() => loadConfigFile(path)).toThrow(/operator blew up/);
	});

	it('rejects a non-object export', () => {
		expect(() => loadConfigFile(write('module.exports = 42;'))).toThrow(
			/must export a configuration object/,
		);
		expect(() => loadConfigFile(write('module.exports = [1, 2];'))).toThrow(/an array/);
	});

	describe('validation', () => {
		it('names an unknown key rather than ignoring it', () => {
			// The specific failure a config file introduces over flags: a typo that
			// silently does nothing. `.strict()` turns it into an error naming the key.
			const path = write("module.exports = { dataDIr: '/oops' };");
			expect(() => loadConfigFile(path)).toThrow(/dataDIr/);
		});

		it('names an unknown key inside a nested group', () => {
			const path = write("module.exports = { jobs: { wakuepCron: '* * * * * *' } };");
			expect(() => loadConfigFile(path)).toThrow(/wakuepCron/);
		});

		it('rejects a wrong-typed value and says where', () => {
			const path = write("module.exports = { port: 'three thousand' };");
			expect(() => loadConfigFile(path)).toThrow(/port/);
		});

		it('rejects an out-of-range port', () => {
			expect(() => loadConfigFile(write('module.exports = { port: 99999 };'))).toThrow(/port/);
		});

		it('rejects a database pool size outside the supported band', () => {
			expect(() =>
				loadConfigFile(write('module.exports = { database: { poolSize: 1 } };')),
			).toThrow(/poolSize/);
			expect(() =>
				loadConfigFile(write('module.exports = { database: { poolSize: 500 } };')),
			).toThrow(/poolSize/);
		});

		it('reports every problem at once, not just the first', () => {
			const path = write("module.exports = { port: 99999, logLevel: 'chatty' };");
			expect(() => loadConfigFile(path)).toThrow(/port[\s\S]*logLevel/);
		});

		it('refuses a masterKey, explaining why rather than calling it a typo', () => {
			const path = write("module.exports = { masterKey: 'twelve words here' };");
			expect(() => loadConfigFile(path)).toThrow(/masterKey/);
			expect(() => loadConfigFile(path)).toThrow(/never be written to disk/);
			expect(() => loadConfigFile(path)).toThrow(/HEZO_MASTER_KEY/);
		});

		it('refuses a reset key, which would wipe the database on every restart', () => {
			const path = write('module.exports = { reset: true };');
			expect(() => loadConfigFile(path)).toThrow(/wipe on every[\s\S]*restart/);
			expect(() => loadConfigFile(path)).toThrow(/--reset/);
		});
	});
});

describe('runtimeConfig', () => {
	it('serves the built-in defaults until one is set', () => {
		resetRuntimeConfig();
		// A unit test that imports a service without booting the server must not
		// have to arrange config it does not care about.
		expect(runtimeConfig()).toBe(DEFAULT_CONFIG);
		expect(runtimeConfig().jobs.wakeupCron).toBe('*/5 * * * * *');
	});

	it('serves what was set, then goes back to defaults on reset', () => {
		const custom = { ...DEFAULT_CONFIG, port: 4321 };
		setRuntimeConfig(custom);
		expect(runtimeConfig().port).toBe(4321);
		resetRuntimeConfig();
		expect(runtimeConfig().port).toBe(DEFAULT_CONFIG.port);
	});
});

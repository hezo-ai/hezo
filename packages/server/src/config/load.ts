import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { type ConfigFile, ConfigFileError, validateConfigFile } from './schema';

/**
 * Require the config file from disk, outside the compiled bundle.
 *
 * `createRequire` produces the resolver at runtime, so `bun build --compile`
 * never sees a specifier it could try to resolve statically and inline into the
 * binary. A bare `require(path)` or `import(path)` would be a bundler input.
 */
const requireExternal = createRequire(import.meta.url);

/**
 * Load and validate the `--config` file. Returns only what the file actually
 * set; `resolveConfig` overlays it on the defaults and then the CLI flags.
 *
 * The file is CommonJS (`module.exports = { … }`) and is real JavaScript, so it
 * may compute values at load time - reading a side file, branching on hostname.
 * Anything it throws surfaces to the operator as-is.
 */
export function loadConfigFile(path: string): ConfigFile {
	const absolute = resolve(path);
	let exported: unknown;
	try {
		exported = requireExternal(absolute);
	} catch (err) {
		const code = (err as NodeJS.ErrnoException).code;
		// Report our own path rather than relaying the module resolver's message,
		// which names the compiled binary's internal `/$bunfs/root/...` entry point
		// as the requiring module and reads as a Hezo bug rather than a typo.
		if (code === 'MODULE_NOT_FOUND') {
			throw new ConfigFileError(`No config file at ${absolute} (--config).`);
		}
		const message = err instanceof Error ? err.message : String(err);
		throw new ConfigFileError(`Could not load the config file at ${absolute}: ${message}`);
	}
	return validateConfigFile(absolute, exported);
}

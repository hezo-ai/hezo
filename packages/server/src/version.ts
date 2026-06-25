/**
 * The running build's version string.
 *
 * In the compiled binary it is injected at build time via
 * `bun build --define process.env.HEZO_VERSION="<version>"` (see
 * `scripts/build.ts`), so the constant folds to a literal and the dev fallback
 * below is tree-shaken away.
 *
 * In dev (`bun run`) the define is absent, so we read the version off the
 * server package.json on disk — `import.meta.url` points at the real file, so
 * `../package.json` resolves. A static/dynamic *import* of package.json would
 * violate the server tsconfig `rootDir`, so this stays a runtime read.
 */
function readDevVersion(): string {
	try {
		const { readFileSync } = require('node:fs');
		const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf-8'));
		return typeof pkg.version === 'string' ? pkg.version : '0.0.0-dev';
	} catch {
		return '0.0.0-dev';
	}
}

export const HEZO_VERSION: string = process.env.HEZO_VERSION ?? readDevVersion();

/**
 * True only in a compiled release binary, where `bun build --define` injected
 * `process.env.HEZO_VERSION` (so the lookup folds to a literal). In dev
 * (`bun run`) and tests the env var is absent, so this is `false` — the
 * agent-base image is then always built from the working-tree Dockerfile rather
 * than pulled from the registry, so Dockerfile edits take effect immediately.
 */
export const IS_PACKAGED_BUILD: boolean = process.env.HEZO_VERSION !== undefined;

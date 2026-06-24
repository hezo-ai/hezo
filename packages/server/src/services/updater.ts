import { spawn } from 'node:child_process';
import { createHash, timingSafeEqual } from 'node:crypto';
import { existsSync } from 'node:fs';
import {
	chmod,
	copyFile,
	mkdir,
	readdir,
	readFile,
	rename,
	rm,
	stat,
	writeFile,
} from 'node:fs/promises';
import { basename, dirname, join } from 'node:path';
import { UpdateState } from '@hezo/shared';
import { logger } from '../logger';
import { HEZO_VERSION } from '../version';

const log = logger.child('updater');

/** The repo whose GitHub Releases we download binaries from. */
const REPO = 'hezo-ai/hezo';

/**
 * Thrown by `applyStagedUpdate` when the on-disk swap fails in an
 * operator-actionable way (e.g. the install dir isn't writable). The supervisor
 * logs it and relaunches the existing binary rather than crash-looping.
 */
export class UpdateApplyError extends Error {
	constructor(message: string) {
		super(message);
		this.name = 'UpdateApplyError';
	}
}

export interface UpdateStateFile {
	state: UpdateState;
	targetVersion?: string;
	asset?: string;
	error?: string;
}

/**
 * True only when this process is a `bun build --compile` standalone binary. In
 * dev (`bun run`) `process.execPath` is the Bun runtime itself (`.../bun`); in
 * the compiled binary it is the Hezo executable. Corroborated by the embedded
 * asset loaders (`loadStaticBundle`/`loadPgliteAssets`), which only return
 * content in the compiled binary.
 */
export function isCompiledBinary(): boolean {
	const exe = basename(process.execPath).toLowerCase();
	return exe !== 'bun' && exe !== 'bun.exe';
}

/** Best-effort detection of running inside a container, where in-place swap is wrong. */
export function isRunningInContainer(): boolean {
	return existsSync('/.dockerenv');
}

/**
 * The auto-update feature is available only for a self-managed bare binary:
 * compiled, not explicitly disabled, and not running inside a container (where
 * the image, not the binary, should be updated).
 */
export function isAutoUpdateEnabled(): boolean {
	if (process.env.HEZO_DISABLE_AUTO_UPDATE) return false;
	if (!isCompiledBinary()) return false;
	if (isRunningInContainer()) return false;
	return true;
}

/**
 * Release asset name for the current platform, matching the `TARGETS` mapping in
 * `scripts/build.ts` (`hezo-{os}-{arch}[.exe]`). Throws on an unsupported combo
 * (e.g. windows/arm64, for which we ship no binary).
 */
export function currentAssetName(
	platform: NodeJS.Platform = process.platform,
	arch: string = process.arch,
): string {
	const os =
		platform === 'win32'
			? 'windows'
			: platform === 'darwin'
				? 'darwin'
				: platform === 'linux'
					? 'linux'
					: null;
	const cpu = arch === 'x64' ? 'x64' : arch === 'arm64' ? 'arm64' : null;
	if (!os || !cpu) throw new Error(`Unsupported platform for auto-update: ${platform}/${arch}`);
	if (os === 'windows' && cpu !== 'x64') {
		throw new Error(`No release binary for ${os}/${cpu}`);
	}
	return `hezo-${os}-${cpu}${os === 'windows' ? '.exe' : ''}`;
}

function updateDir(dataDir: string): string {
	return join(dataDir, '.update');
}

function stagedPath(dataDir: string): string {
	return join(updateDir(dataDir), process.platform === 'win32' ? 'staged.exe' : 'staged');
}

function stateFilePath(dataDir: string): string {
	return join(updateDir(dataDir), 'state.json');
}

export async function readUpdateState(dataDir: string): Promise<UpdateStateFile> {
	try {
		const raw = await readFile(stateFilePath(dataDir), 'utf8');
		return JSON.parse(raw) as UpdateStateFile;
	} catch {
		return { state: UpdateState.Idle };
	}
}

async function writeState(dataDir: string, s: UpdateStateFile): Promise<void> {
	await mkdir(updateDir(dataDir), { recursive: true });
	await writeFile(stateFilePath(dataDir), `${JSON.stringify(s, null, 2)}\n`);
}

/** Parse a `sha256sum`-style manifest, returning the lowercase hash for `asset`. */
function expectedSha(sums: string, asset: string): string | null {
	for (const line of sums.split('\n')) {
		// Lines are `<64-hex>  <filename>` (build.ts) or `<hex> *<filename>` (binary mode).
		const m = /^([0-9a-f]{64})\s+\*?(.+)$/i.exec(line.trim());
		if (m && m[2] === asset) return m[1].toLowerCase();
	}
	return null;
}

function timingSafeHexEqual(a: string, b: string): boolean {
	const ba = Buffer.from(a, 'hex');
	const bb = Buffer.from(b, 'hex');
	if (ba.length === 0 || ba.length !== bb.length) return false;
	return timingSafeEqual(ba, bb);
}

/** macOS: clear the quarantine xattr so Gatekeeper doesn't block the relaunch. Best-effort. */
async function stripQuarantine(file: string): Promise<void> {
	await new Promise<void>((resolve) => {
		try {
			const proc = spawn('xattr', ['-d', 'com.apple.quarantine', file], { stdio: 'ignore' });
			// xattr may be absent or the attribute may not exist — neither is fatal.
			proc.on('error', () => resolve());
			proc.on('close', () => resolve());
		} catch {
			resolve();
		}
	});
}

/**
 * Download the release asset for `version` + its SHA256SUMS, verify the hash, and
 * write it to `<dataDir>/.update/staged[.exe]`. Records progress in the state
 * file. Throws (and records `error` state) on download/verify failure.
 */
export async function downloadAndStage(version: string, dataDir: string): Promise<void> {
	const asset = currentAssetName();
	await mkdir(updateDir(dataDir), { recursive: true });
	await writeState(dataDir, { state: UpdateState.Downloading, targetVersion: version, asset });
	try {
		const base = `https://github.com/${REPO}/releases/download/${version}`;
		const [binRes, sumsRes] = await Promise.all([
			fetch(`${base}/${asset}`, {
				headers: { 'User-Agent': 'hezo' },
				signal: AbortSignal.timeout(120_000),
			}),
			fetch(`${base}/SHA256SUMS`, {
				headers: { 'User-Agent': 'hezo' },
				signal: AbortSignal.timeout(30_000),
			}),
		]);
		if (!binRes.ok) throw new Error(`asset download failed: HTTP ${binRes.status}`);
		if (!sumsRes.ok) throw new Error(`SHA256SUMS download failed: HTTP ${sumsRes.status}`);

		const bytes = Buffer.from(await binRes.arrayBuffer());
		const expected = expectedSha(await sumsRes.text(), asset);
		if (!expected) throw new Error(`no SHA256 entry for ${asset}`);
		const actual = createHash('sha256').update(bytes).digest('hex');
		if (!timingSafeHexEqual(actual, expected))
			throw new Error('SHA256 mismatch — refusing to stage');

		const staged = stagedPath(dataDir);
		await writeFile(staged, bytes);
		if (process.platform !== 'win32') await chmod(staged, 0o755);
		if (process.platform === 'darwin') await stripQuarantine(staged);

		await writeState(dataDir, { state: UpdateState.Staged, targetVersion: version, asset });
		log.info(`Staged update ${version} (${asset}, ${bytes.length} bytes)`);
	} catch (err) {
		await writeState(dataDir, {
			state: UpdateState.Error,
			targetVersion: version,
			asset,
			error: err instanceof Error ? err.message : String(err),
		});
		await rm(stagedPath(dataDir), { force: true }).catch(() => {});
		throw err;
	}
}

async function clearStaging(dataDir: string): Promise<void> {
	await rm(updateDir(dataDir), { recursive: true, force: true }).catch(() => {});
}

/**
 * Swap the staged binary in over `targetPath` (defaults to the running
 * executable) and clear staging. Called by the supervisor while the worker is
 * down, so the target file is never busy/locked.
 *
 * - Copies staged → a temp file *adjacent to the target* first, so the final
 *   move is a same-filesystem rename (atomic; avoids `EXDEV`).
 * - Unix: a single atomic `rename` replaces the file.
 * - Windows: the live `.exe` is locked, so rename it aside, move the new binary
 *   into place, verify, and roll back on failure.
 *
 * `targetPath` is injectable so the swap logic is unit-testable against a temp dir.
 */
export async function applyStagedUpdate(
	dataDir: string,
	targetPath: string = process.execPath,
): Promise<void> {
	const staged = stagedPath(dataDir);
	if (!existsSync(staged)) throw new UpdateApplyError(`no staged binary at ${staged}`);

	const dir = dirname(targetPath);
	const isWindows = process.platform === 'win32' || targetPath.toLowerCase().endsWith('.exe');
	const tmpAdjacent = join(dir, `.hezo-update-tmp${isWindows ? '.exe' : ''}`);

	try {
		await copyFile(staged, tmpAdjacent);
		if (!isWindows) await chmod(tmpAdjacent, 0o755);

		if (isWindows) {
			const backup = join(dir, `${basename(targetPath, '.exe')}-old-${HEZO_VERSION}.exe`);
			await rm(backup, { force: true }).catch(() => {});
			await rename(targetPath, backup); // permitted while running
			try {
				await rename(tmpAdjacent, targetPath);
				const st = await stat(targetPath);
				if (st.size === 0) throw new Error('replaced binary is empty');
			} catch (err) {
				// Roll back: restore the original so we never leave a missing/partial exe.
				await rename(backup, targetPath).catch(() => {});
				throw err;
			}
		} else {
			await rename(tmpAdjacent, targetPath); // atomic same-FS replace
		}

		await clearStaging(dataDir);
		log.info(`Applied staged update over ${targetPath}`);
	} catch (err) {
		await rm(tmpAdjacent, { force: true }).catch(() => {});
		const code = (err as NodeJS.ErrnoException).code;
		if (code === 'EACCES' || code === 'EPERM') {
			throw new UpdateApplyError(
				`cannot replace ${targetPath} (${code}) — the binary's directory is not writable by this user`,
			);
		}
		throw err instanceof UpdateApplyError ? err : new UpdateApplyError(String(err));
	}
}

/**
 * Remove stale `<name>-old-<ver>.exe` files left by a previous Windows swap. The
 * old supervisor keeps its renamed file locked until the next full restart, so
 * cleanup happens on the following supervisor start. No-op off Windows.
 */
export async function sweepStaleBinaries(targetPath: string = process.execPath): Promise<void> {
	if (process.platform !== 'win32') return;
	const dir = dirname(targetPath);
	const prefix = `${basename(targetPath, '.exe')}-old-`;
	try {
		for (const f of await readdir(dir)) {
			if (f.startsWith(prefix) && f.toLowerCase().endsWith('.exe')) {
				await rm(join(dir, f), { force: true }).catch(() => {});
			}
		}
	} catch {
		// directory unreadable — nothing to sweep.
	}
}

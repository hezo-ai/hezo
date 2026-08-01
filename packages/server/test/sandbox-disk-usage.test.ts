import { describe, expect, it } from 'vitest';
import { parseDfKilobytes } from '../src/services/docker';
import { POOL_DISK_CEILING_BYTES } from '../src/services/sandbox/pool';
import { buildDiskUsageScript } from '../src/services/sandbox/proc-scripts';

/**
 * The measurement the pool's recycle rung is decided on.
 *
 * `atDiskCeiling` had no input at all until this landed - nothing ever wrote
 * `disk_used_bytes` - so the rung could never fire and a container that had
 * filled up was reused until a run failed inside it. What matters here is that
 * an unanswerable measurement stays unanswerable: reporting a container Hezo
 * could not measure as *empty* is the failure that would put the rung right back
 * where it was.
 */

describe('buildDiskUsageScript', () => {
	it('asks df rather than walking the tree', () => {
		// `du` would walk every node_modules in every worktree - precisely the trees
		// that make the number interesting - once per run.
		const script = buildDiskUsageScript('/workspace');
		expect(script).toContain('df -Pk /workspace');
		expect(script).not.toContain('du ');
	});

	it("measures only when the path is on the container's own filesystem", () => {
		// The guard that makes the number mean what the pool thinks it means. On a
		// local Docker daemon `/workspace` is a bind mount of the host data dir, so
		// an unguarded `df` reports the *host partition* - essentially always past a
		// 2 GiB ceiling, and replacing the container frees none of it. Every member
		// of every project then read as out of disk: affinity never fired, suspended
		// members were never resumable, and each run provisioned a fresh container.
		const script = buildDiskUsageScript('/workspace');
		expect(script).toContain('stat -c %d /');
		expect(script).toContain('stat -c %d /workspace');
		// No output on a foreign mount, which parses to null - "could not measure",
		// which is not zero and leaves the last figure alone.
		expect(script).toContain('|| exit 0');
		expect(script.indexOf('stat -c %d')).toBeLessThan(script.indexOf('df -Pk'));
	});

	it('refuses a path that would need shell escaping', () => {
		// The path is interpolated unquoted, so the character class is what makes
		// that safe; a rejection here beats a quoting bug reaching a root shell.
		for (const bad of ['/tmp; rm -rf /', '/a b', '/$(id)', '/`id`', 'workspace', '/a|b']) {
			expect(() => buildDiskUsageScript(bad)).toThrow(/unsafe path/);
		}
		expect(() => buildDiskUsageScript('/workspace')).not.toThrow();
		expect(() => buildDiskUsageScript('/var/lib/hezo_data-1/x.y')).not.toThrow();
	});
});

describe('parseDfKilobytes', () => {
	it('converts the used column from 1K blocks to bytes', () => {
		expect(parseDfKilobytes('2048\n')).toBe(2 * 1024 * 1024);
		expect(parseDfKilobytes('  0  ')).toBe(0);
	});

	it('answers null for anything that is not a number', () => {
		// A container without `df`, or an exec that produced nothing, has not
		// reported an empty disk - it has failed to report, and the caller leaves
		// the last known figure in place on null.
		for (const junk of ['', '\n', 'df: not found', 'NaN', '-1']) {
			expect(parseDfKilobytes(junk)).toBeNull();
		}
	});

	it('reads a figure over the pool ceiling as over the ceiling', () => {
		// The one end-to-end property that matters: the units line up, so a
		// container genuinely over its budget is recycled rather than reused.
		const overKb = String(Math.ceil(POOL_DISK_CEILING_BYTES / 1024) + 1);
		expect(parseDfKilobytes(overKb)).toBeGreaterThan(POOL_DISK_CEILING_BYTES);
		expect(parseDfKilobytes('1024')).toBeLessThan(POOL_DISK_CEILING_BYTES);
	});
});

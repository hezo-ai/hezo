import { describe, expect, it } from 'vitest';
import { parseDfKilobytes } from '../src/services/docker';
import { POOL_DISK_CEILING_BYTES } from '../src/services/sandbox/pool';
import {
	buildDiskUsageScript,
	buildPortsListeningScript,
} from '../src/services/sandbox/proc-scripts';

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

/**
 * The readiness check the tunnel gates a run on.
 *
 * `startRunTunnel` will not hand a run its endpoints until this reports the
 * client's ports up. Getting it wrong in the permissive direction is the
 * expensive one: a check that reads "ready" too early returns endpoints that
 * refuse connections, and a coding CLI that gets ECONNREFUSED on the MCP
 * endpoint marks that server failed for the whole session - so the agent runs to
 * completion with no Hezo tools and the run reads as it having done nothing.
 */
describe('buildPortsListeningScript', () => {
	it('reads /proc rather than depending on a tool the image may not carry', () => {
		// `ss` and `netstat` are packages; a custom docker_base_image need not have
		// them, and a missing binary would read as "not listening" forever.
		const script = buildPortsListeningScript([47080]);
		expect(script).toContain('/proc/net/tcp');
		expect(script).not.toMatch(/\bss\b|netstat/);
	});

	it('matches the port on loopback specifically, in the file’s own encoding', () => {
		// `local_address` is hex with the address little-endian, so 127.0.0.1 is
		// 0100007F; `0A` is TCP_LISTEN. Matching the port alone would accept a
		// listener on another interface, which is not what the container is
		// promised.
		const script = buildPortsListeningScript([47081]);
		expect(script).toContain('0100007F:B7E9');
		expect(script).toContain(' 0A ');
	});

	it('requires every port, not any of them', () => {
		// The run needs all three targets; one bound listener is not readiness.
		const script = buildPortsListeningScript([47080, 47081, 47082]);
		expect(script.split('&&').length).toBe(4); // three tests plus the echo
		for (const hex of ['B7E8', 'B7E9', 'B7EA']) expect(script).toContain(`0100007F:${hex}`);
	});

	it('prints one exact token so the caller tests a string rather than parsing', () => {
		expect(buildPortsListeningScript([47080])).toMatch(/&& echo ready$/);
	});

	it('rejects a port that could not be a port', () => {
		expect(() => buildPortsListeningScript([0])).toThrow(/invalid port/);
		expect(() => buildPortsListeningScript([70000])).toThrow(/invalid port/);
		expect(() => buildPortsListeningScript([1.5])).toThrow(/invalid port/);
	});
});

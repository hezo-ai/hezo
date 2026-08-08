import { DEFAULT_CONTAINER_DISK_GB, poolDiskCeilingBytes } from '@hezo/shared';
import { describe, expect, it } from 'vitest';
import {
	buildDiskUsageScript,
	buildMemoryUsageScript,
	buildPortsListeningScript,
	parseCgroupMemory,
	parseDfKilobytes,
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
		const ceiling = poolDiskCeilingBytes(DEFAULT_CONTAINER_DISK_GB);
		const overKb = String(Math.ceil(ceiling / 1024) + 1);
		expect(parseDfKilobytes(overKb)).toBeGreaterThan(ceiling);
		expect(parseDfKilobytes('1024')).toBeLessThan(ceiling);
	});
});

/**
 * The measurement the memory cap is enforced on where the backend has no stats
 * endpoint of its own.
 *
 * Nothing wrote a reading on a managed sandbox until this landed - the provider's
 * telemetry API answers 403 permanently on an ordinary account - so
 * `enforceContainerMemoryLimit` never acted and the provider's OOM kill was the
 * only thing bounding a run. Both directions of "unanswerable" matter here: a
 * missing reading must stay missing rather than become zero, and a reading taken
 * from the *host's* cgroup must not be reported as the container's.
 */
describe('buildMemoryUsageScript', () => {
	it('reads the cgroup files rather than a tool the image may not carry', () => {
		const script = buildMemoryUsageScript();
		expect(script).toContain('/sys/fs/cgroup/memory.current');
		expect(script).toContain('/sys/fs/cgroup/memory.stat');
		expect(script).not.toMatch(/\bfree\b|\bps\b|\btop\b/);
	});

	it('falls back to the v1 hierarchy, which names the same figures differently', () => {
		const script = buildMemoryUsageScript();
		expect(script).toContain('/sys/fs/cgroup/memory/memory.usage_in_bytes');
		expect(script).toContain('total_inactive_file');
		// v2 is tried first: a host running both hierarchies must answer with the
		// one the container is actually accounted in.
		expect(script.indexOf('memory.current')).toBeLessThan(script.indexOf('memory.usage_in_bytes'));
	});

	it('says nothing when the cgroup is unlimited', () => {
		// The guard that makes the number the container's own. Every Hezo container
		// is created with a limit, so an unlimited one means the reading came from
		// the host's root cgroup - the machine's memory use, attributed to one
		// container, which would stop it on the first poll.
		const script = buildMemoryUsageScript();
		// v2 spells it `max`, caught by the non-numeric test; v1 uses a near-2^63
		// sentinel, caught by counting digits.
		expect(script).toContain('*[!0-9]*');
		expect(script).toContain('${#lim} -lt 19');
	});

	it('emits the charge and the discount as two plain numbers', () => {
		expect(buildMemoryUsageScript()).toContain('printf "%s %s\\n" "$cur"');
	});
});

describe('parseCgroupMemory', () => {
	it('reports the working set: total charge less reclaimable page cache', () => {
		// The same arithmetic the Docker engine applies to the daemon's figures, so
		// one threshold compared against both means the same thing on either.
		expect(parseCgroupMemory('2147483648 1073741824\n')).toEqual({
			usedBytes: 1024 ** 3,
			rawUsageBytes: 2 * 1024 ** 3,
		});
	});

	it('discounts nothing when the cache figure is missing or unreadable', () => {
		// Over-reporting the working set is the safe direction for a threshold that
		// stops a container; under-reporting lets one past its cap.
		expect(parseCgroupMemory('1048576')).toEqual({ usedBytes: 1048576, rawUsageBytes: 1048576 });
		expect(parseCgroupMemory('1048576 nope')).toEqual({
			usedBytes: 1048576,
			rawUsageBytes: 1048576,
		});
	});

	it('never reports a negative working set', () => {
		expect(parseCgroupMemory('100 500')?.usedBytes).toBe(0);
	});

	it('answers null for output that is not a reading', () => {
		// Which is what the script produces in an unlimited cgroup, on a runtime with
		// no cgroup files, and on an exec that produced nothing. Null leaves the last
		// figure alone; zero would read as a container using no memory.
		for (const junk of ['', '\n', '   ', 'cat: no such file', 'NaN', '-1']) {
			expect(parseCgroupMemory(junk)).toBeNull();
		}
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

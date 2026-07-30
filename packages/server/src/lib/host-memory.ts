import { readFileSync } from 'node:fs';
import { totalmem } from 'node:os';

/**
 * Total host memory, used to compute the automatic max-active-containers
 * default ((RAM + swap) / per-container ram cap). RAM comes from
 * `os.totalmem()`; swap from `/proc/meminfo` `SwapTotal` on Linux (production
 * runs on Linux; on other platforms — e.g. macOS dev — swap reads as 0, which
 * only makes the computed default more conservative). Memoized per process:
 * host memory doesn't change while the server runs.
 */
export interface HostMemory {
	totalRamBytes: number;
	totalSwapBytes: number;
}

let cached: HostMemory | null = null;

export function getHostMemory(): HostMemory {
	if (cached) return cached;
	cached = { totalRamBytes: totalmem(), totalSwapBytes: readSwapTotalBytes() };
	return cached;
}

/** Test seam: override the probe (pass null to restore the real one). */
export function setHostMemoryForTest(value: HostMemory | null): void {
	cached = value;
}

function readSwapTotalBytes(): number {
	try {
		const meminfo = readFileSync('/proc/meminfo', 'utf8');
		// Format: "SwapTotal:       6291452 kB"
		const match = meminfo.match(/^SwapTotal:\s+(\d+)\s*kB/m);
		return match ? Number.parseInt(match[1], 10) * 1024 : 0;
	} catch {
		return 0;
	}
}

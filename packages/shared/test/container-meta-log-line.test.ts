import { describe, expect, it } from 'vitest';
import {
	formatContainerMetaLogLine,
	formatGib,
	parseContainerMetaLogLine,
	poolDiskCeilingBytes,
} from '../src/constants';

const gib = (n: number) => n * 1024 ** 3;

/**
 * The runner writes this line and the log viewer matches it to build the link to
 * the container's page. Nothing else keeps the two in step, so the round trip is
 * the contract.
 */
describe('the container meta log line', () => {
	const containerId = '56ccc501e6dd28a4f3b1c09a77e5d4128b6f0a91ce23d7845fa6b0192e3c4d5f';

	it('names the container and both figures', () => {
		expect(
			formatContainerMetaLogLine({
				containerId,
				memoryBytes: gib(4),
				diskCeilingBytes: gib(4),
			}),
		).toBe(`Container ${containerId} · 4 GB RAM · 4 GB disk`);
	});

	it('carries the full engine id, since that is what the container page is keyed on', () => {
		const line = formatContainerMetaLogLine({
			containerId,
			memoryBytes: gib(2),
			diskCeilingBytes: poolDiskCeilingBytes(5),
		});
		expect(parseContainerMetaLogLine(line)?.containerId).toBe(containerId);
	});

	it('drops the memory segment rather than guessing when the allocation is unrecorded', () => {
		const line = formatContainerMetaLogLine({
			containerId,
			memoryBytes: null,
			diskCeilingBytes: gib(4),
		});
		expect(line).toBe(`Container ${containerId} · 4 GB disk`);
		expect(parseContainerMetaLogLine(line)).toEqual({
			containerId,
			details: '4 GB disk',
		});
	});

	it('reports the recycle threshold, which is what the Containers page shows', () => {
		// A 5 GB project reads 4 GB on both surfaces - the ceiling sits below the
		// allocation so a run cannot fill the container partway through.
		const line = formatContainerMetaLogLine({
			containerId,
			memoryBytes: gib(4),
			diskCeilingBytes: poolDiskCeilingBytes(5),
		});
		expect(line.endsWith('4 GB disk')).toBe(true);
	});

	it('matches nothing else in the log', () => {
		expect(parseContainerMetaLogLine('Starting the project container…')).toBeNull();
		expect(parseContainerMetaLogLine('Cloning acme/web · 4 GB RAM')).toBeNull();
		expect(parseContainerMetaLogLine('')).toBeNull();
	});
});

describe('formatGib', () => {
	it('rounds to one decimal', () => {
		expect(formatGib(gib(1.5))).toBe('1.5 GB');
		expect(formatGib(gib(2))).toBe('2 GB');
		expect(formatGib(gib(1.25))).toBe('1.3 GB');
		expect(formatGib(0)).toBe('0 GB');
	});
});

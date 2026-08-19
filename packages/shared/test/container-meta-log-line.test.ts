import { describe, expect, it } from 'vitest';
import {
	formatContainerMetaLogLine,
	formatGib,
	formatRunLink,
	parseContainerMetaLogLine,
	poolDiskCeilingBytes,
	splitRunLinks,
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

/**
 * A runner line or a chat notice names another run as a markdown link; the
 * viewer splits the text around it. Same contract as the container line: the
 * writer and the reader share one vocabulary and the round trip is the test.
 */
describe('run links in server-written text', () => {
	const link = { projectSlug: 'hezo-marketing', agentSlug: 'growth-analyst', runId: 'run-1' };

	it('writes the run as a markdown link that reads as-is in raw text', () => {
		expect(formatRunLink('growth-analyst/HM-336', link)).toBe(
			'[growth-analyst/HM-336](/projects/hezo-marketing/agents/growth-analyst/executions/run-1)',
		);
	});

	it('splits the surrounding text from the linked run', () => {
		const line = `Waiting for ${formatRunLink('growth-analyst/HM-336', link)} to finish with this credential.`;
		expect(splitRunLinks(line)).toEqual([
			{ text: 'Waiting for ' },
			{ label: 'growth-analyst/HM-336', link },
			{ text: ' to finish with this credential.' },
		]);
	});

	it('leaves text with no run link, or a link to anything else, as one plain segment', () => {
		expect(splitRunLinks('Credential free, starting the run.')).toEqual([
			{ text: 'Credential free, starting the run.' },
		]);
		const other = 'See [the docs](https://hezo.ai/docs) and [a task](/projects/ops/tasks/in-42).';
		expect(splitRunLinks(other)).toEqual([{ text: other }]);
		expect(splitRunLinks('')).toEqual([]);
	});

	it('handles a link at either edge and more than one link', () => {
		const a = formatRunLink('a/T-1', link);
		const b = formatRunLink('b/T-2', { ...link, runId: 'run-2' });
		expect(splitRunLinks(`${a} then ${b}`)).toEqual([
			{ label: 'a/T-1', link },
			{ text: ' then ' },
			{ label: 'b/T-2', link: { ...link, runId: 'run-2' } },
		]);
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

import { ImageBuildStatus, type WsImageBuildMessage, WsMessageType, wsRoom } from '@hezo/shared';
import { describe, expect, it } from 'vitest';
import { ImageBuildTracker, parseBuildProgress } from '../src/services/image-build-tracker';
import { WebSocketManager, type WsData, type WsSocket } from '../src/services/ws';

function mockWs(): WsSocket & { _sent: string[] } {
	const sent: string[] = [];
	return {
		data: { auth: {} as WsData['auth'], rooms: new Set<string>() },
		send(msg: string) {
			sent.push(msg);
		},
		_sent: sent,
	};
}

function parseSent(ws: { _sent: string[] }): WsImageBuildMessage[] {
	return ws._sent.map((m) => JSON.parse(m) as WsImageBuildMessage);
}

describe('parseBuildProgress', () => {
	it('parses the classic builder Step N/M line', () => {
		expect(parseBuildProgress('Step 5/14 : RUN apt-get update')).toEqual({
			step: 5,
			totalSteps: 14,
			label: 'RUN apt-get update',
		});
	});

	it('parses BuildKit [ N/M] and [stage-1 N/M] lines', () => {
		expect(parseBuildProgress('#8 [ 5/14] RUN apt-get update')).toEqual({
			step: 5,
			totalSteps: 14,
			label: 'RUN apt-get update',
		});
		expect(parseBuildProgress('=> [stage-1 2/10] COPY . .')).toEqual({
			step: 2,
			totalSteps: 10,
			label: 'COPY . .',
		});
	});

	it('returns null for lines without a step counter', () => {
		expect(parseBuildProgress(' ---> Using cache')).toBeNull();
		expect(parseBuildProgress('Successfully built abc123')).toBeNull();
		expect(parseBuildProgress('')).toBeNull();
	});

	it('rejects nonsensical counters', () => {
		expect(parseBuildProgress('Step 0/0 : x')).toBeNull();
		expect(parseBuildProgress('Step 15/14 : x')).toBeNull();
	});
});

describe('ImageBuildTracker', () => {
	function setup() {
		const wsManager = new WebSocketManager();
		const tracker = new ImageBuildTracker();
		tracker.setWsManager(wsManager);
		const ws = mockWs();
		wsManager.subscribe(ws, wsRoom.imageBuilds());
		return { tracker, ws };
	}

	it('broadcasts a building start at 0% and advances on step lines', () => {
		const { tracker, ws } = setup();
		tracker.start('hezo/agent-base:latest');
		tracker.observe('hezo/agent-base:latest', 'Step 1/4 : FROM node');
		tracker.observe('hezo/agent-base:latest', 'Step 2/4 : RUN x');

		const msgs = parseSent(ws);
		expect(msgs[0]).toMatchObject({
			type: WsMessageType.ImageBuild,
			image: 'hezo/agent-base:latest',
			status: ImageBuildStatus.Building,
			percent: 0,
		});
		expect(msgs[1]).toMatchObject({ percent: 25, step: 1, totalSteps: 4 });
		expect(msgs[2]).toMatchObject({ percent: 50, step: 2, totalSteps: 4, label: 'RUN x' });
	});

	it('does not re-broadcast when the step is unchanged or the line has no counter', () => {
		const { tracker, ws } = setup();
		tracker.start('img');
		tracker.observe('img', 'Step 1/4 : FROM node');
		const before = ws._sent.length;
		tracker.observe('img', 'Step 1/4 : FROM node'); // duplicate step
		tracker.observe('img', ' ---> cached'); // no counter
		expect(ws._sent.length).toBe(before);
	});

	it('ignores observe without a prior start', () => {
		const { tracker, ws } = setup();
		tracker.observe('img', 'Step 1/4 : x');
		expect(ws._sent).toHaveLength(0);
	});

	it('caps the building percent below 100 — only finish reaches a full bar', () => {
		const { tracker, ws } = setup();
		tracker.start('img');
		tracker.observe('img', 'Step 4/4 : RUN final');
		const last = parseSent(ws).at(-1);
		expect(last?.percent).toBe(99);
		expect(last?.status).toBe(ImageBuildStatus.Building);
	});

	it('finish broadcasts done at 100% and clears the state', () => {
		const { tracker, ws } = setup();
		tracker.start('img');
		tracker.finish('img');
		expect(parseSent(ws).at(-1)).toMatchObject({ status: ImageBuildStatus.Done, percent: 100 });
		expect(tracker.isBuilding('img')).toBe(false);

		const replayed: WsImageBuildMessage[] = [];
		tracker.replay((m) => replayed.push(m));
		expect(replayed).toHaveLength(0);
	});

	it('fail broadcasts an error with the message and clears the state', () => {
		const { tracker, ws } = setup();
		tracker.start('img');
		tracker.fail('img', 'docker build exited with code 1');
		const last = parseSent(ws).at(-1);
		expect(last?.status).toBe(ImageBuildStatus.Error);
		expect(last?.label).toContain('exited with code 1');
		expect(tracker.isBuilding('img')).toBe(false);
	});

	it('replays the in-flight build to a newly-subscribed socket', () => {
		const { tracker } = setup();
		tracker.start('img');
		tracker.observe('img', 'Step 2/4 : RUN x');
		const replayed: WsImageBuildMessage[] = [];
		tracker.replay((m) => replayed.push(m));
		expect(replayed).toHaveLength(1);
		expect(replayed[0]).toMatchObject({
			image: 'img',
			status: ImageBuildStatus.Building,
			percent: 50,
			step: 2,
			totalSteps: 4,
		});
	});
});

import { UpdateState } from '@hezo/shared';
import { expect, test } from 'vitest';
import { type UpdateStatusInfo, updateStatusPollInterval } from '../src/hooks/use-update-check';

const BASE: UpdateStatusInfo = {
	current: '0.1.0',
	latest: '0.2.0',
	updateAvailable: true,
	url: 'https://github.com/hezo-ai/hezo/releases/0.2.0',
	state: UpdateState.Idle,
	targetVersion: '0.2.0',
	error: null,
	autoUnlock: false,
	canApply: true,
};

const status = (overrides: Partial<UpdateStatusInfo> = {}): UpdateStatusInfo => ({
	...BASE,
	...overrides,
});

// The regression this whole change fixes: a self-applying instance with an available
// update sitting at the initial `idle` snapshot (the state the first status poll returns
// before the background stage has written `downloading`) MUST keep polling — otherwise
// the settings section's "Downloading new version…" spinner and the banner strand until a
// manual reload.
test('keeps polling on the idle snapshot while a self-applying update is available', () => {
	expect(updateStatusPollInterval(status({ state: UpdateState.Idle }))).toBe(2500);
});

test('keeps polling while the server is actively mid-flight', () => {
	for (const state of [
		UpdateState.Checking,
		UpdateState.Downloading,
		UpdateState.Applying,
	] as const) {
		expect(updateStatusPollInterval(status({ state }))).toBe(2500);
	}
});

test('stops polling once the lifecycle settles at a terminal state', () => {
	// Staged → the UI shows "Install & restart"; Error → "Retry download". Nothing left to poll for.
	expect(updateStatusPollInterval(status({ state: UpdateState.Staged }))).toBe(false);
	expect(updateStatusPollInterval(status({ state: UpdateState.Error }))).toBe(false);
});

test('does not poll when there is no update to stage (already on the latest version)', () => {
	expect(
		updateStatusPollInterval(
			status({ state: UpdateState.Idle, updateAvailable: false, latest: '0.1.0' }),
		),
	).toBe(false);
});

test('does not poll when the instance cannot self-apply in place', () => {
	// e.g. an unsupervised / non-compiled instance: it only ever links to the GitHub
	// release, so there's no background staging to await.
	expect(updateStatusPollInterval(status({ state: UpdateState.Idle, canApply: false }))).toBe(
		false,
	);
});

test('does not poll before any status data has loaded', () => {
	expect(updateStatusPollInterval(undefined)).toBe(false);
});

import { render, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, test, vi } from 'vitest';
import { type DeviceCodeState, DeviceCodeSteps } from '../src/components/ui/device-code-steps';
import { withI18n } from './helpers/i18n';

/**
 * `userEvent.setup()` installs the clipboard happy-dom does not ship, so every
 * spec that drives a copy takes its handle from there rather than stubbing one.
 */
function setupUser() {
	const user = userEvent.setup();
	return { user, writeText: vi.spyOn(navigator.clipboard, 'writeText') };
}

const AWAITING: DeviceCodeState = {
	status: 'awaiting',
	url: 'https://github.com/login/device',
	userCode: 'WDJB-MJHT',
};

function renderSteps(overrides: Partial<Parameters<typeof DeviceCodeSteps>[0]> = {}) {
	const onCancel = vi.fn();
	const result = render(
		withI18n(
			<DeviceCodeSteps
				title="Connect GitHub"
				providerLabel="GitHub"
				state={AWAITING}
				onCancel={onCancel}
				{...overrides}
			/>,
		),
	);
	return { ...result, onCancel };
}

function stepState(get: (id: string) => HTMLElement, step: string): string | null {
	return get(`device-code-step-${step}`).getAttribute('data-state');
}

test('opens on the copy step, with the destination not yet reachable', () => {
	const { getByTestId, queryByTestId } = renderSteps();

	expect(stepState(getByTestId, 'copy')).toBe('active');
	expect(stepState(getByTestId, 'open')).toBe('pending');
	expect(getByTestId('device-code-value').textContent).toBe('WDJB-MJHT');
	// Step two's link only exists once step one is done - the sequence is the
	// whole point, and an open button beside the code invites skipping it.
	expect(queryByTestId('device-code-open')).toBeNull();
});

test('copying the code advances the rail and reveals the destination as an anchor', async () => {
	const { user, writeText } = setupUser();
	const { getByTestId, findByTestId } = renderSteps();

	await user.click(getByTestId('device-code-copy'));

	expect(writeText).toHaveBeenCalledWith('WDJB-MJHT');
	const open = await findByTestId('device-code-open');
	expect(open.tagName).toBe('A');
	expect(open.getAttribute('href')).toBe('https://github.com/login/device');
	expect(open.getAttribute('target')).toBe('_blank');
	await waitFor(() => expect(stepState(getByTestId, 'copy')).toBe('done'));
	expect(stepState(getByTestId, 'open')).toBe('active');
	// The finished step keeps the code readable, so it can still be checked
	// against what the provider's page is showing.
	expect(getByTestId('device-code-step-copy').textContent).toContain('WDJB-MJHT');
});

test('opening the destination leaves the flow waiting on the provider', async () => {
	const user = userEvent.setup();
	const { getByTestId, findByTestId } = renderSteps();

	await user.click(getByTestId('device-code-copy'));
	await user.click(await findByTestId('device-code-open'));

	await waitFor(() => expect(stepState(getByTestId, 'open')).toBe('done'));
	expect(getByTestId('device-code-steps').textContent).toContain('Waiting for you to authorize');
});

test('a flow with no code drops the copy step and leads with the destination', () => {
	const { getByTestId, queryByTestId } = renderSteps({
		state: { status: 'awaiting', url: 'https://claude.ai/oauth/authorize', userCode: null },
	});

	expect(queryByTestId('device-code-step-copy')).toBeNull();
	expect(stepState(getByTestId, 'open')).toBe('active');
	// The rail renumbers: opening is step one when there is nothing to copy.
	expect(getByTestId('device-code-step-open').textContent).toContain('1');
	expect(getByTestId('device-code-open').getAttribute('href')).toBe(
		'https://claude.ai/oauth/authorize',
	);
});

test('a return-code flow adds a third step that submits what the operator pastes', async () => {
	const user = userEvent.setup();
	const onSubmit = vi.fn();
	const { getByTestId, findByTestId } = renderSteps({
		providerLabel: 'OpenAI',
		returnCode: { submitting: false, onSubmit },
	});

	// The paste step is on the rail from the start, but stays inert until the
	// operator has actually been to the provider.
	expect(stepState(getByTestId, 'paste')).toBe('pending');
	await user.click(getByTestId('device-code-copy'));
	await user.click(await findByTestId('device-code-open'));

	await waitFor(() => expect(stepState(getByTestId, 'paste')).toBe('active'));
	await user.type(getByTestId('device-code-return-input'), '  returned-code  ');
	await user.click(getByTestId('device-code-return-submit'));

	// Trimmed, because a pasted code arrives with whatever whitespace came with it.
	expect(onSubmit).toHaveBeenCalledWith('returned-code');
});

test('the countdown reports the time left and turns to a warning near the end', () => {
	vi.useFakeTimers();
	try {
		const { getByTestId, rerender } = render(
			withI18n(
				<DeviceCodeSteps
					title="Connect GitHub"
					providerLabel="GitHub"
					state={{ ...AWAITING, expiresAt: new Date(Date.now() + 90_000).toISOString() }}
					onCancel={vi.fn()}
				/>,
			),
		);

		const expiry = getByTestId('device-code-expiry');
		expect(expiry.textContent).toContain('1:30');
		expect(expiry.className).toContain('text-warning-soft-fg');

		rerender(
			withI18n(
				<DeviceCodeSteps
					title="Connect GitHub"
					providerLabel="GitHub"
					state={{ ...AWAITING, expiresAt: new Date(Date.now() + 600_000).toISOString() }}
					onCancel={vi.fn()}
				/>,
			),
		);
		const later = getByTestId('device-code-expiry');
		expect(later.textContent).toContain('10:00');
		expect(later.className).not.toContain('text-warning-soft-fg');
	} finally {
		vi.useRealTimers();
	}
});

test('a clipboard that refuses does not claim the code was copied', async () => {
	// The legacy `document.execCommand` fallback does not exist under happy-dom
	// either, so a rejected write is a failed copy end to end.
	const { user, writeText } = setupUser();
	writeText.mockRejectedValue(new Error('denied'));
	const { getByTestId, queryByTestId, findByTestId } = renderSteps();

	await user.click(getByTestId('device-code-copy'));

	// Still on step one, and offering the manual way out rather than advancing
	// on a copy that never happened.
	await findByTestId('device-code-copy-failed');
	expect(stepState(getByTestId, 'copy')).toBe('active');
	expect(queryByTestId('device-code-open')).toBeNull();
});

test('a failed flow offers a retry and the caller-supplied fallback', async () => {
	const user = userEvent.setup();
	const onRetry = vi.fn();
	const onSelect = vi.fn();
	const state: DeviceCodeState = {
		status: 'failed',
		title: 'The code expired',
		detail: 'Try again.',
	};
	const { getByTestId, getByText } = renderSteps({
		state,
		onRetry,
		fallback: { label: 'Paste credential manually', onSelect },
	});

	expect(getByTestId('device-code-steps').textContent).toContain('The code expired');
	await user.click(getByTestId('device-code-retry'));
	expect(onRetry).toHaveBeenCalled();
	await user.click(getByText('Paste credential manually'));
	expect(onSelect).toHaveBeenCalled();
});

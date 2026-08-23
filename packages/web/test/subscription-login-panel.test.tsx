import { AiProvider } from '@hezo/shared';
import { render, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, test, vi } from 'vitest';
import type { SubscriptionLoginState } from '../src/hooks/use-ai-providers';
import { withI18n } from './helpers/i18n';

// The panel is transport plus a mapping onto `DeviceCodeSteps`; the flow's own
// endpoints are stubbed so the mapping is what these assert.
const startSubscriptionLogin = vi.fn();
const pollSubscriptionLogin = vi.fn();
const submitSubscriptionLoginCode = vi.fn();
const cancelSubscriptionLogin = vi.fn();

vi.mock('../src/hooks/use-ai-providers', async (importOriginal) => ({
	...(await importOriginal<typeof import('../src/hooks/use-ai-providers')>()),
	startSubscriptionLogin: (...args: unknown[]) => startSubscriptionLogin(...args),
	pollSubscriptionLogin: (...args: unknown[]) => pollSubscriptionLogin(...args),
	submitSubscriptionLoginCode: (...args: unknown[]) => submitSubscriptionLoginCode(...args),
	cancelSubscriptionLogin: (...args: unknown[]) => cancelSubscriptionLogin(...args),
	invalidateAiProviders: () => {},
}));

const { SubscriptionLoginPanel } = await import('../src/components/subscription-login-panel');

/** Answer the first poll with `state`, then park so the loop stops asking. */
function pollOnce(state: SubscriptionLoginState) {
	pollSubscriptionLogin.mockResolvedValueOnce(state).mockImplementation(
		() =>
			new Promise(() => {
				/* the flow is waiting on the operator, not on the server */
			}),
	);
}

function renderPanel() {
	const onUnavailable = vi.fn();
	const view = render(
		withI18n(
			<SubscriptionLoginPanel
				provider={AiProvider.OpenAI}
				runtime={null}
				onDone={vi.fn()}
				onUnavailable={onUnavailable}
				onCancel={vi.fn()}
			/>,
		),
	);
	return { ...view, onUnavailable };
}

beforeEach(() => {
	vi.clearAllMocks();
	startSubscriptionLogin.mockResolvedValue({ flow_id: 'flow-1' });
	cancelSubscriptionLogin.mockResolvedValue(undefined);
});

test('a code-completion sign-in runs copy, open, then paste back', async () => {
	const user = userEvent.setup();
	pollOnce({
		status: 'awaiting_user',
		completion: 'code',
		url: 'https://auth.openai.com/device',
		user_code: 'HJKD-9QWE',
		expires_at: new Date(Date.now() + 900_000).toISOString(),
	});
	const { getByTestId, findByTestId } = renderPanel();

	expect((await findByTestId('device-code-value')).textContent).toBe('HJKD-9QWE');
	// The countdown lands a tick after the code, so wait for it rather than
	// assuming the same commit carried both.
	expect((await findByTestId('device-code-expiry')).textContent).toContain('15:00');

	await user.click(getByTestId('device-code-copy'));
	await user.click(await findByTestId('device-code-open'));

	// The code OpenAI hands back is a third step, not an input sitting beside
	// the other two with nothing saying when it is its turn.
	await waitFor(() => expect(getByTestId('device-code-step-paste')).toBeTruthy());
	await user.type(getByTestId('device-code-return-input'), 'returned-code');
	await user.click(getByTestId('device-code-return-submit'));

	await waitFor(() =>
		expect(submitSubscriptionLoginCode).toHaveBeenCalledWith('flow-1', 'returned-code'),
	);
});

test('a poll-completion sign-in ends in a wait, with no paste step', async () => {
	const user = userEvent.setup();
	pollOnce({
		status: 'awaiting_user',
		completion: 'none',
		url: 'https://auth.openai.com/device',
		user_code: 'HJKD-9QWE',
		expires_at: new Date(Date.now() + 900_000).toISOString(),
	});
	const { getByTestId, queryByTestId, findByTestId } = renderPanel();

	await user.click(await findByTestId('device-code-copy'));
	await user.click(await findByTestId('device-code-open'));

	await waitFor(() =>
		expect(getByTestId('subscription-login-panel').textContent).toContain(
			'Waiting for you to authorize',
		),
	);
	expect(queryByTestId('device-code-step-paste')).toBeNull();
});

test('a flow with no code leads with the link and never shows a copy step', async () => {
	pollOnce({
		status: 'awaiting_user',
		completion: 'none',
		url: 'https://auth.openai.com/device?code=abc',
		user_code: null,
		expires_at: new Date(Date.now() + 900_000).toISOString(),
	});
	const { queryByTestId, findByTestId } = renderPanel();

	expect((await findByTestId('device-code-open')).getAttribute('href')).toBe(
		'https://auth.openai.com/device?code=abc',
	);
	expect(queryByTestId('device-code-step-copy')).toBeNull();
});

test('a failed flow offers both a retry and the manual-paste fallback', async () => {
	const user = userEvent.setup();
	pollOnce({ status: 'failed', error: 'The CLI exited before signing in', code: 'cli_failed' });
	const { getByTestId, getByText, findByText, onUnavailable } = renderPanel();

	await findByText('The CLI exited before signing in');
	await user.click(getByTestId('device-code-retry'));
	// The retry starts a second flow rather than leaving the operator on a dead
	// panel whose only way forward was pasting a credential by hand.
	await waitFor(() => expect(startSubscriptionLogin).toHaveBeenCalledTimes(2));

	await user.click(getByText('Paste credential manually'));
	expect(onUnavailable).toHaveBeenCalled();
});

test('a sign-in the CLI cannot drive falls back to manual paste without a message', async () => {
	startSubscriptionLogin.mockRejectedValue(new Error('no guided sign-in for this CLI'));
	const { onUnavailable } = renderPanel();

	await waitFor(() => expect(onUnavailable).toHaveBeenCalled());
});

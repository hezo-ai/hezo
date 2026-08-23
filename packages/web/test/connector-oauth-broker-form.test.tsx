import { render, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, test, vi } from 'vitest';
import { withI18n } from './helpers/i18n';

// The broker form's own transport is stubbed: what these assert is the step-two
// view it hands to `DeviceCodeSteps` once a flow has started. The existing
// broker specs stop at the form and never submit it, so that view - and the
// promise that submitting no longer opens a tab behind the operator - had
// nothing covering it.
const brokerDeviceStart = vi.fn();
const pollBrokerDeviceFlow = vi.fn();

vi.mock('../src/hooks/use-oauth-connections', async (importOriginal) => ({
	...(await importOriginal<typeof import('../src/hooks/use-oauth-connections')>()),
	useOAuthProviders: () => ({ data: [] }),
	useBrokerDeviceStart: () => ({ mutate: brokerDeviceStart }),
	pollBrokerDeviceFlow: (...args: unknown[]) => pollBrokerDeviceFlow(...args),
}));

const { ConnectorOAuthBrokerForm } = await import('../src/components/connector-oauth-broker-form');

const FLOW = {
	flow_id: 'flow-1',
	user_code: 'HJKD-9QWE',
	verification_uri: 'https://www.google.com/device',
	expires_in: 900,
	interval: 5,
};

function renderForm() {
	return render(
		withI18n(
			<ConnectorOAuthBrokerForm
				projectId="ops"
				connectorId="conn-1"
				connectorLabel="YouTube"
				lockedProviderId="google-youtube"
			/>,
		),
	);
}

beforeEach(() => {
	vi.clearAllMocks();
	// The flow parks awaiting authorization, so the poll loop stays quiet.
	pollBrokerDeviceFlow.mockImplementation(() => new Promise(() => {}));
});

test('submitting the client id hands the started flow to the step rail', async () => {
	const user = userEvent.setup();
	const openSpy = vi.spyOn(window, 'open').mockReturnValue(null);
	const { getByTestId, findByTestId, queryByTestId } = renderForm();

	await user.type(getByTestId('broker-client-id'), 'client-abc');
	await user.click(getByTestId('broker-submit'));

	// The form calls start with what the operator entered, then renders whatever
	// the flow resolves to - here, step one of the rail.
	expect(brokerDeviceStart).toHaveBeenCalledTimes(1);
	const [input, handlers] = brokerDeviceStart.mock.calls[0] as [
		{ client_id: string; connectorId: string },
		{ onSuccess: (flow: typeof FLOW) => void },
	];
	expect(input.client_id).toBe('client-abc');
	expect(input.connectorId).toBe('conn-1');

	handlers.onSuccess(FLOW);

	expect((await findByTestId('device-code-value')).textContent).toBe('HJKD-9QWE');
	expect(getByTestId('device-code-step-copy').getAttribute('data-state')).toBe('active');
	expect(queryByTestId('broker-form')).toBeNull();

	// The behaviour this PR changed: starting a flow no longer pops a tab the
	// operator did not ask for, before the code is even on screen.
	expect(openSpy).not.toHaveBeenCalled();
	expect(queryByTestId('device-code-open')).toBeNull();

	openSpy.mockRestore();
});

test('the started flow carries its expiry into the countdown', async () => {
	const user = userEvent.setup();
	const { getByTestId, findByTestId } = renderForm();

	await user.type(getByTestId('broker-client-id'), 'client-abc');
	await user.click(getByTestId('broker-submit'));
	const [, handlers] = brokerDeviceStart.mock.calls[0] as [
		unknown,
		{ onSuccess: (flow: typeof FLOW) => void },
	];
	handlers.onSuccess(FLOW);

	// `expires_in` is a duration; the rail pins it to a deadline and counts down.
	expect((await findByTestId('device-code-expiry')).textContent).toContain('15:00');
});

test('a client id is required before a flow is started', async () => {
	const user = userEvent.setup();
	const { getByTestId, findByText } = renderForm();

	await user.click(getByTestId('broker-submit'));

	await findByText('Enter the OAuth client ID.');
	expect(brokerDeviceStart).not.toHaveBeenCalled();
});

test('a failed start reports the reason and keeps the form on screen', async () => {
	const user = userEvent.setup();
	const { getByTestId, findByText } = renderForm();

	await user.type(getByTestId('broker-client-id'), 'client-abc');
	await user.click(getByTestId('broker-submit'));
	const [, handlers] = brokerDeviceStart.mock.calls[0] as [
		unknown,
		{ onError: (err: Error) => void },
	];
	handlers.onError(new Error('device_code_url is not reachable'));

	await findByText('device_code_url is not reachable');
	await waitFor(() => expect(getByTestId('broker-form')).toBeTruthy());
});

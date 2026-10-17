// The screens a session recording must never capture carry the recorder's block
// class on the component that renders the secret, so every screen reusing that
// component is covered. Each spec renders the component on its own and asserts
// that the secret sits under a blocked element - the property the recorder acts
// on - rather than that one particular element carries the class.
//
// The rest of the list is asserted where those screens are already driven:
// the new API key (api-keys-settings), the pasted subscription credential
// (ai-providers), a requested credential (credential-request-comment), the chat
// thread (chat) and the asset viewer's image, frame and links (asset-viewer).

import { NEVER_RECORD_CLASS, PasswordInput } from '@hezo/ui';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import {
	createMemoryHistory,
	createRootRoute,
	createRouter,
	RouterProvider,
} from '@tanstack/react-router';
import { fireEvent, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { ReactNode } from 'react';
import { expect, test } from 'vitest';
import { LogViewer } from '../src/components/log-viewer';
import { MarkdownProse } from '../src/components/markdown-prose';
import { MasterKeyForm } from '../src/components/master-key-gate';
import { DeviceCodeSteps } from '../src/components/ui/device-code-steps';
import { withI18n } from './helpers/i18n';

function isNeverRecorded(element: Element | null): boolean {
	return element?.closest(`.${NEVER_RECORD_CLASS}`) != null;
}

/** A component that reads the router or the query cache, rendered with both. */
async function renderInShell(ui: ReactNode, ready: () => HTMLElement): Promise<void> {
	const router = createRouter({
		routeTree: createRootRoute({ component: () => ui }),
		history: createMemoryHistory({ initialEntries: ['/'] }),
	});
	render(
		withI18n(
			<QueryClientProvider client={new QueryClient()}>
				{/* biome-ignore lint/suspicious/noExplicitAny: opaque router type at the test boundary. */}
				<RouterProvider router={router as any} />
			</QueryClientProvider>,
		),
	);
	await waitFor(() => expect(ready()).toBeTruthy());
}

test('the generated recovery phrase is never recorded', async () => {
	render(withI18n(<MasterKeyForm state="unset" embedded />));
	fireEvent.click(screen.getByRole('button', { name: /generate master key/i }));
	fireEvent.click(screen.getByRole('button', { name: /^show key$/i }));

	const words = await screen.findAllByTestId('mnemonic-word');
	expect(words).toHaveLength(12);
	for (const word of words) expect(isNeverRecorded(word)).toBe(true);
});

// The vault gate's unlock, the setup wizard's re-entry and the forgot-password
// reset all render this same form to take the phrase.
test('a recovery phrase being typed is never recorded', () => {
	render(withI18n(<MasterKeyForm state="unlocked" embedded />));

	const entry = document.getElementById('mnemonic-entry');
	expect(entry).not.toBeNull();
	expect(isNeverRecorded(entry)).toBe(true);
});

test('a password field is never recorded, revealed or not', () => {
	render(<PasswordInput aria-label="Password" defaultValue="hunter2" />);
	const field = screen.getByLabelText('Password');
	expect(isNeverRecorded(field)).toBe(true);

	fireEvent.click(screen.getByRole('button', { name: 'Show password' }));
	expect(field.getAttribute('type')).toBe('text');
	expect(isNeverRecorded(field)).toBe(true);
});

test('a device sign-in code, its address and the code pasted back are never recorded', async () => {
	// Installs the clipboard the copy step writes to, which happy-dom does not ship.
	const user = userEvent.setup();
	render(
		withI18n(
			<DeviceCodeSteps
				title="Connect GitHub"
				providerLabel="GitHub"
				state={{
					status: 'awaiting',
					url: 'https://github.com/login/device?state=abc',
					userCode: 'WDJB-MJHT',
				}}
				returnCode={{ onSubmit: () => {}, submitting: false }}
			/>,
		),
	);

	expect(isNeverRecorded(screen.getByTestId('device-code-value'))).toBe(true);
	await user.click(screen.getByTestId('device-code-copy'));
	const open = await screen.findByTestId('device-code-open');
	expect(isNeverRecorded(open)).toBe(true);
	await user.click(open);
	expect(isNeverRecorded(await screen.findByTestId('device-code-return-input'))).toBe(true);
});

test('a run or container log is never recorded', async () => {
	await renderInShell(
		<LogViewer lines={[{ id: 1, stream: 'stdout', text: 'export TOKEN=abc' }]} testId="run-log" />,
		() => screen.getByTestId('run-log'),
	);

	expect(isNeverRecorded(screen.getByText('export TOKEN=abc'))).toBe(true);
});

test('a signed link in rendered markdown is never recorded, and an ordinary one is', () => {
	render(
		withI18n(
			<QueryClientProvider client={new QueryClient()}>
				<MarkdownProse>
					{'[the report](/api/assets/a1?exp=1&sig=s) and [the docs](https://example.com/guide)'}
				</MarkdownProse>
			</QueryClientProvider>,
		),
	);

	expect(isNeverRecorded(screen.getByRole('link', { name: 'the report' }))).toBe(true);
	expect(isNeverRecorded(screen.getByRole('link', { name: 'the docs' }))).toBe(false);
});

test('an image embedded in rendered markdown is never recorded', () => {
	render(
		withI18n(
			<QueryClientProvider client={new QueryClient()}>
				<MarkdownProse>{'![screenshot](/api/assets/a1?exp=1&sig=s)'}</MarkdownProse>
			</QueryClientProvider>,
		),
	);

	const image = screen.getByRole('img', { name: 'screenshot' });
	expect(image.getAttribute('src')).toBe('/api/assets/a1?exp=1&sig=s');
	expect(isNeverRecorded(image)).toBe(true);
});

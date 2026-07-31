import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render } from '@testing-library/react';
import { expect, test } from 'vitest';
import { SandboxBackendSection } from '../src/components/sandbox-backend-section';
import type { SandboxBackendInfo } from '../src/hooks/use-sandbox-backend-info';
import { I18nProvider } from '../src/lib/i18n';
import { queryKeys } from '../src/lib/query-keys';
import { renderApp } from './helpers/render';

// Full-route render against the real in-process backend: local Docker is what a
// test server actually reports, and the card's placement on the Storage subpage
// is part of the requirement.
test('storage subpage shows the sandbox-backend card', async () => {
	const { findByTestId } = await renderApp({ initialPath: '/settings/storage' });

	const name = await findByTestId('settings-sandbox-backend-name');
	expect(name.textContent).toBe('Local Docker daemon');

	const storage = await findByTestId('settings-storage');
	const card = await findByTestId('settings-sandbox-backend');
	expect(storage.contains(card)).toBe(true);
});

/**
 * Isolated-component render with a seeded cache for the managed variant - no
 * provider account needed, and it proves the client renders exactly the
 * pre-redacted endpoint it was given.
 */
function renderManaged(info: SandboxBackendInfo, opts: { superuser?: boolean } = {}) {
	// staleTime: Infinity keeps the seeded cache authoritative - the file-level
	// renderApp beforeEach reroutes fetch into the real in-process backend, and a
	// mount refetch would overwrite the seeded payload with the test server's.
	const qc = new QueryClient({
		defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } },
	});
	qc.setQueryData(queryKeys.me(), { type: 'admin', is_superuser: opts.superuser ?? true });
	qc.setQueryData(queryKeys.sandboxBackendInfo(), info);
	return render(
		<QueryClientProvider client={qc}>
			<I18nProvider>
				<SandboxBackendSection />
			</I18nProvider>
		</QueryClientProvider>,
	);
}

test('managed variant names the provider and shows the redacted endpoint', async () => {
	const { findByTestId } = renderManaged({
		backend: 'daytona',
		display: 'https://app.daytona.io/api',
	});

	const name = await findByTestId('settings-sandbox-backend-name');
	expect(name.textContent).toBe('Daytona');
	const display = await findByTestId('settings-sandbox-backend-display');
	expect(display.textContent).toBe('https://app.daytona.io/api');
});

test('the local variant shows no endpoint line at all', async () => {
	// There is no endpoint for a local daemon, so an empty mono line would be
	// noise rather than information.
	const { findByTestId, queryByTestId } = renderManaged({
		backend: 'docker',
		display: 'local Docker daemon',
	});
	await findByTestId('settings-sandbox-backend-name');
	expect(queryByTestId('settings-sandbox-backend-display')).toBeNull();
});

test('the card offers no way to change the backend', () => {
	// Read-only by design: it is deployment configuration, chosen at startup.
	const { container } = renderManaged({
		backend: 'daytona',
		display: 'https://app.daytona.io/api',
	});
	expect(container.querySelectorAll('button, input, select, a')).toHaveLength(0);
});

test('the card does not render for non-superusers', () => {
	const { queryByTestId } = renderManaged(
		{ backend: 'daytona', display: 'https://app.daytona.io/api' },
		{ superuser: false },
	);
	expect(queryByTestId('settings-sandbox-backend')).toBeNull();
});

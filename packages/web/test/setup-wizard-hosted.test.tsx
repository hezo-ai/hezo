import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render } from '@testing-library/react';
import { expect, test } from 'vitest';
import { SetupWizard } from '../src/components/setup/setup-wizard';
import { I18nProvider } from '../src/lib/i18n';

/**
 * An instance signed in through an issuer never enrols a password, so the step
 * that would enrol one is not part of its journey. Showing it as a completed
 * step claims something that never happened.
 */
function renderWizard(hosted: boolean) {
	const qc = new QueryClient({
		defaultOptions: { queries: { retry: false, staleTime: Number.POSITIVE_INFINITY } },
	});
	// Matches `statusKey` in use-ai-providers; seeded so the picker renders
	// without reaching the network.
	qc.setQueryData(['ai-providers', 'status'], { configured: false });
	return render(
		<QueryClientProvider client={qc}>
			<I18nProvider>
				<SetupWizard hosted={hosted} />
			</I18nProvider>
		</QueryClientProvider>,
	);
}

test('the hosted wizard omits the password step', async () => {
	const { findByTestId, container } = renderWizard(true);
	await findByTestId('setup-step-ai-provider');
	expect(container.textContent).not.toContain('Password');
});

test('an ordinary wizard still shows it', async () => {
	const { findByTestId, container } = renderWizard(false);
	await findByTestId('setup-step-ai-provider');
	expect(container.textContent).toContain('Password');
});

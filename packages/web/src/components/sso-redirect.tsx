import { Loader2 } from 'lucide-react';
import { useEffect } from 'react';
import { useI18n } from '../lib/i18n';
import { goToIssuer } from '../lib/sso';
import { VaultShell } from './master-key-gate';
import { Button } from './ui/button';

/**
 * Hands an unidentified visitor back to the issuer.
 *
 * There is no sign-in form here on purpose. The issuer owns signing in, and an
 * instance that drew its own would be asking for credentials it has no business
 * seeing. This is a redirect with something to look at while it happens.
 *
 * On a failure it stops and waits instead. Redirecting automatically after a
 * rejected token is a loop - the issuer sends the visitor straight back with
 * another one - so the retry is theirs to make.
 */
export function SsoRedirect({ issuerUrl, error }: { issuerUrl: string; error?: string }) {
	const { t } = useI18n();

	let host = issuerUrl;
	try {
		host = new URL(issuerUrl).host;
	} catch {
		// An unparseable issuer URL is a misconfiguration, not something to hide.
	}

	const failed = Boolean(error);
	useEffect(() => {
		if (!failed) goToIssuer(issuerUrl);
	}, [failed, issuerUrl]);

	return (
		<VaultShell>
			<div
				data-testid="sso-redirect"
				className="rounded-2xl border border-border-strong bg-surface p-6 sm:p-8 text-center shadow-[var(--elev-lg)]"
			>
				{failed ? (
					<>
						<h2 className="text-lg font-semibold text-text-1">{t('sso.failed')}</h2>
						<p className="mt-1 text-sm text-text-2" role="alert">
							{error}
						</p>
						<Button className="mt-5 w-full" onClick={() => goToIssuer(issuerUrl)}>
							{t('sso.retry', { host })}
						</Button>
					</>
				) : (
					<>
						<Loader2 className="mx-auto h-5 w-5 animate-spin text-text-2" />
						<p className="mt-4 text-sm text-text-2">{t('sso.redirecting', { host })}</p>
					</>
				)}
			</div>
		</VaultShell>
	);
}

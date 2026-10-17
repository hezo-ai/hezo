import type { StatusResponse } from './auth';

/**
 * Where signing in through an external issuer has got to. `holding` is why this
 * is a phase rather than a boolean: between the unlock landing and the held
 * identity becoming a session there is at least one render with no session, and
 * a plain "redirect when signed out" would fire in it.
 */
export type SsoPhase = 'idle' | 'exchanging' | 'holding' | 'redeeming' | 'failed';

/** A gate that only shows somebody something, and needs nothing from the status to draw it. */
type PlainGate =
	| 'loading'
	| 'unreachable'
	| 'vault-unset'
	| 'vault-locked'
	| 'signed-in'
	| 'signing-in'
	| 'create-password'
	| 'sign-in';

/**
 * Which screen the shell shows before, or instead of, the app itself.
 *
 * Decided here once and read twice: by the shell, which draws it, and by the
 * support chat, which tells the support team which screen a person asking for
 * help is stuck on. `kind` is the name both use.
 */
export type ShellGate =
	| { kind: 'starting'; status: StatusResponse }
	| { kind: 'issuer-redirect'; issuerUrl: string }
	| { kind: PlainGate };

export interface ShellGateInput {
	status: StatusResponse | undefined;
	/** The first status load: nothing fetched yet, and no failure yet. */
	statusLoading: boolean;
	statusFailed: boolean;
	/** The session probe, which runs only once the instance is unlocked. */
	session: { isPending: boolean; isError: boolean };
	ssoPhase: SsoPhase;
}

export function shellGate({
	status,
	statusLoading,
	statusFailed,
	session,
	ssoPhase,
}: ShellGateInput): ShellGate {
	// The server is still booting: the boot phase, not a bare spinner.
	if (status?.starting) return { kind: 'starting', status };
	if (statusLoading) return { kind: 'loading' };
	if (statusFailed || !status || !status.masterKeyState) return { kind: 'unreachable' };
	if (status.masterKeyState !== 'unlocked') {
		return { kind: status.masterKeyState === 'unset' ? 'vault-unset' : 'vault-locked' };
	}
	// Unlocked. A session is now required, and only the password or the issuer
	// mints one.
	if (session.isPending) return { kind: 'loading' };
	if (!session.isError) return { kind: 'signed-in' };
	// An identity is mid-flight: wait for it rather than redirecting out from under it.
	if (ssoPhase !== 'idle' && ssoPhase !== 'failed') return { kind: 'signing-in' };
	// An instance with an issuer has no sign-in of its own, and no password fallback.
	if (status.sso) return { kind: 'issuer-redirect', issuerUrl: status.sso.issuer_url };
	// A brand-new instance (or a recovery) creates the first password; otherwise sign in.
	return { kind: status.passwordSet ? 'sign-in' : 'create-password' };
}

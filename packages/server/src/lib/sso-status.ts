import { runtimeConfig } from '../config/runtime';

/**
 * The pre-auth hint that this instance has somewhere to sign in from.
 *
 * On the public status payload because the gate has to decide what to offer
 * before any credential exists. Absent entirely when no issuer is configured, so
 * an ordinary instance's payload is unchanged and nothing downstream has to know
 * the field could exist.
 *
 * Keyed on an issuer being configured, never on `policy`. A deployer that pins
 * an instance's limits has not thereby given it anywhere to sign in, and
 * offering a sign-in button that leads nowhere is worse than offering none.
 *
 * Only the issuer's URLs go out. They are already public - they are where the
 * browser is about to be sent - while the accepted keys, the owner subject and
 * the audience are matching material that a caller has no reason to read back.
 */
export function ssoStatus(): { sso?: { issuer_url: string; logout_url: string } } {
	const sso = runtimeConfig().sso;
	return sso ? { sso: { issuer_url: sso.issuerUrl, logout_url: sso.logoutUrl } } : {};
}

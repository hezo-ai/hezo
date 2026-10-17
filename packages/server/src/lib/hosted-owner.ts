import { AuthType } from '@hezo/shared';
import { runtimeConfig } from '../config/runtime';
import type { AuthInfo } from './types';

/**
 * Whether this caller is the issuer-side account that owns a hosted instance.
 *
 * **The owner is the superuser, and only on an instance with an issuer.** An
 * issuer signs in exactly one subject and maps it to the superuser, and it
 * disables every other way to get a session, so a superuser session there is the
 * owner's. Without an issuer there is no issuer-side account at all, so nobody
 * signed in is its owner.
 *
 * The gate for every block the deployer writes about that one account - the
 * support identity, the analytics identity. Read per call, so it follows the
 * runtime config rather than whatever it was when a route was mounted.
 */
export function isHostedOwner(auth: AuthInfo): boolean {
	return !!runtimeConfig().sso && auth.type === AuthType.Admin && auth.isSuperuser;
}

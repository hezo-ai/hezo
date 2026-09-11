import { createMiddleware } from 'hono/factory';
import type { Env } from '../lib/types';

/**
 * Refuse to be framed.
 *
 * Nothing this instance serves is meant to render inside another site's
 * frame: the master-key gate, the sign-in and unlock screens and the app
 * itself are all surfaces where a page drawn around them could be made to
 * look like theirs. `frame-ancestors 'none'` closes that for every browser
 * that reads a Content-Security-Policy, which is every browser in use. The
 * control plane that provisions hosted instances sends the same policy for
 * its own documents.
 *
 * A response that already carries a policy keeps it. The signed asset route
 * serves agent-authored HTML under a `sandbox` policy, and the app's own asset
 * viewer frames exactly that response: appending `'none'` there would break
 * the one framing this instance does itself, and replacing the policy would
 * drop the sandbox that keeps that script off the app's origin. That route
 * writes `FRAME_ANCESTORS_SELF` into its own policy instead.
 */
export const FRAME_ANCESTORS_NONE = "frame-ancestors 'none'";

/**
 * For the one document the instance frames itself: an agent-authored HTML
 * asset in the app's viewer. Composed into that route's own policy beside the
 * sandbox, so a third-party page still cannot frame it.
 */
export const FRAME_ANCESTORS_SELF = "frame-ancestors 'self'";

const CSP_HEADER = 'Content-Security-Policy';

/** Add the framing policy to a response that has no policy of its own. */
export function refuseFraming(headers: Headers): void {
	if (!headers.has(CSP_HEADER)) headers.set(CSP_HEADER, FRAME_ANCESTORS_NONE);
}

/** The same rule for every response `buildApp` returns, JSON included. */
export const framingMiddleware = createMiddleware<Env>(async (c, next) => {
	await next();
	refuseFraming(c.res.headers);
});

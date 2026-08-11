/**
 * Live-tier setup: take the request timeouts off `fetch`, for this tier only.
 *
 * **The suite runs on the wrong runtime for the code it is driving.** Production
 * is Bun, and Bun's `fetch` imposes no idle or header timeout of its own - which
 * is what `DaytonaClient.followCommandLog` is built on, and says so: it holds one
 * response open for the whole command and lets the far end, not the client,
 * decide when a stream is dead. vitest runs under Node, whose `fetch` is undici,
 * whose defaults are `headersTimeout: 300_000` and `bodyTimeout: 300_000`.
 *
 * So an agent run that thinks for more than five minutes - or a provider that
 * withholds response headers until the command's first byte of output - dies
 * here as `UND_ERR_HEADERS_TIMEOUT` / `UND_ERR_BODY_TIMEOUT` on a path that is
 * fine in production. Measured: a Prime Agent run failed at exactly 300s with no
 * transcript at all, having reached neither an assertion nor the dump.
 *
 * That failure is an artifact of the test runtime and nothing else, so it is
 * removed here rather than worked around in `client.ts` - production must not
 * grow a dispatcher argument for a limit its runtime does not have.
 *
 * `setGlobalDispatcher` from the installed undici reaches Node's *built-in*
 * undici because both read the same well-known global symbol; the copies differ
 * but the dispatcher interface is the one Node's `fetch` calls.
 *
 * Scoped to `vitest.live.config.ts`. Every other tier keeps the defaults - a
 * five-minute wait there is a hang worth failing on.
 */

import { Agent, setGlobalDispatcher } from 'undici';

setGlobalDispatcher(
	new Agent({
		// 0 disables each, matching Bun. `connectTimeout` keeps its default: a TCP
		// connection that never establishes is a real failure at any duration, and
		// nothing about a long agent run makes the dial slow.
		headersTimeout: 0,
		bodyTimeout: 0,
	}),
);

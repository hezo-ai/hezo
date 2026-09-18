import {
	installSupportChat,
	setSupportChatBubble,
	setSupportChatLocale,
	setSupportChatTheme,
} from '@hezo/ui';
import { useQuery } from '@tanstack/react-query';
import { useEffect } from 'react';
import { api } from '../lib/api';
import { useI18n } from '../lib/i18n';
import { queryKeys } from '../lib/query-keys';
import { useTheme } from '../lib/theme';

export interface Support {
	chatwoot: {
		base_url: string;
		website_token: string;
		sdk_integrity: string;
		identifier: string;
		identifier_hash: string;
		name: string | null;
		email: string | null;
	};
}

/**
 * The support channel this deployment offers the instance owner.
 *
 * Asked only where an issuer signs people in **and somebody has**, since the
 * route answers 404 to an instance with no issuer and 401 before a session
 * exists — and a self-hosted instance would otherwise spend a request on every
 * load to hear it. The caller says whether both hold, from the status and the
 * session probe it already has: either query mounted here would fetch again. A
 * 404 is the ordinary answer rather than a fault, so it is not retried, neither
 * at once nor when another component mounts the query.
 */
export function useSupport(identified: boolean) {
	return useQuery({
		queryKey: queryKeys.support(),
		queryFn: () => api.get<Support>('/api/support'),
		enabled: identified,
		retry: false,
		retryOnMount: false,
	});
}

/**
 * Load the support chat wherever the deployer offers one, named or not.
 *
 * **Every screen, the ones reached before signing in included.** The vault
 * gate, the language step and the sign-in form are where somebody shut out of
 * their own instance waits, which is when they most need to ask — so the
 * channel rides on the public status and the widget loads there with nobody
 * named. The launcher shows, because nothing on those screens claims the
 * corner.
 *
 * **An identity that arrives later is adopted, not restarted.** Signing in
 * hands the owner's signed identity to the install already running, so a
 * conversation begun at the gate becomes the owner's rather than being stranded
 * beside a second one. The launcher goes at the same moment: the shell's chat
 * dock takes that corner, and the chat opens from its menu entry instead.
 *
 * `identified` says a session exists to ask about, so the gate spends no
 * request on a route that would answer 401 to a caller who has not signed in.
 */
export function useSupportChat(
	identified: boolean,
	channel?: { base_url: string; website_token: string; sdk_integrity: string },
): void {
	const chatwoot = useSupport(identified).data?.chatwoot;
	const { language } = useI18n();
	const { resolvedTheme } = useTheme();

	useEffect(() => {
		// Both sources carry where the chat is; only one of them names anybody.
		const where = chatwoot ?? channel;
		if (!where) return;

		installSupportChat({
			baseUrl: where.base_url,
			websiteToken: where.website_token,
			sdkIntegrity: where.sdk_integrity,
			...(chatwoot
				? {
						identity: {
							identifier: chatwoot.identifier,
							identifierHash: chatwoot.identifier_hash,
							name: chatwoot.name ?? undefined,
							email: chatwoot.email ?? undefined,
						},
					}
				: {}),
			locale: language,
			colorScheme: resolvedTheme,
			hideBubble: false,
		});
		// Installing is once per page, so a later change — of language, of theme,
		// or of whether a shell has taken the corner — reaches the widget through
		// the setters rather than through a second install.
		setSupportChatBubble(!chatwoot);
		setSupportChatLocale(language);
		setSupportChatTheme(resolvedTheme);
	}, [channel, chatwoot, language, resolvedTheme]);
}

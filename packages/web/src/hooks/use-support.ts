import { type SupportChatFieldKey, supportChatViewport } from '@hezo/shared';
import {
	installSupportChat,
	setSupportChatBubble,
	setSupportChatContext,
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

/** Where the owner is, as only the shell knows it. */
export interface SupportChatPlace {
	/** The gate the shell shows, the setup wizard, or the route template once inside. */
	screen: string;
	/** The project slug from the route, once signed in. */
	project: string | null;
	version: string | null;
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
 *
 * **The support team sees where the owner is.** `place` and the page's own
 * language, theme and width become the conversation's attributes while the chat
 * is open: names the shell chose, never a path, a title or anything typed.
 */
export function useSupportChat(
	identified: boolean,
	channel: { base_url: string; website_token: string; sdk_integrity: string } | undefined,
	place: SupportChatPlace,
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

	// After the install above, and again once there is a chat to install: the
	// loader drops a context handed over before it is installed.
	const offered = Boolean(chatwoot ?? channel);
	const { screen, project, version } = place;
	useEffect(() => {
		if (!offered) return;
		const context: Record<SupportChatFieldKey, string | null> = {
			hezo_surface: 'instance',
			// The instance's paths carry task and document ids, so it names the
			// screen rather than the page.
			hezo_page: null,
			hezo_screen: screen,
			hezo_language: language,
			hezo_theme: resolvedTheme,
			hezo_viewport: supportChatViewport(window.innerWidth),
			hezo_project: project,
			hezo_version: version,
		};
		setSupportChatContext(context);
	}, [offered, screen, project, version, language, resolvedTheme]);
}

import { installSupportChat, setSupportChatLocale, setSupportChatTheme } from '@hezo/ui';
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
 * Asked only where an issuer signs people in, since the server answers 404
 * everywhere else and a self-hosted instance would spend a request on every
 * load to hear it. The caller says whether one does, from the status it
 * already holds: a status query mounted here would fetch the status again. A
 * 404 is the ordinary answer rather than a fault, so it is not retried, neither
 * at once nor when another component mounts the query.
 */
export function useSupport(hosted: boolean) {
	return useQuery({
		queryKey: queryKeys.support(),
		queryFn: () => api.get<Support>('/api/support'),
		enabled: hosted,
		retry: false,
		retryOnMount: false,
	});
}

/**
 * Load the support chat for the signed-in shell, following the app's language
 * and theme. The launcher bubble stays hidden: the chat dock owns that corner,
 * and the chat opens from its menu entry instead.
 */
export function useSupportChat(hosted: boolean): void {
	const chatwoot = useSupport(hosted).data?.chatwoot;
	const { language } = useI18n();
	const { resolvedTheme } = useTheme();

	useEffect(() => {
		if (!chatwoot) return;
		installSupportChat({
			baseUrl: chatwoot.base_url,
			websiteToken: chatwoot.website_token,
			sdkIntegrity: chatwoot.sdk_integrity,
			identity: {
				identifier: chatwoot.identifier,
				identifierHash: chatwoot.identifier_hash,
				name: chatwoot.name ?? undefined,
				email: chatwoot.email ?? undefined,
			},
			locale: language,
			colorScheme: resolvedTheme,
			hideBubble: true,
		});
		// Installing is once per page, so later language or theme changes reach
		// the widget through the setters rather than through a second install.
		setSupportChatLocale(language);
		setSupportChatTheme(resolvedTheme);
	}, [chatwoot, language, resolvedTheme]);
}

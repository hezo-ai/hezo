import type { MessageKey } from '../../lib/i18n';
import type {
	SystemBudgetConversionContent,
	SystemBudgetPausedContent,
	SystemContent,
	SystemHandoffLimitContent,
	SystemTaskTokenCeilingContent,
} from '../comment-content';

/** What a notice's plain-text reading needs from the reader's locale. */
export interface NoticeTextLocale {
	t: (key: MessageKey, vars?: Record<string, string | number>) => string;
	formatNumber: (value: number) => string;
	language: string;
}

const BUDGET_PAUSED_KEYS: Record<
	'agent' | 'project',
	Record<'daily' | 'weekly' | 'monthly', MessageKey>
> = {
	agent: {
		daily: 'comment.budgetPaused.agent.daily',
		weekly: 'comment.budgetPaused.agent.weekly',
		monthly: 'comment.budgetPaused.agent.monthly',
	},
	project: {
		daily: 'comment.budgetPaused.project.daily',
		weekly: 'comment.budgetPaused.project.weekly',
		monthly: 'comment.budgetPaused.project.monthly',
	},
};

/** The catalog sentence for a budget pause, by whose budget and which window. */
export function budgetPausedKey(content: SystemBudgetPausedContent): MessageKey {
	return BUDGET_PAUSED_KEYS[content.scope === 'project' ? 'project' : 'agent'][
		content.period === 'daily' || content.period === 'weekly' ? content.period : 'monthly'
	];
}

/** The agents a handoff-limit notice names, with anything malformed dropped. */
export function handoffAgentSlugs(content: SystemHandoffLimitContent): string[] {
	return Array.isArray(content.agent_slugs)
		? content.agent_slugs.filter((s): s is string => typeof s === 'string' && s.length > 0)
		: [];
}

/** The opening sentence of the conversion notice, by where its rate came from. */
export function budgetConversionIntroKey(content: SystemBudgetConversionContent): MessageKey {
	return content.basis === 'fallback'
		? 'comment.budgetConversion.introFallback'
		: 'comment.budgetConversion.intro';
}

type NoticeContent = {
	handoff_limit: SystemHandoffLimitContent;
	task_token_ceiling: SystemTaskTokenCeilingContent;
	budget_paused: SystemBudgetPausedContent;
	budget_conversion: SystemBudgetConversionContent;
};

const NOTICE_TEXT: {
	[K in keyof NoticeContent]: (content: NoticeContent[K], locale: NoticeTextLocale) => string;
} = {
	handoff_limit: (content, { t, formatNumber, language }) => {
		const slugs = handoffAgentSlugs(content);
		return t('comment.handoffLimit', {
			agents:
				slugs.length > 0
					? new Intl.ListFormat(language, { type: 'conjunction' }).format(
							slugs.map((slug) => `@${slug}`),
						)
					: t('comment.runAgentFallback'),
			rounds: formatNumber(Number(content.rounds ?? 0)),
			tokens: formatNumber(Number(content.tokens ?? 0)),
		});
	},
	task_token_ceiling: (content, { t, formatNumber }) =>
		t('comment.taskTokenCeiling', {
			tokens: formatNumber(Number(content.tokens ?? 0)),
			ceiling: formatNumber(Number(content.ceiling ?? 0)),
		}),
	budget_paused: (content, { t, formatNumber }) =>
		t(budgetPausedKey(content), {
			agent:
				typeof content.agent_slug === 'string' && content.agent_slug
					? `@${content.agent_slug}`
					: t('comment.runAgentFallback'),
			limit: formatNumber(Number(content.limit_tokens ?? 0)),
			used: formatNumber(Number(content.used_tokens ?? 0)),
		}),
	budget_conversion: (content, { t, formatNumber }) =>
		t(budgetConversionIntroKey(content), {
			rate: formatNumber(Math.round(Number(content.tokens_per_cent ?? 0) * 100)),
		}),
};

/**
 * A notice Hezo raises for the admin, as one plain line in the reader's language:
 * the thread's own catalog sentence, with agents named as `@slug` text. For a
 * surface that shows a line rather than the thread - an inbox row, a dashboard
 * item. Null for any other system comment.
 */
export function systemNoticeText(content: SystemContent, locale: NoticeTextLocale): string | null {
	const render = NOTICE_TEXT[content.kind as keyof NoticeContent] as
		| ((content: SystemContent, locale: NoticeTextLocale) => string)
		| undefined;
	return render ? render(content, locale) : null;
}

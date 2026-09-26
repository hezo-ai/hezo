import type {
	SystemBudgetConversionContent,
	SystemBudgetPausedContent,
	SystemContent,
	SystemCredentialModelContent,
	SystemHandoffLimitContent,
	SystemRunSizeStopContent,
	SystemTaskTokenCeilingContent,
} from '../components/comment-content';
import type { MessageKey } from './i18n';

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
	run_size_stop: SystemRunSizeStopContent;
	budget_paused: SystemBudgetPausedContent;
	budget_conversion: SystemBudgetConversionContent;
	default_model_backfill: SystemCredentialModelContent;
	credential_model_unlisted: SystemCredentialModelContent;
};

/** The opening sentence of a credential-model notice, by its kind. */
export const CREDENTIAL_MODEL_INTRO_KEYS: Record<SystemCredentialModelContent['kind'], MessageKey> =
	{
		default_model_backfill: 'comment.defaultModelBackfill',
		credential_model_unlisted: 'comment.credentialModelUnlisted',
	};

/** A notice as its catalog sentence plus the values that fill it. */
export interface NoticeParts {
	key: MessageKey;
	vars: Record<string, string>;
	/** Agent slugs the sentence names, which a renderer may draw as links. */
	agentSlugs: string[];
}

const NOTICE_PARTS: {
	[K in keyof NoticeContent]: (content: NoticeContent[K], locale: NoticeTextLocale) => NoticeParts;
} = {
	handoff_limit: (content, { t, formatNumber, language }) => {
		const slugs = handoffAgentSlugs(content);
		return {
			key: 'comment.handoffLimit',
			vars: {
				agents:
					slugs.length > 0
						? new Intl.ListFormat(language, { type: 'conjunction' }).format(
								slugs.map((slug) => `@${slug}`),
							)
						: t('comment.runAgentFallback'),
				rounds: formatNumber(Number(content.rounds ?? 0)),
				tokens: formatNumber(Number(content.tokens ?? 0)),
			},
			agentSlugs: slugs,
		};
	},
	task_token_ceiling: (content, { formatNumber }) => ({
		key: 'comment.taskTokenCeiling',
		vars: {
			tokens: formatNumber(Number(content.tokens ?? 0)),
			ceiling: formatNumber(Number(content.ceiling ?? 0)),
		},
		agentSlugs: [],
	}),
	run_size_stop: () => ({ key: 'comment.runSizeStop', vars: {}, agentSlugs: [] }),
	budget_paused: (content, { t, formatNumber }) => {
		const slug = typeof content.agent_slug === 'string' ? content.agent_slug : '';
		return {
			key: budgetPausedKey(content),
			vars: {
				agent: slug ? `@${slug}` : t('comment.runAgentFallback'),
				limit: formatNumber(Number(content.limit_tokens ?? 0)),
				used: formatNumber(Number(content.used_tokens ?? 0)),
			},
			agentSlugs: slug ? [slug] : [],
		};
	},
	budget_conversion: (content, { formatNumber }) => ({
		key: budgetConversionIntroKey(content),
		vars: { rate: formatNumber(Math.round(Number(content.tokens_per_cent ?? 0) * 100)) },
		agentSlugs: [],
	}),
	default_model_backfill: (content) => ({
		key: CREDENTIAL_MODEL_INTRO_KEYS[content.kind],
		vars: {},
		agentSlugs: [],
	}),
	credential_model_unlisted: (content) => ({
		key: CREDENTIAL_MODEL_INTRO_KEYS[content.kind],
		vars: {},
		agentSlugs: [],
	}),
};

/**
 * The sentence a notice reads as, and its values: one home for the thread, which
 * draws the agents as links, and every surface that shows the line as text. Null
 * for any other system comment.
 */
export function noticeParts(content: SystemContent, locale: NoticeTextLocale): NoticeParts | null {
	const build = NOTICE_PARTS[content.kind as keyof NoticeContent] as
		| ((content: SystemContent, locale: NoticeTextLocale) => NoticeParts)
		| undefined;
	return build ? build(content, locale) : null;
}

/**
 * A notice Hezo raises for the admin, as one plain line in the reader's language:
 * the thread's own catalog sentence, with agents named as `@slug` text. For a
 * surface that shows a line rather than the thread - an inbox row, a dashboard
 * item. Null for any other system comment.
 */
export function systemNoticeText(content: SystemContent, locale: NoticeTextLocale): string | null {
	const parts = noticeParts(content, locale);
	return parts ? locale.t(parts.key, parts.vars) : null;
}

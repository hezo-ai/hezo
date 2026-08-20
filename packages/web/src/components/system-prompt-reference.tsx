import {
	LIVE_CONTEXT_BLOCK_VARS,
	SYSTEM_PROMPT_TEMPLATE_VARS,
	SYSTEM_PROMPT_VAR_TRIGGER,
} from '@hezo/shared';
import { ChevronRight } from 'lucide-react';
import { useI18n } from '../lib/i18n';

/**
 * The blocks the resolver appends to every prompt after the authored body, in
 * resolve order. Named here only to be listed - the server owns the real order
 * (`template-resolver.ts`), and nothing here changes what an agent receives.
 */
const APPENDED_BLOCKS = [
	'Run Context',
	'Repository',
	'Project State',
	'Your Team',
	'Teammates',
	'Working Guidelines',
	'Container Environment',
] as const;

/** Identity + live context + everything appended, for the collapsed summary. */
const BLOCK_COUNT = APPENDED_BLOCKS.length + 2;

/**
 * The one reference above a system-prompt editor: every value an author can
 * place with the `{{` lookup, and every block Hezo composes around the body.
 *
 * It sits where the variable chips used to, and carries what their tooltips
 * carried. Collapsed it is a single line, because that is the state most
 * authors will ever see - so the line states the insertion affordance rather
 * than hiding it behind the disclosure.
 */
export function SystemPromptReference() {
	const { t } = useI18n();

	return (
		<details className="group mb-2 rounded-md border border-dashed border-live bg-live-soft">
			<summary className="flex cursor-pointer list-none items-start gap-2 px-3 py-2 text-xs text-live-soft-fg [&::-webkit-details-marker]:hidden">
				<ChevronRight className="mt-0.5 h-3 w-3 shrink-0 transition-transform group-open:rotate-90" />
				<span>
					<span className="font-semibold">
						{t('agents.prompt.reference.summary', { count: String(BLOCK_COUNT) })}
					</span>{' '}
					{t('agents.prompt.reference.insertHint', {
						trigger: SYSTEM_PROMPT_VAR_TRIGGER,
						count: String(SYSTEM_PROMPT_TEMPLATE_VARS.length),
					})}
				</span>
			</summary>

			<div className="flex flex-col gap-3 border-t border-live/35 p-3">
				<p className="text-xs leading-relaxed text-live-soft-fg">
					{t('agents.prompt.reference.lede')}
				</p>

				<div className="flex flex-col gap-1.5">
					<span className="text-[11px] font-medium uppercase tracking-wider text-live-soft-fg">
						{t('agents.prompt.reference.valuesTitle')}
					</span>
					<div className="overflow-hidden rounded-md border border-border bg-surface">
						{SYSTEM_PROMPT_TEMPLATE_VARS.map((v) => (
							<div
								key={v.token}
								className="grid grid-cols-1 gap-x-3 border-t border-border px-3 py-1.5 first:border-t-0 sm:grid-cols-[minmax(150px,215px)_1fr]"
							>
								<code className="font-mono text-[11.5px] text-info-soft-fg">{v.token}</code>
								<span className="text-[11.5px] text-text-2">{v.description}</span>
							</div>
						))}
					</div>
				</div>

				<PromptBlock
					title={t('agents.prompt.reference.identityTitle')}
					body={`You are the <role> at <team>.\n\n<the team's description, when it has one>\n\nYou report to: <manager>.`}
				/>
				<PromptBlock
					title={t('agents.prompt.reference.liveContextTitle')}
					body={`---\n\nCurrent date: ${LIVE_CONTEXT_BLOCK_VARS[0]}\n\n${LIVE_CONTEXT_BLOCK_VARS.slice(1).join('\n\n')}`}
				/>

				<div className="flex flex-col gap-1.5">
					<span className="text-[11px] font-medium uppercase tracking-wider text-live-soft-fg">
						{t('agents.prompt.reference.appendedTitle')}
					</span>
					<div className="flex flex-wrap gap-1.5">
						{APPENDED_BLOCKS.map((name) => (
							<span
								key={name}
								className="rounded-full border border-live/45 bg-surface px-2 py-0.5 text-[11px] text-live-soft-fg"
							>
								{name}
							</span>
						))}
					</div>
				</div>
			</div>
		</details>
	);
}

function PromptBlock({ title, body }: { title: string; body: string }) {
	return (
		<div className="flex flex-col gap-1.5">
			<span className="text-[11px] font-medium uppercase tracking-wider text-live-soft-fg">
				{title}
			</span>
			<pre className="overflow-x-auto whitespace-pre-wrap rounded-md border border-border bg-surface px-3 py-2 font-mono text-[11.5px] leading-relaxed text-text-2">
				{body}
			</pre>
		</div>
	);
}

import { checkInjectedTextCap, INJECTED_TEXT_CAPS, type InjectedTextKind } from '@hezo/shared';
import { useI18n } from '../lib/i18n';

/**
 * The size readout that sits under an editor whose text is injected into a prompt
 * in full, plus the reason it cannot be saved when it is over the ceiling.
 *
 * It calls the same `checkInjectedTextCap` the server refuses with, so the inline
 * feedback and the enforcement cannot disagree. That includes the rule that a
 * value which is *already* over the ceiling stays saveable as long as the edit
 * makes it shorter, which is why `savedLength` is required rather than optional:
 * an editor that did not pass it would block edits the server would accept.
 */
export function InjectedTextCapNotice({
	kind,
	content,
	savedLength,
	className,
}: {
	kind: InjectedTextKind;
	content: string;
	/** Length of the value currently stored, which this edit would replace. */
	savedLength: number;
	className?: string;
}) {
	const { t } = useI18n();
	const limit = INJECTED_TEXT_CAPS[kind];
	const refusal = checkInjectedTextCap(kind, content, savedLength);
	const over = content.length > limit;

	return (
		<div
			className={`flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1 ${className ?? ''}`}
		>
			<span
				className={`text-xs tabular-nums ${refusal ? 'text-danger' : 'text-text-3'}`}
				data-testid="injected-cap-counter"
			>
				{t('injectedCap.counter', {
					count: content.length.toLocaleString(),
					limit: limit.toLocaleString(),
				})}
			</span>
			{over && (
				<span className="text-xs text-danger" data-testid="injected-cap-message">
					{refusal
						? t('injectedCap.over', { over: (content.length - limit).toLocaleString() })
						: t('injectedCap.shrinkOnly')}
				</span>
			)}
		</div>
	);
}

/**
 * Whether this edit must be blocked. Exported beside the notice so a Save button
 * and the message under it can never disagree about which edits are allowed.
 */
export function injectedTextCapBlocks(
	kind: InjectedTextKind,
	content: string,
	savedLength: number,
): boolean {
	return checkInjectedTextCap(kind, content, savedLength) !== null;
}

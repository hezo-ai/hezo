import { TriangleAlert } from 'lucide-react';
import type { ReactNode } from 'react';
import { type MessageKey, useI18n } from '../../lib/i18n';

/**
 * One budget window, used against its limit, in whatever the budget counts -
 * tokens or container-seconds. The token card and the hours card draw their
 * windows from this, so a window reads the same way whatever it measures.
 */
export interface WindowFigures {
	used: number;
	/** 0 is no limit. */
	limit: number;
	over: boolean;
}

export type WindowKey = 'daily' | 'weekly' | 'monthly';

/** The windows in the order a person reads them. */
export const WINDOW_KEYS: readonly WindowKey[] = ['daily', 'weekly', 'monthly'];

export function pctUsed(s: WindowFigures): number {
	if (s.limit <= 0) return 0;
	return Math.min(Math.round((s.used / s.limit) * 100), 999);
}

function toneFor(s: WindowFigures): 'success' | 'warning' | 'danger' {
	const p = pctUsed(s);
	if (s.over || p >= 90) return 'danger';
	if (p >= 70) return 'warning';
	return 'success';
}

const TONE_TEXT = {
	success: 'text-success',
	warning: 'text-warning',
	danger: 'text-danger',
} as const;
const TONE_BAR = { success: 'bg-success', warning: 'bg-warning', danger: 'bg-danger' } as const;

/**
 * When each window comes round again. Daily and weekly are the UTC day and the
 * ISO week for every budget; the month is the caller's, because the hours
 * budget's month is the container-hours window, which may be anchored to a
 * billing day.
 */
export function useResetCaption(): (w: WindowKey, monthEnd: Date) => string {
	const { t, formatDate } = useI18n();
	return (w, monthEnd) => {
		const now = new Date();
		if (w === 'daily') {
			const reset = Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1);
			const ms = reset - now.getTime();
			return t('budget.usage.resetsIn', {
				hours: Math.floor(ms / 3_600_000),
				minutes: String(Math.floor((ms % 3_600_000) / 60_000)).padStart(2, '0'),
			});
		}
		if (w === 'weekly') return t('budget.usage.resetsMonday');
		return t('budget.usage.resetsOn', { date: formatDate(monthEnd) });
	};
}

/** One window's column: used against the limit, a bar, and when it resets. */
export function WindowColumn({
	figures,
	label,
	format,
	resetCaption,
	testId,
}: {
	figures: WindowFigures;
	label: string;
	/** How a used or limit figure reads: compact tokens, or hours. */
	format: (n: number) => string;
	resetCaption: string;
	testId: string;
}) {
	const { t } = useI18n();
	const unlimited = figures.limit <= 0;
	const tone = toneFor(figures);
	const p = pctUsed(figures);
	return (
		<div className="flex flex-1 flex-col gap-2 p-5" data-testid={testId}>
			<div className="flex items-center justify-between">
				<span className="text-eyebrow text-text-3">{label}</span>
				{!unlimited && (
					<span className={`font-mono text-[12px] font-medium ${TONE_TEXT[tone]}`}>{p}%</span>
				)}
			</div>
			<div className="flex items-center gap-1.5">
				<span className="font-mono text-[18px] font-semibold tabular-nums text-text-1">
					{format(figures.used)}
				</span>
				<span className="font-mono text-[13px] text-text-3">
					/ {unlimited ? t('budget.usage.noLimit') : format(figures.limit)}
				</span>
			</div>
			{!unlimited && (
				<div className="h-1.5 overflow-hidden rounded-full bg-surface-3">
					<div
						className={`h-full rounded-full ${TONE_BAR[tone]}`}
						style={{ width: `${Math.min(p, 100)}%` }}
					/>
				</div>
			)}
			<span className="text-[11px] text-text-3">
				{unlimited ? t('budget.usage.unlimited') : resetCaption}
			</span>
		</div>
	);
}

/**
 * The window closest to its limit, once one is at 70% or more, with the way to
 * raise it. Nothing when every window has room or none has a limit.
 */
export function BindingBanner({
	windows,
	labels,
	body,
	action,
	testId = 'binding-window-banner',
}: {
	windows: Record<WindowKey, WindowFigures>;
	labels: Record<WindowKey, MessageKey>;
	/** The sentence for the binding window, given its percentage, limit and what is left. */
	body: (percent: number, limit: number, remaining: number) => string;
	/** How to raise the limit: a link to where it is edited, or a button that opens the editor. */
	action: ReactNode;
	testId?: string;
}) {
	const { t } = useI18n();
	const limited = WINDOW_KEYS.filter((key) => windows[key].limit > 0);
	if (limited.length === 0) return null;
	const binding = limited.reduce((a, b) => (pctUsed(windows[b]) > pctUsed(windows[a]) ? b : a));
	const figures = windows[binding];
	const p = pctUsed(figures);
	if (p < 70) return null;
	const over = figures.over || p >= 100;
	const remaining = Math.max(figures.limit - figures.used, 0);
	const fg = over ? 'text-danger-soft-fg' : 'text-warning-soft-fg';
	return (
		<div
			data-testid={testId}
			className={`mt-4 flex flex-col gap-2 rounded-md border px-4 py-3 sm:flex-row sm:items-center sm:justify-between ${
				over ? 'border-danger/30 bg-danger-soft' : 'border-warning/30 bg-warning-soft'
			}`}
		>
			<div className="flex items-start gap-2 text-[13px]">
				<TriangleAlert className={`mt-0.5 h-4 w-4 shrink-0 ${fg}`} aria-hidden />
				<p className={fg}>
					<strong className="font-semibold">
						{t('budget.usage.binding.title', { window: t(labels[binding]) })}
					</strong>{' '}
					{body(p, figures.limit, remaining)}
				</p>
			</div>
			{action}
		</div>
	);
}

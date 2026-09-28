import {
	ALLOWANCE_DAILY_SHARE_MAX_PERCENT,
	allowancePace,
	evenDailySharePercent,
	type ProviderAllowance,
	validateAllowanceDailyShare,
} from '@hezo/shared';
import { useId, useState } from 'react';
import type { AiProviderConfig } from '../hooks/use-ai-providers';
import { type MessageKey, useI18n } from '../lib/i18n';
import { Button } from './ui/button';
import { Input } from './ui/input';

/** A week, in minutes: the window the presets are stated against. */
const WEEK_MINUTES = 7 * 24 * 60;

/** The five-day preset: a fifth of the week a day. */
const FIVE_DAY_SHARE_PERCENT = 20;

/** A config's stored usage window, or null when no run has read one yet. */
export function configAllowance(config: AiProviderConfig): ProviderAllowance | null {
	if (
		config.allowance_used_percent === null ||
		config.allowance_window_minutes === null ||
		!config.allowance_resets_at
	) {
		return null;
	}
	return {
		usedPercent: config.allowance_used_percent,
		windowMinutes: config.allowance_window_minutes,
		resetsAt: new Date(config.allowance_resets_at),
	};
}

/** Where a config's window stands, as one line; null when there is nothing to say. */
export function AllowanceWeekLine({
	config,
	share,
	className = 'text-[13px] text-text-3',
}: {
	config: AiProviderConfig;
	/** The share to judge against, so the dialog can show a share before it is saved. */
	share?: number | null;
	className?: string;
}) {
	const { t, formatNumber, formatDateTime } = useI18n();
	const pace = allowancePace(
		configAllowance(config),
		share === undefined ? config.allowance_daily_share_percent : share,
		new Date(),
	);
	if (!pace) return null;
	return (
		<p className={className} data-testid={`allowance-week-${config.id}`}>
			{t('settings.provider.pacing.week', {
				used: formatNumber(Math.round(pace.usedPercent)),
				resets: formatDateTime(pace.resetsAt),
				limit: formatNumber(Math.round(pace.limitPercent)),
			})}
		</p>
	);
}

/**
 * The pace a subscription's usage window is spent at: a daily share of the
 * window, the even spread by default. The value is held by the caller, which
 * saves it with the rest of the dialog; null is the even default.
 */
export function AllowancePacingField({
	config,
	value,
	onChange,
}: {
	config: AiProviderConfig;
	value: number | null;
	onChange: (value: number | null) => void;
}) {
	const { t, formatNumber } = useI18n();
	const windowMinutes = config.allowance_window_minutes ?? WEEK_MINUTES;
	const effective = value ?? evenDailySharePercent(windowMinutes);
	const [draft, setDraft] = useState(() => String(Math.round(effective * 10) / 10));
	const [invalid, setInvalid] = useState(false);
	const inputId = useId();

	const pick = (next: number | null) => {
		setInvalid(false);
		setDraft(String(Math.round((next ?? evenDailySharePercent(windowMinutes)) * 10) / 10));
		onChange(next);
	};

	const presets: { label: MessageKey; share: number | null }[] = [
		{ label: 'settings.provider.pacing.preset.even', share: null },
		{ label: 'settings.provider.pacing.preset.fiveDays', share: FIVE_DAY_SHARE_PERCENT },
		{ label: 'settings.provider.pacing.preset.off', share: ALLOWANCE_DAILY_SHARE_MAX_PERCENT },
	];

	return (
		<div className="flex flex-col gap-1.5" data-testid="allowance-pacing">
			<span className="text-eyebrow text-text-2">{t('settings.provider.pacing.label')}</span>
			<div className="flex flex-wrap gap-2">
				{presets.map((preset) => (
					<Button
						key={preset.label}
						type="button"
						size="sm"
						variant={value === preset.share ? 'primary' : 'secondary'}
						aria-pressed={value === preset.share}
						onClick={() => pick(preset.share)}
					>
						{t(preset.label)}
					</Button>
				))}
			</div>
			<div className="flex flex-col gap-1">
				<label htmlFor={inputId} className="text-[13px] text-text-2">
					{t('settings.provider.pacing.shareLabel')}
				</label>
				<Input
					id={inputId}
					type="number"
					inputMode="decimal"
					min={5}
					max={100}
					step="any"
					value={draft}
					aria-invalid={invalid}
					data-testid="allowance-share-input"
					className="w-full sm:w-32"
					onChange={(e) => {
						setDraft(e.target.value);
						const parsed = Number(e.target.value);
						const bad =
							e.target.value.trim() === '' || validateAllowanceDailyShare(parsed) !== null;
						setInvalid(bad);
						if (!bad) onChange(parsed);
					}}
				/>
			</div>
			{invalid ? (
				<p className="text-[13px] text-danger">{t('settings.provider.pacing.invalid')}</p>
			) : (
				<p className="text-[13px] text-text-3">
					{effective >= ALLOWANCE_DAILY_SHARE_MAX_PERCENT
						? t('settings.provider.pacing.off')
						: t('settings.provider.pacing.spread', {
								days: formatNumber(Math.round((100 / effective) * 10) / 10),
							})}
				</p>
			)}
			<p className="text-[13px] text-text-3">{t('settings.provider.pacing.hint')}</p>
			{configAllowance(config) ? (
				<AllowanceWeekLine config={config} share={value} />
			) : (
				<p className="text-[13px] text-text-3">{t('settings.provider.pacing.notReported')}</p>
			)}
		</div>
	);
}

import type { TaskView } from '@hezo/shared';
import { Link } from '@tanstack/react-router';
import type { ReactNode } from 'react';
import { useInstanceSettings, useUpdateInstanceSettings } from '../hooks/use-instance-settings';
import { type LandingPreference, useLandingPreference } from '../hooks/use-landing-preference';
import { useMe } from '../hooks/use-me';
import { useI18n } from '../lib/i18n';
import { TASK_VIEW_META, useTaskViewOptions } from '../lib/task-view-options';
import { useTheme } from '../lib/theme';
import { SegmentedControl } from './ui/segmented-control';
import { THEME_OPTIONS } from './ui/theme-switcher';

/**
 * Who a setting applies to. The Appearance page carries settings with two
 * different reaches - theme is this browser's, the task view is the whole
 * instance's - so each one says which it is rather than leaving the reader to
 * find out by changing it.
 */
function ScopeBadge({ children, everyone }: { children: ReactNode; everyone?: boolean }) {
	return (
		<span
			className={`rounded font-mono text-[9px] uppercase tracking-wide px-1.5 py-px ${
				everyone
					? 'bg-accent-soft text-accent-soft-fg'
					: 'border border-border bg-surface-2 text-text-3'
			}`}
		>
			{children}
		</span>
	);
}

function SettingBlock({
	title,
	scope,
	help,
	children,
	highlighted,
	testId,
}: {
	title: string;
	scope: ReactNode;
	help: string;
	children: ReactNode;
	highlighted?: boolean;
	testId?: string;
}) {
	return (
		<section
			data-testid={testId}
			className={`rounded-md border p-3 bg-surface mb-3 ${
				highlighted ? 'border-accent' : 'border-border'
			}`}
		>
			<div className="flex items-center gap-2 mb-0.5">
				<h2 className="text-[13px] font-medium text-text-1">{title}</h2>
				{scope}
			</div>
			<p className="text-[12px] text-text-3 mb-2.5 max-w-[560px]">{help}</p>
			{children}
		</section>
	);
}

/** Theme, landing view, task view and a pointer at the locale editor. */
export function AppearanceSection() {
	const { t } = useI18n();
	const { preference, setPreference } = useTheme();
	const { data: me } = useMe();
	const { data: settings } = useInstanceSettings();
	const updateSettings = useUpdateInstanceSettings();
	const viewOptions = useTaskViewOptions();
	const landing = useLandingPreference();

	const themeOptions = THEME_OPTIONS.map(({ value, labelKey, icon }) => ({
		value,
		label: t(labelKey),
		icon,
	}));
	const landingOptions: Array<{ value: LandingPreference; label: string }> = [
		{ value: 'adaptive', label: t('appearance.landing.adaptive') },
		{ value: 'dashboard', label: t('appearance.landing.dashboard') },
		{ value: 'chat', label: t('appearance.landing.chat') },
	];

	return (
		<div className="max-w-[640px]">
			<div className="mb-5">
				<h1 className="text-[22px] font-medium">{t('settings.appearance')}</h1>
				<p className="text-[13px] text-text-2 mt-1">{t('appearance.subtitle')}</p>
			</div>

			<SettingBlock
				title={t('appearance.theme.title')}
				scope={<ScopeBadge>{t('appearance.scope.browser')}</ScopeBadge>}
				help={t('appearance.theme.help')}
				testId="appearance-theme"
			>
				<SegmentedControl
					options={themeOptions}
					value={preference}
					onChange={setPreference}
					label={t('appearance.theme.title')}
					className="max-w-[300px]"
					testId="appearance-theme-control"
				/>
			</SettingBlock>

			<SettingBlock
				title={t('appearance.landing.title')}
				scope={<ScopeBadge>{t('appearance.scope.account')}</ScopeBadge>}
				help={t('appearance.landing.help')}
				testId="appearance-landing"
			>
				{landing.loaded && (
					<SegmentedControl
						options={landingOptions}
						value={landing.preference}
						// Response-driven: the server's merged settings echo reseeds the cache.
						onChange={(next: LandingPreference) => landing.setPreference(next)}
						label={t('appearance.landing.title')}
						className="max-w-[380px]"
						testId="appearance-landing-control"
					/>
				)}
			</SettingBlock>

			<SettingBlock
				title={t('taskView.title')}
				scope={
					<ScopeBadge everyone>
						{me?.is_superuser
							? t('appearance.scope.everyoneAdmin')
							: t('appearance.scope.everyone')}
					</ScopeBadge>
				}
				help={t('taskView.help')}
				highlighted
				testId="appearance-task-view"
			>
				{settings === undefined ? null : me?.is_superuser ? (
					<>
						<SegmentedControl
							options={viewOptions}
							value={settings.default_task_view}
							// Response-driven, not optimistic: the server validates the value
							// and its echo is what seeds the cache.
							onChange={(view: TaskView) => updateSettings.mutate({ default_task_view: view })}
							label={t('taskView.title')}
							className="max-w-[300px]"
							testId="default-task-view-control"
						/>
						<p className="text-[12px] text-text-3 mt-2.5 max-w-[560px]">{t('taskView.railNote')}</p>
					</>
				) : (
					<p className="text-[13px] text-text-2" data-testid="default-task-view-readonly">
						{t(TASK_VIEW_META[settings.default_task_view].labelKey)}
						{' - '}
						{t('taskView.adminOnly')}
					</p>
				)}
			</SettingBlock>

			<SettingBlock
				title={t('locale.settings.title')}
				scope={<ScopeBadge everyone>{t('appearance.scope.everyone')}</ScopeBadge>}
				help={t('locale.settings.pageDescription')}
				testId="appearance-language"
			>
				<Link to="/settings/locale" className="text-[12px] text-info-soft-fg hover:underline">
					{t('appearance.language.open')}
				</Link>
			</SettingBlock>
		</div>
	);
}

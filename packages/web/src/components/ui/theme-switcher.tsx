import * as Popover from '@radix-ui/react-popover';
import { Check, Monitor, Moon, Sun } from 'lucide-react';
import { type MessageKey, useI18n } from '../../lib/i18n';
import { type ThemePreference, useTheme } from '../../lib/theme';

const options: { value: ThemePreference; labelKey: MessageKey; icon: typeof Sun }[] = [
	{ value: 'system', labelKey: 'theme.system', icon: Monitor },
	{ value: 'light', labelKey: 'theme.light', icon: Sun },
	{ value: 'dark', labelKey: 'theme.dark', icon: Moon },
];

export function ThemeSwitcher() {
	const { preference, setPreference, resolvedTheme } = useTheme();
	const { t } = useI18n();
	const CurrentIcon = resolvedTheme === 'dark' ? Moon : Sun;

	return (
		<Popover.Root>
			<Popover.Trigger asChild>
				<button
					type="button"
					className="inline-flex items-center justify-center w-8 h-8 rounded-md text-text-2 hover:text-text-1 hover:bg-surface-3 transition-colors cursor-pointer"
					aria-label={t('theme.label')}
				>
					<CurrentIcon className="w-4 h-4" />
				</button>
			</Popover.Trigger>
			<Popover.Portal>
				<Popover.Content
					align="end"
					sideOffset={4}
					className="z-50 min-w-[140px] rounded-md border bg-surface p-1 shadow-md"
				>
					{options.map(({ value, labelKey, icon: Icon }) => (
						<button
							key={value}
							type="button"
							onClick={() => setPreference(value)}
							className={`flex w-full items-center gap-3 rounded-md px-3 py-1.5 text-[13px] transition-colors cursor-pointer ${
								preference === value
									? 'bg-surface-3 text-text-1 font-medium'
									: 'text-text-2 hover:text-text-1 hover:bg-surface-3'
							}`}
						>
							<Icon className="w-4 h-4" />
							<span className="flex-1 text-left">{t(labelKey)}</span>
							{preference === value && <Check className="w-3.5 h-3.5" />}
						</button>
					))}
				</Popover.Content>
			</Popover.Portal>
		</Popover.Root>
	);
}

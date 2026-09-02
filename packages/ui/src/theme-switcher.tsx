import * as Popover from '@radix-ui/react-popover';
import { Check, Monitor, Moon, Sun } from 'lucide-react';
import { type ThemePreference, useTheme } from './theme.js';

/**
 * The three theme choices, shared with whatever settings page also lists them.
 *
 * **The icon and the value, never the words.** A catalog key here would put the
 * app's translation layer inside the package, which is what stops a primitive
 * being drawn twice; the caller maps `value` to its own label.
 */
export const THEME_OPTIONS: { value: ThemePreference; icon: typeof Sun }[] = [
	{ value: 'system', icon: Monitor },
	{ value: 'light', icon: Sun },
	{ value: 'dark', icon: Moon },
];

/** English defaults, so the switcher renders standalone. */
const DEFAULT_LABELS: Record<ThemePreference, string> = {
	system: 'System',
	light: 'Light',
	dark: 'Dark',
};

interface ThemeSwitcherProps {
	/** The trigger's accessible name. */
	label?: string;
	/** What each choice is called. English defaults; the app passes its own. */
	optionLabels?: Record<ThemePreference, string>;
}

export function ThemeSwitcher({
	label = 'Theme',
	optionLabels = DEFAULT_LABELS,
}: ThemeSwitcherProps = {}) {
	const { preference, setPreference, resolvedTheme } = useTheme();
	const CurrentIcon = resolvedTheme === 'dark' ? Moon : Sun;

	return (
		<Popover.Root>
			<Popover.Trigger asChild>
				<button
					type="button"
					className="inline-flex items-center justify-center w-8 h-8 rounded-md text-text-2 hover:text-text-1 hover:bg-surface-3 transition-colors cursor-pointer"
					aria-label={label}
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
					{THEME_OPTIONS.map(({ value, icon: Icon }) => (
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
							<span className="flex-1 text-left">{optionLabels[value]}</span>
							{preference === value && <Check className="w-3.5 h-3.5" />}
						</button>
					))}
				</Popover.Content>
			</Popover.Portal>
		</Popover.Root>
	);
}

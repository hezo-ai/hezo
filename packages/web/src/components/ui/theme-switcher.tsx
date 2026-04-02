import * as Popover from '@radix-ui/react-popover';
import { Check, Monitor, Moon, Sun } from 'lucide-react';
import { type ThemePreference, useTheme } from '../../lib/theme';

const options: { value: ThemePreference; label: string; icon: typeof Sun }[] = [
	{ value: 'system', label: 'System', icon: Monitor },
	{ value: 'light', label: 'Light', icon: Sun },
	{ value: 'dark', label: 'Dark', icon: Moon },
];

export function ThemeSwitcher() {
	const { preference, setPreference, resolvedTheme } = useTheme();
	const CurrentIcon = resolvedTheme === 'dark' ? Moon : Sun;

	return (
		<Popover.Root>
			<Popover.Trigger asChild>
				<button
					type="button"
					className="inline-flex items-center justify-center w-8 h-8 rounded-radius-md text-text-muted hover:text-text hover:bg-bg-muted transition-colors cursor-pointer"
					aria-label="Toggle theme"
				>
					<CurrentIcon className="w-4 h-4" />
				</button>
			</Popover.Trigger>
			<Popover.Portal>
				<Popover.Content
					align="end"
					sideOffset={4}
					className="z-50 min-w-[140px] rounded-radius-md border bg-bg-elevated p-1 shadow-md"
				>
					{options.map(({ value, label, icon: Icon }) => (
						<button
							key={value}
							type="button"
							onClick={() => setPreference(value)}
							className={`flex w-full items-center gap-3 rounded-radius-md px-3 py-1.5 text-[13px] transition-colors cursor-pointer ${
								preference === value
									? 'text-accent-blue-text'
									: 'text-text-muted hover:text-text hover:bg-bg-muted'
							}`}
						>
							<Icon className="w-4 h-4" />
							<span className="flex-1 text-left">{label}</span>
							{preference === value && <Check className="w-3.5 h-3.5" />}
						</button>
					))}
				</Popover.Content>
			</Popover.Portal>
		</Popover.Root>
	);
}

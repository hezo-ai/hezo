import { Share, X } from 'lucide-react';
import { useEffect } from 'react';
import { useInstallPrompt } from '../hooks/use-install-prompt';
import { Button } from './ui/button';
import { Logo } from './ui/logo';

interface PwaInstallPromptProps {
	/**
	 * Reports whether the card is currently showing, so the shell can hide the
	 * floating new-task button — both pin to the bottom of the mobile viewport,
	 * and the full-width card would otherwise cover the button.
	 */
	onVisibleChange?: (visible: boolean) => void;
}

/**
 * Mobile-only, dismissible "install Hezo to your home screen" card pinned to the
 * bottom of the viewport. Hidden on `lg` and up (desktop), mirroring the rest of
 * the app's mobile-gating convention (rail/drawer/FAB all use `lg:hidden`).
 *
 * On Chrome/Android it offers a one-tap **Install** button backed by the
 * captured `beforeinstallprompt` event; on iOS Safari — which has no
 * programmatic prompt — it shows the manual Share → Add to Home Screen steps.
 * Dismissal is remembered (see {@link useInstallPrompt}) so it doesn't nag.
 */
export function PwaInstallPrompt({ onVisibleChange }: PwaInstallPromptProps = {}) {
	const { platform, promptInstall, dismiss } = useInstallPrompt();

	const visible = platform !== null;
	useEffect(() => {
		onVisibleChange?.(visible);
	}, [visible, onVisibleChange]);

	if (!platform) return null;

	return (
		<div
			data-testid="pwa-install-prompt"
			className="lg:hidden fixed inset-x-3 bottom-3 z-40 flex items-start gap-3 rounded-lg border border-border bg-surface p-3 shadow-lg"
		>
			<Logo size="md" className="mt-0.5 shrink-0" />
			<div className="min-w-0 flex-1">
				<p className="text-[13px] font-semibold text-text-1">Install Hezo</p>
				{platform === 'android' ? (
					<p className="mt-0.5 text-[12.5px] text-text-2">
						Add Hezo to your home screen for a faster, full-screen experience.
					</p>
				) : (
					<p className="mt-0.5 text-[12.5px] text-text-2">
						Tap the Share
						<Share className="mx-1 inline-block h-3.5 w-3.5 align-text-bottom" aria-hidden />
						icon, then <span className="font-medium text-text-1">Add to Home Screen</span>.
					</p>
				)}
				{platform === 'android' && (
					<div className="mt-2">
						<Button
							type="button"
							variant="accent"
							size="sm"
							data-testid="pwa-install-button"
							onClick={() => {
								void promptInstall();
							}}
						>
							Install
						</Button>
					</div>
				)}
			</div>
			<button
				type="button"
				onClick={dismiss}
				aria-label="Dismiss install prompt"
				data-testid="pwa-install-dismiss"
				className="shrink-0 text-text-2/70 hover:text-text-1"
			>
				<X className="h-4 w-4" />
			</button>
		</div>
	);
}

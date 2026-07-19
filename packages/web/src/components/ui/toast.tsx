import * as RadixToast from '@radix-ui/react-toast';
import { Loader2, WifiOff, X } from 'lucide-react';
import { useConnectionStatus } from '../../hooks/use-connection-status';
import { toast, useToasts } from '../../hooks/use-toast';

const ERROR_DURATION_MS = 6000;

const TOAST_TITLES = { error: 'Something went wrong', info: 'Heads up', success: 'Done' } as const;

export function Toaster() {
	const toasts = useToasts();
	const { offline, retry } = useConnectionStatus();

	return (
		<RadixToast.Provider swipeDirection="right" duration={ERROR_DURATION_MS}>
			{/* Persistent connection indicator, pinned above transient toasts. It is
			    controlled (open + no onOpenChange) and never auto-dismisses
			    (duration Infinity), so it stays until the socket heals; swipe is
			    suppressed so it can't be shoved off while still offline. */}
			{offline && (
				<RadixToast.Root
					open
					type="background"
					duration={Number.POSITIVE_INFINITY}
					onSwipeStart={(e) => e.preventDefault()}
					data-testid="connection-toast"
					className="border border-danger bg-surface text-text-1 rounded-md shadow-md px-3 py-2.5 flex items-start gap-3 data-[state=open]:animate-in data-[state=open]:slide-in-from-right-2 data-[state=closed]:animate-out data-[state=closed]:fade-out"
				>
					<WifiOff className="w-4 h-4 text-danger shrink-0 mt-0.5" aria-hidden="true" />
					<div className="flex-1 min-w-0">
						<RadixToast.Title className="text-[13px] font-medium mb-0.5 text-danger">
							Connection lost
						</RadixToast.Title>
						<RadixToast.Description className="text-[13px] text-text-2 break-words flex items-center gap-1.5">
							<Loader2 className="w-3 h-3 animate-spin shrink-0" aria-hidden="true" />
							Reconnecting…
						</RadixToast.Description>
						<button
							type="button"
							data-testid="connection-retry"
							onClick={() => retry?.()}
							className="mt-1 inline-block text-[13px] font-medium text-accent-soft-fg hover:underline"
						>
							Retry now
						</button>
					</div>
				</RadixToast.Root>
			)}
			{toasts.map((t) => (
				<RadixToast.Root
					key={t.id}
					onOpenChange={(open) => {
						if (!open) toast.dismiss(t.id);
					}}
					className={`border bg-surface text-text-1 rounded-md shadow-md px-3 py-2.5 flex items-start gap-3 data-[state=open]:animate-in data-[state=open]:slide-in-from-right-2 data-[state=closed]:animate-out data-[state=closed]:fade-out ${
						t.variant === 'error'
							? 'border-danger'
							: t.variant === 'success'
								? 'border-success'
								: 'border-border'
					}`}
				>
					<div className="flex-1 min-w-0">
						<RadixToast.Title
							className={`text-[13px] font-medium mb-0.5 ${
								t.variant === 'error'
									? 'text-danger'
									: t.variant === 'success'
										? 'text-success-soft-fg'
										: 'text-text-1'
							}`}
						>
							{TOAST_TITLES[t.variant]}
						</RadixToast.Title>
						<RadixToast.Description className="text-[13px] text-text-2 break-words">
							{t.message}
						</RadixToast.Description>
						{t.link && (
							// The Toaster mounts outside the RouterProvider, so SPA navigation
							// rides the caller-supplied onNavigate; the real href keeps
							// middle-click / copy-link working either way.
							<a
								href={t.link.href}
								data-testid="toast-link"
								className="mt-1 inline-block text-[13px] font-medium text-accent-soft-fg hover:underline"
								onClick={(e) => {
									if (t.link?.onNavigate && !e.metaKey && !e.ctrlKey && !e.shiftKey) {
										e.preventDefault();
										t.link.onNavigate();
									}
									toast.dismiss(t.id);
								}}
							>
								{t.link.label}
							</a>
						)}
					</div>
					<RadixToast.Close
						aria-label="Dismiss"
						className="text-text-3 hover:text-text-1 shrink-0 mt-0.5"
					>
						<X className="w-3.5 h-3.5" />
					</RadixToast.Close>
				</RadixToast.Root>
			))}
			{/* Top-right, offset below the 48px app header so it clears the header's
			    top-right action icons and the update banner. Top-right (not
			    bottom-right) keeps every toast clear of the CEO chat launcher, which
			    is pinned bottom-right. */}
			<RadixToast.Viewport className="fixed top-14 right-4 left-4 sm:left-auto sm:top-16 sm:right-6 z-50 flex flex-col gap-2 w-auto sm:w-80 max-w-full outline-none" />
		</RadixToast.Provider>
	);
}

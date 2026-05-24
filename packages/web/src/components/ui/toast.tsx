import * as RadixToast from '@radix-ui/react-toast';
import { X } from 'lucide-react';
import { toast, useToasts } from '../../hooks/use-toast';

const ERROR_DURATION_MS = 6000;

export function Toaster() {
	const toasts = useToasts();

	return (
		<RadixToast.Provider swipeDirection="right" duration={ERROR_DURATION_MS}>
			{toasts.map((t) => (
				<RadixToast.Root
					key={t.id}
					onOpenChange={(open) => {
						if (!open) toast.dismiss(t.id);
					}}
					className="border border-accent-red bg-bg-elevated text-text rounded-radius-md shadow-md px-3 py-2.5 flex items-start gap-3 data-[state=open]:animate-in data-[state=open]:slide-in-from-right-2 data-[state=closed]:animate-out data-[state=closed]:fade-out"
				>
					<div className="flex-1 min-w-0">
						<RadixToast.Title className="text-[13px] font-medium text-accent-red mb-0.5">
							Something went wrong
						</RadixToast.Title>
						<RadixToast.Description className="text-[13px] text-text-muted break-words">
							{t.message}
						</RadixToast.Description>
					</div>
					<RadixToast.Close
						aria-label="Dismiss"
						className="text-text-subtle hover:text-text shrink-0 mt-0.5"
					>
						<X className="w-3.5 h-3.5" />
					</RadixToast.Close>
				</RadixToast.Root>
			))}
			<RadixToast.Viewport className="fixed bottom-4 right-4 left-4 sm:left-auto sm:bottom-6 sm:right-6 z-50 flex flex-col gap-2 w-auto sm:w-80 max-w-full outline-none" />
		</RadixToast.Provider>
	);
}

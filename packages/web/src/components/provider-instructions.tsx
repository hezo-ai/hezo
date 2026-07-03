import type { ReactNode } from 'react';

/** One provider's "how to get your credential" walkthrough. */
export interface ProviderInstructionContent {
	title: string;
	steps: ReactNode[];
	footer: ReactNode;
}

/** External link used inside instruction steps (opens the provider console in a new tab). */
export function InstructionsLink({ href, children }: { href: string; children: ReactNode }) {
	return (
		<a
			href={href}
			target="_blank"
			rel="noopener noreferrer"
			className="text-info-soft-fg hover:underline"
		>
			{children}
		</a>
	);
}

/**
 * The gray, provider-specific instructions box rendered above a credential
 * input. Shared by the API-key and subscription flavours of the provider
 * connect form.
 */
export function InstructionsBox({ content }: { content: ProviderInstructionContent }) {
	return (
		<div className="rounded-md border border-border bg-surface-2 p-3 text-[13px] text-text-2">
			<p className="font-medium text-text-1 mb-2">{content.title}</p>
			<ol className="list-decimal pl-5 space-y-1">
				{content.steps.map((step, i) => (
					// biome-ignore lint/suspicious/noArrayIndexKey: instruction list is static
					<li key={i}>{step}</li>
				))}
			</ol>
			<p className="mt-2">{content.footer}</p>
		</div>
	);
}

import type { ReactNode } from 'react';

// Wire's `.hz-code`: inline mono chip on a surface-3 fill — used for secret
// placeholders (`__HEZO_SECRET_*__`), tool-call fragments, and IDs.
export function Code({ children, className = '' }: { children: ReactNode; className?: string }) {
	return (
		<code
			className={`rounded-sm bg-surface-3 px-1.5 py-0.5 font-mono text-[0.88em] text-text-1 ${className}`}
		>
			{children}
		</code>
	);
}

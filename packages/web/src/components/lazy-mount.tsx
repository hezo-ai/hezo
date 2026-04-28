import { type ReactNode, useEffect, useRef, useState } from 'react';

interface LazyMountProps {
	minHeight: number;
	rootMargin?: string;
	testId?: string;
	children: ReactNode;
}

export function LazyMount({
	minHeight,
	rootMargin = '400px 0px',
	testId,
	children,
}: LazyMountProps) {
	const ref = useRef<HTMLDivElement | null>(null);
	const [mounted, setMounted] = useState(
		() => typeof window === 'undefined' || typeof IntersectionObserver === 'undefined',
	);

	useEffect(() => {
		if (mounted) return;
		const node = ref.current;
		if (!node) return;
		const io = new IntersectionObserver(
			(entries) => {
				if (entries.some((e) => e.isIntersecting)) {
					setMounted(true);
					io.disconnect();
				}
			},
			{ rootMargin },
		);
		io.observe(node);
		return () => io.disconnect();
	}, [mounted, rootMargin]);

	return (
		<div
			ref={ref}
			data-testid={testId}
			data-lazy-mounted={mounted ? 'true' : 'false'}
			style={mounted ? undefined : { minHeight }}
		>
			{mounted ? children : null}
		</div>
	);
}

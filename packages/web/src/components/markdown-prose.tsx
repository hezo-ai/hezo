import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

const PROSE_CLASSES =
	'prose prose-sm max-w-none text-sm text-text [&_a]:text-accent-blue-text [&_h1]:text-text [&_h2]:text-text [&_h3]:text-text [&_h4]:text-text [&_strong]:text-text [&_code]:text-accent-blue-text [&_code]:bg-bg-muted [&_code]:px-1 [&_code]:py-0.5 [&_code]:rounded [&_pre]:bg-bg-muted [&_pre]:border [&_pre]:border-border [&_p:last-child]:mb-0 [&_p:first-child]:mt-0';

interface MarkdownProseProps {
	children: string;
	testId?: string;
	className?: string;
}

export function MarkdownProse({ children, testId, className }: MarkdownProseProps) {
	return (
		<div
			className={className ? `${PROSE_CLASSES} ${className}` : PROSE_CLASSES}
			data-testid={testId}
		>
			<Markdown remarkPlugins={[remarkGfm]}>{children}</Markdown>
		</div>
	);
}

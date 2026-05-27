import { ExternalLink } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Button } from '../ui/button';
import { SectionHeader } from './helpers';

export function SkillFileSection() {
	const [content, setContent] = useState<string | null>(null);
	const [showPreview, setShowPreview] = useState(false);

	useEffect(() => {
		if (showPreview && content === null) {
			fetch('/skill.md')
				.then((r) => r.text())
				.then(setContent)
				.catch(() => setContent('Failed to load skill file.'));
		}
	}, [showPreview, content]);

	return (
		<section>
			<SectionHeader title="Skill file" />
			<div className="flex gap-2 mb-2">
				<a
					href="/skill.md"
					target="_blank"
					rel="noopener noreferrer"
					className="inline-flex items-center gap-1 text-[13px] text-accent-blue-text hover:underline"
				>
					<ExternalLink className="w-3.5 h-3.5" /> Open /skill.md
				</a>
				<Button variant="secondary" size="sm" onClick={() => setShowPreview(!showPreview)}>
					{showPreview ? 'Hide' : 'Preview'}
				</Button>
			</div>
			{showPreview && content && (
				<pre className="text-xs bg-bg-subtle border border-border rounded-radius-md p-3 overflow-auto max-h-64 text-text-muted whitespace-pre-wrap">
					{content}
				</pre>
			)}
		</section>
	);
}

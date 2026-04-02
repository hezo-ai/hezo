import { createFileRoute, Link, useNavigate } from '@tanstack/react-router';
import { ArrowLeft, Loader2 } from 'lucide-react';
import { useState } from 'react';
import { Button } from '../../../../components/ui/button';
import { Input } from '../../../../components/ui/input';
import { Textarea } from '../../../../components/ui/textarea';
import { useCreateKbDoc } from '../../../../hooks/use-kb-docs';

function NewKbDocPage() {
	const { companyId } = Route.useParams();
	const createDoc = useCreateKbDoc(companyId);
	const navigate = useNavigate();
	const [title, setTitle] = useState('');
	const [content, setContent] = useState('');

	async function handleSubmit(e: React.FormEvent) {
		e.preventDefault();
		const result = await createDoc.mutateAsync({ title, content: content || undefined });
		navigate({ to: '/companies/$companyId/kb/$slug', params: { companyId, slug: result.slug } });
	}

	return (
		<div className="p-6 max-w-3xl">
			<Link
				to="/companies/$companyId/kb"
				params={{ companyId }}
				className="inline-flex items-center gap-1 text-sm text-text-muted hover:text-text mb-4"
			>
				<ArrowLeft className="w-3.5 h-3.5" /> Knowledge Base
			</Link>

			<h1 className="text-lg font-semibold mb-4">New Document</h1>

			<form onSubmit={handleSubmit} className="flex flex-col gap-4">
				<Input label="Title" value={title} onChange={(e) => setTitle(e.target.value)} required />
				<Textarea
					label="Content (Markdown)"
					value={content}
					onChange={(e) => setContent(e.target.value)}
					className="min-h-[300px] font-mono text-xs"
				/>
				{createDoc.error && (
					<p className="text-sm text-accent-red">
						{(createDoc.error as { message: string }).message}
					</p>
				)}
				<div className="flex justify-end gap-2">
					<Link to="/companies/$companyId/kb" params={{ companyId }}>
						<Button type="button" variant="ghost">
							Cancel
						</Button>
					</Link>
					<Button type="submit" disabled={!title.trim() || createDoc.isPending}>
						{createDoc.isPending && <Loader2 className="w-4 h-4 animate-spin" />}
						Create
					</Button>
				</div>
			</form>
		</div>
	);
}

export const Route = createFileRoute('/companies/$companyId/kb/new')({
	component: NewKbDocPage,
});

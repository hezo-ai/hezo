import { createFileRoute, Link, useNavigate } from '@tanstack/react-router';
import { ArrowLeft, Loader2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { Button } from '../../../../components/ui/button';
import { Input } from '../../../../components/ui/input';
import { Textarea } from '../../../../components/ui/textarea';
import { useKbDoc, useUpdateKbDoc } from '../../../../hooks/use-kb-docs';

function KbDocEditPage() {
	const { companyId, slug } = Route.useParams();
	const { data: doc, isLoading } = useKbDoc(companyId, slug);
	const updateDoc = useUpdateKbDoc(companyId, slug);
	const navigate = useNavigate();

	const [title, setTitle] = useState('');
	const [content, setContent] = useState('');

	useEffect(() => {
		if (doc) {
			setTitle(doc.title);
			setContent(doc.content ?? '');
		}
	}, [doc]);

	if (isLoading) return <div className="p-6 text-text-muted">Loading...</div>;

	async function handleSave(e: React.FormEvent) {
		e.preventDefault();
		await updateDoc.mutateAsync({ title, content });
		navigate({ to: '/companies/$companyId/kb/$slug', params: { companyId, slug } });
	}

	return (
		<div className="p-6 max-w-3xl">
			<Link
				to="/companies/$companyId/kb/$slug"
				params={{ companyId, slug }}
				className="inline-flex items-center gap-1 text-sm text-text-muted hover:text-text mb-4"
			>
				<ArrowLeft className="w-3.5 h-3.5" /> Back
			</Link>

			<h1 className="text-lg font-semibold mb-4">Edit Document</h1>

			<form onSubmit={handleSave} className="flex flex-col gap-4">
				<Input label="Title" value={title} onChange={(e) => setTitle(e.target.value)} required />
				<Textarea
					label="Content (Markdown)"
					value={content}
					onChange={(e) => setContent(e.target.value)}
					className="min-h-[400px] font-mono text-xs"
				/>
				<div className="flex justify-end gap-2">
					<Link to="/companies/$companyId/kb/$slug" params={{ companyId, slug }}>
						<Button type="button" variant="ghost">
							Cancel
						</Button>
					</Link>
					<Button type="submit" disabled={updateDoc.isPending}>
						{updateDoc.isPending && <Loader2 className="w-4 h-4 animate-spin" />}
						Save
					</Button>
				</div>
			</form>
		</div>
	);
}

export const Route = createFileRoute('/companies/$companyId/kb/$slug_/edit')({
	component: KbDocEditPage,
});

import * as Dialog from '@radix-ui/react-dialog';
import { createFileRoute, useNavigate } from '@tanstack/react-router';
import { ArrowLeft, Check, FileText, Loader2, Users, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { Badge } from '../../components/ui/badge';
import { Button } from '../../components/ui/button';
import { Input } from '../../components/ui/input';
import { useCreateCompany } from '../../hooks/use-companies';
import type { CompanyType } from '../../hooks/use-company-types';
import { useCompanyTypes } from '../../hooks/use-company-types';

function NewCompanyPage() {
	const [step, setStep] = useState<'template' | 'details'>('template');
	const [selectedTemplateId, setSelectedTemplateId] = useState<string | null>(null);
	const hasSetDefault = useRef(false);
	const { data: types, isLoading } = useCompanyTypes();

	useEffect(() => {
		if (types?.length && !hasSetDefault.current) {
			const startup = types.find((t) => t.name === 'Startup');
			if (startup) setSelectedTemplateId(startup.id);
			hasSetDefault.current = true;
		}
	}, [types]);

	const selectedTemplate = types?.find((t) => t.id === selectedTemplateId) ?? null;

	if (isLoading) {
		return <div className="p-8 text-text-muted">Loading...</div>;
	}

	return (
		<div className="max-w-[700px] mx-auto w-full px-8 py-8">
			{step === 'template' ? (
				<TemplateStep
					types={types ?? []}
					selectedTemplateId={selectedTemplateId}
					onSelect={setSelectedTemplateId}
					onNext={() => setStep('details')}
				/>
			) : (
				<DetailsStep template={selectedTemplate} onBack={() => setStep('template')} />
			)}
		</div>
	);
}

function TemplateStep({
	types,
	selectedTemplateId,
	onSelect,
	onNext,
}: {
	types: CompanyType[];
	selectedTemplateId: string | null;
	onSelect: (id: string | null) => void;
	onNext: () => void;
}) {
	const navigate = useNavigate();
	const [detailType, setDetailType] = useState<CompanyType | null>(null);

	return (
		<>
			<div className="flex items-center gap-3 mb-1">
				<button
					type="button"
					onClick={() => navigate({ to: '/companies' })}
					className="text-text-muted hover:text-text transition-colors"
				>
					<ArrowLeft className="w-5 h-5" />
				</button>
				<h1 className="text-[22px] font-medium">Choose a template</h1>
			</div>
			<p className="text-sm text-text-muted mb-6 ml-8">
				Select a template to pre-configure your team and knowledge base.
			</p>

			<div className="grid gap-3">
				{types.map((t) => (
					<TemplateCard
						key={t.id}
						type={t}
						selected={selectedTemplateId === t.id}
						onClick={() => onSelect(t.id)}
						onSeeMore={() => setDetailType(t)}
					/>
				))}
			</div>

			<div className="flex justify-end mt-6">
				<Button onClick={onNext}>Continue</Button>
			</div>

			<TemplateDetailModal type={detailType} onClose={() => setDetailType(null)} />
		</>
	);
}

function DetailsStep({ template, onBack }: { template: CompanyType | null; onBack: () => void }) {
	const [name, setName] = useState('');
	const [description, setDescription] = useState('');
	const createCompany = useCreateCompany();
	const navigate = useNavigate();

	async function handleSubmit(e: React.FormEvent) {
		e.preventDefault();
		const result = await createCompany.mutateAsync({
			name,
			description: description || undefined,
			template_id: template?.id ?? undefined,
		});
		navigate({
			to: '/companies/$companyId/projects',
			params: { companyId: result.slug },
			search: { create: true },
		});
	}

	return (
		<>
			<div className="flex items-center gap-3 mb-1">
				<button
					type="button"
					onClick={onBack}
					className="text-text-muted hover:text-text transition-colors"
				>
					<ArrowLeft className="w-5 h-5" />
				</button>
				<h1 className="text-[22px] font-medium">Company details</h1>
			</div>

			<div className="ml-8 mb-6 flex items-center gap-2 text-sm text-text-muted">
				<span>Template:</span>
				<Badge color={template ? 'blue' : 'neutral'}>{template?.name ?? 'None'}</Badge>
			</div>

			<form onSubmit={handleSubmit} className="flex flex-col gap-4 ml-8">
				<Input
					label="Name"
					value={name}
					onChange={(e) => setName(e.target.value)}
					required
					autoFocus
				/>
				<Input
					label="Description"
					value={description}
					onChange={(e) => setDescription(e.target.value)}
					placeholder="Optional"
				/>

				{createCompany.error && (
					<p className="text-sm text-accent-red">
						{(createCompany.error as { message: string }).message}
					</p>
				)}

				<div className="flex justify-end gap-2 mt-2">
					<Button type="button" variant="ghost" onClick={onBack}>
						Back
					</Button>
					<Button type="submit" disabled={!name.trim() || createCompany.isPending}>
						{createCompany.isPending && <Loader2 className="w-4 h-4 animate-spin" />}
						Create
					</Button>
				</div>
			</form>
		</>
	);
}

function TemplateCard({
	type,
	selected,
	onClick,
	onSeeMore,
}: {
	type: CompanyType;
	selected: boolean;
	onClick: () => void;
	onSeeMore: () => void;
}) {
	const agentCount = type.agent_types?.length ?? 0;
	const kbDocCount = type.kb_docs_config?.length ?? 0;
	const isBlank = agentCount === 0 && kbDocCount === 0;

	return (
		<button
			type="button"
			onClick={onClick}
			className={`relative flex flex-col gap-1 rounded-lg border p-4 text-left transition-colors cursor-pointer ${
				selected
					? 'border-accent-blue bg-accent-blue-bg/30'
					: 'border-border hover:border-border-hover'
			}`}
		>
			{selected && (
				<div className="absolute top-3 right-3 flex h-5 w-5 items-center justify-center rounded-full bg-accent-blue text-white">
					<Check className="h-3 w-3" />
				</div>
			)}
			<div className="flex items-center gap-2">
				<span className="text-sm font-medium">{type.name}</span>
				{type.source === 'marketplace' && <Badge color="purple">Marketplace</Badge>}
			</div>
			{type.description && <p className="text-xs text-text-muted pr-6">{type.description}</p>}
			<div className="flex items-center gap-2 mt-0.5">
				{agentCount > 0 && <Badge color="blue">{agentCount} agents</Badge>}
				{isBlank && <Badge color="neutral">Includes CEO + Coach</Badge>}
				{kbDocCount > 0 && <Badge color="green">{kbDocCount} docs</Badge>}
				<a
					href="#see-more"
					onClick={(e) => {
						e.preventDefault();
						e.stopPropagation();
						onSeeMore();
					}}
					className="text-xs text-accent-blue hover:underline cursor-pointer ml-1"
				>
					see more
				</a>
			</div>
		</button>
	);
}

function TemplateDetailModal({ type, onClose }: { type: CompanyType | null; onClose: () => void }) {
	if (!type) return null;

	const agents = type.agent_types ?? [];
	const kbDocs = type.kb_docs_config ?? [];

	return (
		<Dialog.Root open={!!type} onOpenChange={(open) => !open && onClose()}>
			<Dialog.Portal>
				<Dialog.Overlay className="fixed inset-0 bg-black/60 backdrop-blur-sm" />
				<Dialog.Content className="fixed top-1/2 left-1/2 -translate-x-1/2 -translate-y-1/2 w-full max-w-lg max-h-[80vh] overflow-y-auto rounded-xl border border-border bg-bg-elevated p-6 shadow-2xl">
					<div className="flex items-center justify-between mb-4">
						<Dialog.Title className="text-lg font-semibold">{type.name}</Dialog.Title>
						<Dialog.Close asChild>
							<button type="button" className="text-text-muted hover:text-text">
								<X className="w-4 h-4" />
							</button>
						</Dialog.Close>
					</div>

					{type.description && <p className="text-sm text-text-muted mb-5">{type.description}</p>}

					{agents.length > 0 && (
						<div className="mb-5">
							<div className="flex items-center gap-2 mb-3">
								<Users className="w-4 h-4 text-text-muted" />
								<h3 className="text-sm font-medium">
									Agents <span className="text-text-muted font-normal">({agents.length})</span>
								</h3>
							</div>
							<div className="flex flex-col gap-2">
								{agents.map((a) => (
									<div key={a.agent_type_id} className="rounded-md border border-border px-3 py-2">
										<div className="flex items-center gap-2">
											<span className="text-sm font-medium">{a.name}</span>
											{a.reports_to_slug && (
												<span className="text-xs text-text-muted">
													reports to {a.reports_to_slug}
												</span>
											)}
										</div>
										<p className="text-xs text-text-muted mt-0.5">{a.role_description}</p>
									</div>
								))}
							</div>
						</div>
					)}

					{kbDocs.length > 0 && (
						<div>
							<div className="flex items-center gap-2 mb-3">
								<FileText className="w-4 h-4 text-text-muted" />
								<h3 className="text-sm font-medium">
									Knowledge Base Docs{' '}
									<span className="text-text-muted font-normal">({kbDocs.length})</span>
								</h3>
							</div>
							<div className="flex flex-col gap-2">
								{kbDocs.map((d) => (
									<div key={d.slug} className="rounded-md border border-border px-3 py-2">
										<span className="text-sm font-medium">{d.title}</span>
									</div>
								))}
							</div>
						</div>
					)}

					{agents.length === 0 && kbDocs.length === 0 && (
						<div>
							<p className="text-sm text-text-muted mb-4">
								Every company includes the built-in CEO and Coach agents. No additional agents or
								documents will be created.
							</p>
							<div className="flex flex-col gap-2">
								<div className="rounded-md border border-border px-3 py-2">
									<span className="text-sm font-medium">CEO</span>
									<p className="text-xs text-text-muted mt-0.5">
										Translates company mission into actionable strategy, delegates work across
										leadership, and resolves disputes between agents.
									</p>
								</div>
								<div className="rounded-md border border-border px-3 py-2">
									<span className="text-sm font-medium">Coach</span>
									<p className="text-xs text-text-muted mt-0.5">
										Reviews completed tickets to extract lessons and improve agent system prompts
										over time.
									</p>
								</div>
							</div>
						</div>
					)}
				</Dialog.Content>
			</Dialog.Portal>
		</Dialog.Root>
	);
}

export const Route = createFileRoute('/companies/new')({
	component: NewCompanyPage,
});

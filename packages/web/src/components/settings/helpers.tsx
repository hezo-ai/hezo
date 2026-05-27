export function SectionHeader({ title, desc }: { title: string; desc?: string }) {
	return (
		<div className="mb-4">
			<h2 className="text-base font-medium">{title}</h2>
			{desc && <p className="text-[13px] text-text-muted mt-1">{desc}</p>}
		</div>
	);
}

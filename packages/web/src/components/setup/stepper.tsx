import { Check } from 'lucide-react';

export type StepStatus = 'complete' | 'current' | 'pending';

interface Step {
	label: string;
	status: StepStatus;
}

interface StepperProps {
	steps: Step[];
}

export function Stepper({ steps }: StepperProps) {
	return (
		<ol
			className="flex items-center justify-center gap-2 sm:gap-4 mb-6 sm:mb-10"
			data-testid="setup-stepper"
		>
			{steps.map((step, idx) => {
				const isLast = idx === steps.length - 1;
				return (
					<li key={step.label} className="flex items-center gap-2 sm:gap-4">
						<div className="flex items-center gap-2">
							<div
								className={[
									'w-7 h-7 rounded-full flex items-center justify-center text-[12px] font-semibold border',
									step.status === 'complete'
										? 'bg-primary text-primary-foreground border-primary'
										: step.status === 'current'
											? 'bg-accent-blue-bg text-accent-blue-text border-accent-blue-text'
											: 'bg-bg-elevated text-text-muted border-border',
								].join(' ')}
								data-testid={`stepper-circle-${idx + 1}`}
								data-status={step.status}
								aria-current={step.status === 'current' ? 'step' : undefined}
							>
								{step.status === 'complete' ? <Check className="w-3.5 h-3.5" /> : idx + 1}
							</div>
							<span
								className={[
									'text-[12px] sm:text-[13px] hidden sm:inline',
									step.status === 'pending' ? 'text-text-muted' : 'text-text',
								].join(' ')}
							>
								{step.label}
							</span>
						</div>
						{!isLast && <div className="w-6 sm:w-12 h-px bg-border" aria-hidden="true" />}
					</li>
				);
			})}
		</ol>
	);
}

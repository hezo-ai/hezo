import { type Project, useRemoveProjectIcon, useUploadProjectIcon } from '../hooks/use-projects';
import { IconUploadSection } from './icon-upload-section';
import { getInitials } from './ui/avatar';

/** The project's icon control: the shared image picker, wired to the project's icon routes. */
export function ProjectIconSection({ project }: { project: Project }) {
	const upload = useUploadProjectIcon(project.slug);
	const remove = useRemoveProjectIcon(project.slug);

	return (
		<IconUploadSection
			label="Project icon"
			helpText="Shown in the project rail. Square images work best; we crop to a square and resize to 512×512. Leave unset to show the project initials."
			initials={getInitials(project.name)}
			ownerName={project.name}
			currentIconUrl={project.icon_url}
			onUpload={(blob) => upload.mutateAsync(blob)}
			onRemove={() => remove.mutateAsync()}
			isUploading={upload.isPending}
			isRemoving={remove.isPending}
			testIdPrefix="project-icon"
		/>
	);
}

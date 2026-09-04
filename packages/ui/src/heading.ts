/**
 * Which heading element a component renders.
 *
 * A primitive cannot know how deep in a document it sits, and a level baked into
 * one produces an outline that skips or repeats a rank wherever the component is
 * nested differently. Each component keeps the level it shipped with as its
 * default, so a caller changes one only when the outline needs it.
 */
export type HeadingLevel = 1 | 2 | 3 | 4 | 5 | 6;

/** The tag name for a level, for a component that renders it dynamically. */
export function headingTag(level: HeadingLevel) {
	return `h${level}` as const;
}

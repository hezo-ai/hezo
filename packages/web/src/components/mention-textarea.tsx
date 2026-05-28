import { forwardRef, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { type MentionSearchResult, useMentionSearch } from '../hooks/use-mentions';
import { MentionPicker } from './mention-picker';
import { Textarea } from './ui/textarea';

type TextareaProps = React.ComponentProps<typeof Textarea>;

interface MentionTextareaProps extends TextareaProps {
	teamId?: string;
	projectSlug?: string;
	value: string;
	onChange: (e: React.ChangeEvent<HTMLTextAreaElement>) => void;
}

const TOKEN_RE = /@([a-z0-9][\w-]*)?$/i;

export const MentionTextarea = forwardRef<HTMLTextAreaElement, MentionTextareaProps>(
	function MentionTextarea(
		{ teamId, projectSlug, value, onChange, onKeyDown, onBlur, ...rest },
		forwardedRef,
	) {
		const textareaRef = useRef<HTMLTextAreaElement | null>(null);
		const setTextareaRef = useCallback(
			(el: HTMLTextAreaElement | null) => {
				textareaRef.current = el;
				if (typeof forwardedRef === 'function') forwardedRef(el);
				else if (forwardedRef) forwardedRef.current = el;
			},
			[forwardedRef],
		);
		const [open, setOpen] = useState(false);
		const [query, setQuery] = useState('');
		const [triggerStart, setTriggerStart] = useState<number | null>(null);
		const [highlightedIndex, setHighlightedIndex] = useState(0);
		const [debouncedQuery, setDebouncedQuery] = useState('');

		useEffect(() => {
			if (!open) return;
			const id = setTimeout(() => setDebouncedQuery(query), 150);
			return () => clearTimeout(id);
		}, [query, open]);

		const searchEnabled = Boolean(teamId) && open;
		const { data, isFetching } = useMentionSearch(teamId ?? '', debouncedQuery, {
			projectSlug,
			enabled: searchEnabled,
		});

		const results = useMemo<MentionSearchResult[]>(() => data ?? [], [data]);

		useEffect(() => {
			setHighlightedIndex(0);
		}, []);

		useEffect(() => {
			if (highlightedIndex >= results.length) setHighlightedIndex(0);
		}, [results, highlightedIndex]);

		const detectTrigger = useCallback((nextValue: string, caret: number) => {
			const upto = nextValue.slice(0, caret);
			const match = TOKEN_RE.exec(upto);
			if (!match) {
				setOpen(false);
				setTriggerStart(null);
				setQuery('');
				return;
			}
			const atIdx = match.index;
			const beforeAt = atIdx === 0 ? '' : upto[atIdx - 1];
			if (beforeAt && !/[\s([{>]/.test(beforeAt)) {
				setOpen(false);
				setTriggerStart(null);
				setQuery('');
				return;
			}
			setTriggerStart(atIdx);
			setQuery(match[1] ?? '');
			setOpen(true);
		}, []);

		const handleChange = useCallback(
			(e: React.ChangeEvent<HTMLTextAreaElement>) => {
				onChange(e);
				const target = e.target;
				detectTrigger(target.value, target.selectionStart ?? target.value.length);
			},
			[onChange, detectTrigger],
		);

		const handleSelect = useCallback(
			(result: MentionSearchResult) => {
				const el = textareaRef.current;
				if (!el || triggerStart === null) return;
				const caret = el.selectionStart ?? el.value.length;
				const before = value.slice(0, triggerStart);
				const after = value.slice(caret);
				const insertion = result.kind === 'agent' ? `@${result.handle} ` : `${result.handle} `;
				const next = `${before}${insertion}${after}`;
				const nextCaret = before.length + insertion.length;
				const synthetic = {
					target: { ...el, value: next },
					currentTarget: { ...el, value: next },
				} as unknown as React.ChangeEvent<HTMLTextAreaElement>;
				el.value = next;
				onChange(synthetic);
				setOpen(false);
				setTriggerStart(null);
				setQuery('');
				requestAnimationFrame(() => {
					el.focus();
					el.setSelectionRange(nextCaret, nextCaret);
				});
			},
			[onChange, triggerStart, value],
		);

		const handleKeyDown = useCallback(
			(e: React.KeyboardEvent<HTMLTextAreaElement>) => {
				if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) {
					if (open) {
						setOpen(false);
						setTriggerStart(null);
						setQuery('');
					}
					onKeyDown?.(e);
					return;
				}
				if (open && results.length > 0) {
					if (e.key === 'ArrowDown') {
						e.preventDefault();
						setHighlightedIndex((i) => (i + 1) % results.length);
						return;
					}
					if (e.key === 'ArrowUp') {
						e.preventDefault();
						setHighlightedIndex((i) => (i - 1 + results.length) % results.length);
						return;
					}
					if (e.key === 'Enter' || e.key === 'Tab') {
						e.preventDefault();
						handleSelect(results[highlightedIndex] ?? results[0]);
						return;
					}
				}
				if (e.key === 'Escape' && open) {
					e.preventDefault();
					setOpen(false);
					setTriggerStart(null);
					setQuery('');
					return;
				}
				onKeyDown?.(e);
			},
			[open, results, highlightedIndex, handleSelect, onKeyDown],
		);

		// Tracks the blur-close timer so we can cancel it on unmount. Without
		// this the timer fires after the component is gone — in happy-dom
		// teardown that throws "window is not defined" and breaks the test
		// scheduled right after.
		const blurTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
		useEffect(() => {
			return () => {
				if (blurTimerRef.current !== null) {
					clearTimeout(blurTimerRef.current);
					blurTimerRef.current = null;
				}
			};
		}, []);

		const handleBlur = useCallback(
			(e: React.FocusEvent<HTMLTextAreaElement>) => {
				if (blurTimerRef.current !== null) clearTimeout(blurTimerRef.current);
				blurTimerRef.current = setTimeout(() => {
					blurTimerRef.current = null;
					setOpen(false);
				}, 100);
				onBlur?.(e);
			},
			[onBlur],
		);

		return (
			<div className="relative">
				<Textarea
					{...rest}
					ref={setTextareaRef}
					value={value}
					onChange={handleChange}
					onKeyDown={handleKeyDown}
					onBlur={handleBlur}
				/>
				{open && teamId && (
					<MentionPicker
						query={query}
						results={results}
						loading={isFetching}
						highlightedIndex={highlightedIndex}
						onHoverIndex={setHighlightedIndex}
						onSelect={handleSelect}
					/>
				)}
			</div>
		);
	},
);

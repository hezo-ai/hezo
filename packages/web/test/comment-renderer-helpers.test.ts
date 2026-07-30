import { HeartbeatRunStatus } from '@hezo/shared';
import {
	AlertTriangle,
	ArrowRightLeft,
	Dot,
	FileText,
	Link2,
	Pencil,
	Terminal,
	UserRoundCog,
} from 'lucide-react';
import type React from 'react';
import { describe, expect, test } from 'vitest';
import type { CommentData } from '../src/components/comment-renderers/comment-data';
import {
	commentText,
	inlineEventIcon,
	isInlineEventType,
	jumpToComment,
	runStatusDotClass,
	runStatusLabel,
} from '../src/components/comment-renderers/helpers';

describe('commentText', () => {
	test('returns a plain string as-is', () => {
		expect(commentText('hello world')).toBe('hello world');
	});

	test('reads the .text field of a wrapped object', () => {
		expect(commentText({ text: 'wrapped body' })).toBe('wrapped body');
	});

	test('stringifies an object whose text is not a string', () => {
		// `{ text?: string }` shape but text missing → falls through to JSON.stringify.
		expect(commentText({} as { text?: string })).toBe('{}');
	});

	test('stringifies an object whose text is a non-string value', () => {
		// Force a non-string text to hit the JSON.stringify branch.
		const weird = { text: 42 } as unknown as { text?: string };
		expect(commentText(weird)).toBe('{"text":42}');
	});

	test('returns empty string for null / non-object, non-string content', () => {
		// `content && typeof === object` is false → final `return ''`.
		expect(commentText(null as unknown as string)).toBe('');
		expect(commentText(undefined as unknown as string)).toBe('');
	});
});

describe('runStatusLabel', () => {
	test('maps timed_out to "timed out"', () => {
		expect(runStatusLabel(HeartbeatRunStatus.TimedOut)).toBe('timed out');
	});

	test('returns the status verbatim for any other value', () => {
		expect(runStatusLabel(HeartbeatRunStatus.Running)).toBe('running');
		expect(runStatusLabel(HeartbeatRunStatus.Succeeded)).toBe('succeeded');
		expect(runStatusLabel('something_else')).toBe('something_else');
	});
});

describe('runStatusDotClass', () => {
	test('running → pulsing warning', () => {
		expect(runStatusDotClass(HeartbeatRunStatus.Running)).toBe('bg-warning animate-pulse');
	});

	test('queued → pulsing warning', () => {
		expect(runStatusDotClass(HeartbeatRunStatus.Queued)).toBe('bg-warning animate-pulse');
	});

	test('succeeded → success', () => {
		expect(runStatusDotClass(HeartbeatRunStatus.Succeeded)).toBe('bg-success');
	});

	test('failed → danger', () => {
		expect(runStatusDotClass(HeartbeatRunStatus.Failed)).toBe('bg-danger');
	});

	test('timed_out → danger', () => {
		expect(runStatusDotClass(HeartbeatRunStatus.TimedOut)).toBe('bg-danger');
	});

	test('cancelled / unknown → muted', () => {
		expect(runStatusDotClass(HeartbeatRunStatus.Cancelled)).toBe('bg-text-3');
		expect(runStatusDotClass('whatever')).toBe('bg-text-3');
	});
});

describe('jumpToComment', () => {
	test('prevents default, pushes the hash, and dispatches a hashchange', () => {
		let dispatched: Event | null = null;
		const listener = (e: Event) => {
			dispatched = e;
		};
		window.addEventListener('hashchange', listener);
		let prevented = false;
		const handler = jumpToComment('abc123');
		handler({
			preventDefault: () => {
				prevented = true;
			},
		} as unknown as React.MouseEvent);
		window.removeEventListener('hashchange', listener);

		expect(prevented).toBe(true);
		expect(window.location.hash).toBe('#comment-abc123');
		expect(dispatched).not.toBeNull();
		expect((dispatched as unknown as HashChangeEvent).type).toBe('hashchange');
	});
});

describe('isInlineEventType', () => {
	test('system and run are inline event types', () => {
		expect(isInlineEventType('system')).toBe(true);
		expect(isInlineEventType('run')).toBe(true);
	});

	test('text and other types are not', () => {
		expect(isInlineEventType('text')).toBe(false);
		expect(isInlineEventType('action')).toBe(false);
	});
});

describe('inlineEventIcon', () => {
	function base(partial: Partial<CommentData>): CommentData {
		return {
			id: 'c1',
			public_id: 'p1',
			created_at: '2026-01-01T00:00:00Z',
			...partial,
		} as CommentData;
	}

	test('run content type → Terminal icon', () => {
		expect(inlineEventIcon(base({ content_type: 'run', content: {} }))).toBe(Terminal);
	});

	test('system status_change → ArrowRightLeft', () => {
		expect(
			inlineEventIcon(base({ content_type: 'system', content: { kind: 'status_change' } })),
		).toBe(ArrowRightLeft);
	});

	test('system title_change → Pencil', () => {
		expect(
			inlineEventIcon(base({ content_type: 'system', content: { kind: 'title_change' } })),
		).toBe(Pencil);
	});

	test('system description_change → FileText', () => {
		expect(
			inlineEventIcon(base({ content_type: 'system', content: { kind: 'description_change' } })),
		).toBe(FileText);
	});

	test('system assignee_change → UserRoundCog', () => {
		expect(
			inlineEventIcon(base({ content_type: 'system', content: { kind: 'assignee_change' } })),
		).toBe(UserRoundCog);
	});

	test('system task_link → Link2', () => {
		expect(inlineEventIcon(base({ content_type: 'system', content: { kind: 'task_link' } }))).toBe(
			Link2,
		);
	});

	test('system run_failed → AlertTriangle', () => {
		expect(inlineEventIcon(base({ content_type: 'system', content: { kind: 'run_failed' } }))).toBe(
			AlertTriangle,
		);
	});

	test('system unknown kind → Dot fallback', () => {
		expect(
			inlineEventIcon(base({ content_type: 'system', content: { kind: 'run_terminated' } })),
		).toBe(Dot);
	});

	test('system with no content / undefined kind → Dot fallback', () => {
		expect(
			inlineEventIcon(
				base({ content_type: 'system', content: null } as unknown as Partial<CommentData>),
			),
		).toBe(Dot);
	});

	test('non-inline content type → Dot', () => {
		expect(inlineEventIcon(base({ content_type: 'text', content: 'hi' }))).toBe(Dot);
	});
});

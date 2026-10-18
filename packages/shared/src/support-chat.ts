/**
 * What the support chat tells the support team about where a person is.
 *
 * Each key is a Chatwoot **contact** attribute. The page sets them through the
 * widget; the inbox shows them beside the person's conversations only once an
 * admin has defined each key there, and this table is what that definition is
 * made from. Keys are prefixed because one Chatwoot account can serve more than
 * one product, and an attribute key is unique across the whole account.
 *
 * **On the contact, because a contact's attributes merge.** Chatwoot replaces a
 * conversation's attributes wholesale on every write, which would erase a
 * pre-chat answer or a value an agent set by hand; a contact's merge by key.
 *
 * **Every page sends every key**, with an empty value for what it does not know.
 * One person is one contact, whether they write from the marketing site, the
 * hosting dashboard or their instance, so a key one of them set and another
 * left out would go on describing a page the person has left. That is why the
 * hosted pages' keys live here too: the instance has to clear them.
 *
 * **Every value is a name the page chose, never text the person typed**, with
 * one exception: a project's slug is made from the name its owner gave it. A
 * screen is a named state or a route template, a page is an origin and a path
 * with no query or fragment.
 *
 * **Every value is also a claim.** The widget runs in the person's own page, so
 * anybody can set any of these from the browser console. They tell the team
 * where to look, not what is true.
 */

/** How the inbox draws a field: as plain text, as a clickable link, or as one of a fixed set. */
export type SupportChatFieldType = 'text' | 'link' | 'list';

export interface SupportChatField {
	/** The label the inbox shows. */
	name: string;
	type: SupportChatFieldType;
	/** What the field means, shown to whoever defines it in the inbox. */
	description: string;
	/** The allowed values of a `list` field. */
	values?: readonly string[];
}

/** The widths at which a page counts as a phone, a tablet or a desktop. */
export const SUPPORT_CHAT_VIEWPORTS = ['phone', 'tablet', 'desktop'] as const;
export type SupportChatViewport = (typeof SUPPORT_CHAT_VIEWPORTS)[number];

/** The narrowest tablet, in CSS pixels: where the web app brings back its rail. */
export const SUPPORT_CHAT_TABLET_MIN_WIDTH = 768;
/** The narrowest desktop, in CSS pixels: where the web app shows its full sidebar. */
export const SUPPORT_CHAT_DESKTOP_MIN_WIDTH = 1024;

export const SUPPORT_CHAT_THEMES = ['light', 'dark'] as const;

/** The fields any Hezo page can report. */
export const SUPPORT_CHAT_FIELDS = {
	hezo_surface: {
		name: 'Hezo surface',
		type: 'text',
		description: 'Which Hezo product the person is in: an instance, or a hosted page.',
	},
	hezo_page: {
		name: 'Hezo page',
		type: 'link',
		description: 'The page the person is on, without its query or fragment.',
	},
	hezo_screen: {
		name: 'Hezo screen',
		type: 'text',
		description: 'The screen the person is on: a named state, or a route template.',
	},
	hezo_language: {
		name: 'Hezo language',
		type: 'text',
		description: 'The language the page is shown in.',
	},
	hezo_theme: {
		name: 'Hezo theme',
		type: 'list',
		description: 'The colour scheme the page is shown in.',
		values: SUPPORT_CHAT_THEMES,
	},
	hezo_viewport: {
		name: 'Hezo viewport',
		type: 'list',
		description: 'How wide the window is: phone, tablet or desktop.',
		values: SUPPORT_CHAT_VIEWPORTS,
	},
	hezo_project: {
		name: 'Hezo project',
		type: 'text',
		description: 'The slug of the project the person is in, if any.',
	},
	hezo_version: {
		name: 'Hezo version',
		type: 'text',
		description: 'The Hezo release the person is running.',
	},
	hezo_visit: {
		name: 'Hezo visit',
		type: 'link',
		description:
			"The visitor's visit on the analytics server: the pages they opened, and the replay when the visit was recorded. Sent by a hosting provider's website.",
	},
	hezo_instance_status: {
		name: 'Hezo instance status',
		type: 'text',
		description:
			"The instance's status as its owner's hosting dashboard shows it, with why it is held or dormant.",
	},
	hezo_instance_job: {
		name: 'Hezo instance job',
		type: 'text',
		description:
			'The work on the instance that is running or last failed: its kind, state, step and attempt. Empty once it succeeded. Sent by a hosting dashboard.',
	},
	hezo_instance_error: {
		name: 'Hezo instance error',
		type: 'text',
		description: 'The last error the hosting dashboard shows for the instance or its job.',
	},
} as const satisfies Record<string, SupportChatField>;

export type SupportChatFieldKey = keyof typeof SUPPORT_CHAT_FIELDS;

/** Which of the three a window of this many CSS pixels counts as. */
export function supportChatViewport(width: number): SupportChatViewport {
	if (width >= SUPPORT_CHAT_DESKTOP_MIN_WIDTH) return 'desktop';
	if (width >= SUPPORT_CHAT_TABLET_MIN_WIDTH) return 'tablet';
	return 'phone';
}

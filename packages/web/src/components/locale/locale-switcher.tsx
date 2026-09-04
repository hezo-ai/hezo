import * as Dialog from '@radix-ui/react-dialog';
import { Languages } from 'lucide-react';
import { useState } from 'react';
import { useI18n } from '../../lib/i18n';
import { DialogContent } from '../ui/dialog';
import { LocaleEditor } from './locale-editor';

/**
 * The locale control on the **pre-auth surfaces only**: the onboarding wizard
 * and the logged-out gates (master-key setup, locked-instance unlock, password
 * login). Those screens carry no navigation, so without a control here an
 * operator who cannot read the UI would have nowhere to go.
 *
 * Once signed in the app has a Settings section, so this is deliberately not
 * rendered in the app header - the same editor lives at
 * Settings -> Languages & formats.
 */
export function LocaleSwitcher() {
	const { t } = useI18n();
	const [open, setOpen] = useState(false);

	return (
		<Dialog.Root open={open} onOpenChange={setOpen}>
			<Dialog.Trigger asChild>
				<button
					type="button"
					className="inline-flex items-center justify-center w-8 h-8 rounded-md text-text-2 hover:text-text-1 hover:bg-surface-3 transition-colors cursor-pointer"
					aria-label={t('locale.settings.title')}
					title={t('locale.settings.title')}
					data-testid="locale-switcher"
				>
					{/* The translate glyph (a latin "A" and a CJK character), not a globe:
					    a globe reads as "worldwide / global scope" - which is what it means
					    everywhere else in this app (global agents, the global HQ project) -
					    rather than "change the language". */}
					<Languages className="w-4 h-4" />
				</button>
			</Dialog.Trigger>
			{/* No Dialog.Description: the form's own labels and live previews say
			    everything a subtitle would, so Radix's describedby is opted out of
			    explicitly rather than left pointing at a missing node. */}
			<DialogContent size="md" data-testid="locale-dialog" aria-describedby={undefined}>
				<Dialog.Title className="text-base font-semibold text-text-1 mb-5 pr-8">
					{t('locale.settings.title')}
				</Dialog.Title>
				{/* Cancel is the editor's own button, not a `Dialog.Close` passed in:
				    it has to re-translate along with the rest of the card while a
				    language is being previewed, and this dialog is already controlled. */}
				<LocaleEditor
					submitLabelKey="locale.settings.save"
					onSaved={() => setOpen(false)}
					onCancel={() => setOpen(false)}
				/>
			</DialogContent>
		</Dialog.Root>
	);
}

/**
 * The locale control as it appears on the full-screen pre-auth gates, which
 * have no header to hang it off. Fixed to the top-right corner.
 */
export function GateLocaleSwitcher() {
	return (
		<div className="fixed right-3 top-3 z-50 sm:right-4 sm:top-4">
			<LocaleSwitcher />
		</div>
	);
}

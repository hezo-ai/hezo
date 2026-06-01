import { useEffect, useRef, useState } from 'react';

const MIN_HEIGHT = 300;

// Posts the document height to the parent on load and whenever the content
// resizes, so the parent can size the iframe to fit without an inner scrollbar.
const HEIGHT_REPORTER = `<script>
(function () {
  function report() {
    var h = Math.max(
      document.documentElement.scrollHeight,
      document.body ? document.body.scrollHeight : 0
    );
    parent.postMessage({ __hezoHtmlPreviewHeight: h }, '*');
  }
  window.addEventListener('load', report);
  if (window.ResizeObserver) {
    new ResizeObserver(report).observe(document.documentElement);
  }
  report();
})();
</script>`;

interface HtmlPreviewProps {
	html: string;
	title?: string;
	// When set, the frame fills the viewport (standalone preview) instead of
	// auto-sizing to its content within the document viewer.
	fill?: boolean;
}

export function HtmlPreview({ html, title = 'Document preview', fill = false }: HtmlPreviewProps) {
	const iframeRef = useRef<HTMLIFrameElement>(null);
	const [height, setHeight] = useState(MIN_HEIGHT);

	useEffect(() => {
		if (fill) return;
		function onMessage(e: MessageEvent) {
			if (e.source !== iframeRef.current?.contentWindow) return;
			const reported = (e.data as { __hezoHtmlPreviewHeight?: number })?.__hezoHtmlPreviewHeight;
			if (typeof reported === 'number' && Number.isFinite(reported)) {
				setHeight(Math.max(MIN_HEIGHT, Math.ceil(reported)));
			}
		}
		window.addEventListener('message', onMessage);
		return () => window.removeEventListener('message', onMessage);
	}, [fill]);

	return (
		<iframe
			ref={iframeRef}
			title={title}
			// Scripts run, but the opaque origin (no allow-same-origin) keeps the
			// frame from reaching the parent DOM, cookies, or storage.
			sandbox="allow-scripts"
			// The height reporter is only needed when auto-sizing to content.
			srcDoc={fill ? html : `${html}${HEIGHT_REPORTER}`}
			className={
				fill
					? 'w-full h-screen bg-white border-0'
					: 'w-full bg-white rounded-radius-md border border-border'
			}
			style={fill ? undefined : { height, maxHeight: '80vh' }}
		/>
	);
}

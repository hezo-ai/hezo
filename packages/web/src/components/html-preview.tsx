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
}

export function HtmlPreview({ html, title = 'Document preview' }: HtmlPreviewProps) {
	const iframeRef = useRef<HTMLIFrameElement>(null);
	const [height, setHeight] = useState(MIN_HEIGHT);

	useEffect(() => {
		function onMessage(e: MessageEvent) {
			if (e.source !== iframeRef.current?.contentWindow) return;
			const reported = (e.data as { __hezoHtmlPreviewHeight?: number })?.__hezoHtmlPreviewHeight;
			if (typeof reported === 'number' && Number.isFinite(reported)) {
				setHeight(Math.max(MIN_HEIGHT, Math.ceil(reported)));
			}
		}
		window.addEventListener('message', onMessage);
		return () => window.removeEventListener('message', onMessage);
	}, []);

	return (
		<iframe
			ref={iframeRef}
			title={title}
			// Scripts run, but the opaque origin (no allow-same-origin) keeps the
			// frame from reaching the parent DOM, cookies, or storage.
			sandbox="allow-scripts"
			srcDoc={`${html}${HEIGHT_REPORTER}`}
			className="w-full bg-white rounded-radius-md border border-border"
			style={{ height, maxHeight: '80vh' }}
		/>
	);
}

// Copy-to-clipboard affordances for shareable links.
//
// The clipboard API needs a secure context (https, or localhost) and
// can be blocked by permissions policy, so every path falls back to a
// hidden textarea + execCommand. If BOTH fail we say so rather than
// flashing a lying "Copied!" — the URL stays selectable so the tenant
// can copy it by hand.

import { useCallback, useEffect, useRef, useState } from 'react';
import { Check, Copy, ExternalLink } from 'lucide-react';
import { Button } from './ui/index.js';
import { displayUrl } from '../lib/bookingLinks.js';

export async function copyText(value) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(value);
      return true;
    }
  } catch {
    // Insecure context or denied permission — try the legacy path.
  }
  try {
    const ta = document.createElement('textarea');
    ta.value = value;
    ta.setAttribute('readonly', '');
    // Off-screen but focusable; position:fixed avoids scrolling the page.
    ta.style.position = 'fixed';
    ta.style.top = '0';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

// Copy state with an auto-reset. The timer is cleared on unmount so a
// row that disappears mid-flash (catalog reload) can't setState after.
export function useCopy(value, resetMs = 2000) {
  const [state, setState] = useState('idle'); // idle | copied | failed
  const timer = useRef(null);

  useEffect(() => () => clearTimeout(timer.current), []);

  const copy = useCallback(async () => {
    const ok = await copyText(value);
    setState(ok ? 'copied' : 'failed');
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setState('idle'), resetMs);
  }, [value, resetMs]);

  return { state, copy };
}

// Compact button for table rows — icon + label, flips to a check.
export function CopyButton({
  value,
  label = 'Copy link',
  size = 'sm',
  variant = 'secondary',
  title,
}) {
  const { state, copy } = useCopy(value);
  return (
    <Button
      size={size}
      variant={variant}
      onClick={copy}
      title={title ?? value}
      aria-live="polite"
    >
      {state === 'copied' ? (
        <>
          <Check className="h-3.5 w-3.5" /> Copied
        </>
      ) : state === 'failed' ? (
        'Press ⌘C'
      ) : (
        <>
          <Copy className="h-3.5 w-3.5" /> {label}
        </>
      )}
    </Button>
  );
}

// Full-width row: the URL in a selectable mono box, Copy, and Open.
// `openInNewTab` is a real anchor (not a router Link) because the
// booking page is a separate public surface — and on bare-localhost
// dev a full load would drop the ?tenant= param anyway, which is
// exactly the trip we want the tenant to take deliberately.
export function ShareLinkField({ url, openLabel = 'Open' }) {
  const { state, copy } = useCopy(url);
  return (
    <div>
      <div className="flex flex-wrap items-center gap-2">
        <code className="min-w-0 flex-1 select-all truncate rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 font-mono text-xs text-slate-700">
          {displayUrl(url)}
        </code>
        <Button variant="secondary" onClick={copy} aria-live="polite">
          {state === 'copied' ? (
            <>
              <Check className="h-4 w-4" /> Copied
            </>
          ) : (
            <>
              <Copy className="h-4 w-4" /> Copy
            </>
          )}
        </Button>
        <Button
          as="a"
          href={url}
          target="_blank"
          rel="noreferrer"
          variant="secondary"
        >
          <ExternalLink className="h-4 w-4" /> {openLabel}
        </Button>
      </div>
      {state === 'failed' && (
        <p className="mt-2 text-xs text-amber-600">
          Couldn't reach the clipboard — select the address above and copy
          it manually.
        </p>
      )}
    </div>
  );
}

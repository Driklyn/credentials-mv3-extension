/**
 * Credentials content script — the page-side half: an Open button and a closed-shadow-root host.
 *
 * Trust position: the page owns this script's *document* but not its *code*. Everything the UI needs
 * lives inside a `closed` shadow root, so page scripts cannot reach the iframe element, read its
 * attributes, or overwrite the button. The host element is the only page-visible artifact, and by
 * contract it has no `shadowRoot` to hand out.
 *
 * What this file must never do: read `chrome.storage`, receive a credential, or learn an origin. It
 * asks the service worker for a nonce, puts the nonce in the iframe fragment, and forgets it.
 */
import { OPEN_BUTTON_ID, type Result, type WireMessage } from '../shared/protocol';

// ---------------------------------------------------------------------------------------------
// Guards. Both run before anything touches the DOM, so a hostile or redundant context exits here.
// ---------------------------------------------------------------------------------------------

// Only the top-level document hosts the button. `all_frames: false` in the manifest already prevents
// injection into subframes; this makes the guarantee independent of manifest drift.
if (window.top !== window) {
  // Not a top-level browsing context: stand down.
} else if (!/^https?:$/.test(location.protocol)) {
  // `about:blank`, `chrome-extension:`, `file:` etc. never get UI.
} else {
  mount();
}

/**
 * Ask the service worker for a fresh nonce.
 *
 * The reply is untrusted JSON from another context, so it is narrowed rather than assumed. A dead
 * service worker *rejects* the promise; that is treated identically to a refusal, because the only
 * correct response to "no authority" is to show no form.
 */
async function issueNonce(): Promise<Result<{ nonce: string }>> {
  const message: WireMessage = { type: 'TOKEN_ISSUE' };
  try {
    const reply: unknown = await chrome.runtime.sendMessage(message);
    return narrowReply(reply);
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : 'Extension unreachable' };
  }
}

/** Narrow an unknown reply to the shape the service worker promises. */
function narrowReply(reply: unknown): Result<{ nonce: string }> {
  if (typeof reply !== 'object' || reply === null) {
    return { ok: false, error: 'No reply from the extension' };
  }

  const candidate = reply as { ok?: unknown; value?: unknown; error?: unknown };
  if (candidate.ok === true) {
    const value = candidate.value as { nonce?: unknown } | null | undefined;
    if (typeof value?.nonce === 'string' && value.nonce.length > 0) {
      return { ok: true, value: { nonce: value.nonce } };
    }
    return { ok: false, error: 'Malformed reply from the extension' };
  }

  return { ok: false, error: typeof candidate.error === 'string' ? candidate.error : 'Request refused' };
}


/**
 * Build the shadow-DOM UI and attach it to the page.
 *
 * Kept in one function so the whole surface is auditable at a glance: one host, one style block, one
 * button, one iframe slot, one close control.
 */
function mount(): void {
  // Double-mount guard: a re-injected script finds the element and leaves it alone. `getElementById`
  // works on a closed-shadow *host* because the host itself is an ordinary light-DOM node.
  if (document.getElementById(OPEN_BUTTON_ID) !== null) return;

  const host = document.createElement('div');
  host.id = OPEN_BUTTON_ID;
  // `all: initial` first, then each layout property re-declared with `!important`, so page rules
  // (e.g. `#credentials-open-host { display: none }` or a wildcard `* { all: unset }`) cannot falsify the
  // overlay. The host carries no text and no children in the light DOM.
  host.style.setProperty('all', 'initial', 'important');
  host.style.setProperty('position', 'fixed', 'important');
  host.style.setProperty('top', '12px', 'important');
  host.style.setProperty('right', '12px', 'important');
  host.style.setProperty('z-index', '2147483647', 'important');

  // `closed`: the returned root is the only reference, and it never leaves this function's scope.
  // A page script calling `host.shadowRoot` gets `null` — validation matrix row 4.
  const root = host.attachShadow({ mode: 'closed' });

  const style = document.createElement('style');
  style.textContent = `
    :host { all: initial; }
    .bar {
      display: flex;
      justify-content: flex-end;
      gap: 8px;
      font: 600 13px/1.2 system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    }
    button {
      font: inherit;
      cursor: pointer;
      border-radius: 6px;
      border: 1px solid #1f2933;
      background: #1f2933;
      color: #ffffff;
      padding: 7px 14px;
      box-shadow: 0 2px 6px rgba(0, 0, 0, 0.25);
    }
    button:hover { background: #323f4b; }
    button:focus-visible { outline: 2px solid #2f80ed; outline-offset: 2px; }
    button[data-state="error"] {
      background: #a4161a;
      border-color: #a4161a;
      cursor: default;
      font-weight: 500;
    }
    .panel {
      position: fixed;
      top: 52px;
      right: 12px;
      width: 340px;
      height: 220px;
      display: none;
      border-radius: 8px;
      overflow: hidden;
      background: #ffffff;
      box-shadow: 0 10px 30px rgba(0, 0, 0, 0.35);
    }
    .panel[data-open="true"] { display: block; }
    iframe {
      width: 100%;
      height: 100%;
      border: 0;
      display: block;
      background: #ffffff;
    }
  `;

  const bar = document.createElement('div');
  bar.className = 'bar';

  const openButton = document.createElement('button');
  openButton.type = 'button';
  openButton.textContent = 'Open';
  openButton.dataset['state'] = 'idle';

  const closeButton = document.createElement('button');
  closeButton.type = 'button';
  closeButton.textContent = '✕';
  closeButton.title = 'Close Credentials';
  // Nothing to close until a panel exists.
  closeButton.hidden = true;

  bar.append(openButton, closeButton);

  // The iframe slot. It stays empty while hidden; the iframe node itself is created and destroyed per
  // open, so no dormant frame ever holds credentials.
  const panel = document.createElement('div');
  panel.className = 'panel';
  panel.dataset['open'] = 'false';

  root.append(style, bar, panel);

  /**
   * Tear the panel down: drop the iframe node (and therefore its document and its spent nonce).
   *
   * The next open builds a brand new iframe with a brand new nonce, because reusing a stale frame
   * would mean reusing a stale capability.
   */
  function closePanel(): void {
    panel.replaceChildren();
    panel.dataset['open'] = 'false';
    closeButton.hidden = true;
    openButton.dataset['state'] = 'idle';
    openButton.textContent = 'Open';
    openButton.title = '';
  }

  /** Render a refusal on the button itself, so no separate error surface is needed. */
  function showError(message: string): void {
    openButton.dataset['state'] = 'error';
    openButton.textContent = message;
    openButton.title = message;
  }

  /** Open the form for a freshly issued nonce. The nonce travels in the fragment, never the query. */
  function showPanel(nonce: string): void {
    const iframe = document.createElement('iframe');
    // `#` fragment: same-document, never sent to a server, and scrubbed by the form on load.
    iframe.src = `${chrome.runtime.getURL('form.html')}#${nonce}`;
    // `allow=""`: no permission policy is delegated (no camera, geolocation, ...).
    // No `sandbox` attribute on purpose — an extension-origin document needs direct `chrome.runtime`
    // access, and a sandboxed frame would get an opaque origin and lose it.
    iframe.setAttribute('allow', '');
    iframe.title = 'Credentials form';

    panel.replaceChildren(iframe);
    panel.dataset['open'] = 'true';
    closeButton.hidden = false;

    openButton.dataset['state'] = 'idle';
    openButton.textContent = 'Open';
    openButton.title = '';
  }

  openButton.addEventListener('click', () => {
    // Clicking Open while a panel is up destroys it first, so one click can never leave two frames
    // alive against one origin.
    closePanel();

    void issueNonce().then((result) => {
      if (result.ok) {
        showPanel(result.value.nonce);
      } else {
        showError(result.error);
      }
    });
  });

  closeButton.addEventListener('click', closePanel);

  // Escape closes the form. Key events inside the cross-origin iframe do not bubble out to the page's
  // document, so this listener is a best-effort path; the ✕ control is the guaranteed one.
  root.addEventListener('keydown', (event: Event) => {
    if ((event as KeyboardEvent).key === 'Escape') closePanel();
  });

  (document.body ?? document.documentElement).append(host);
}

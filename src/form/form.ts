/**
 * Credentials form document — the *only* plaintext UI in the extension.
 *
 * Trust position: this document runs on the extension origin, in an iframe the content script created
 * inside a closed shadow root. The page cannot reach it. Its job is narrow:
 *
 *   1. take the nonce out of the fragment and scrub it from the URL immediately,
 *   2. trade the nonce for `{origin, username, password, saveNonce}` via `TOKEN_GET`,
 *   3. show the bound origin, prefill the fields, and let the user write with `saveNonce`.
 *
 * What this file must never use: `localStorage`, `sessionStorage`, `document.cookie`, `postMessage`,
 * or `window.name`. The nonce is held in a module-scoped variable and nowhere else; the credential
 * plaintext exists in exactly two `<input>` values and one outgoing `SAVE` payload.
 */
import { MAX_FIELD_LEN, type Origin, type Result, type WireMessage } from '../shared/protocol';

/** Reply shape of `TOKEN_GET`, as promised by `src/background/service-worker.ts`. */
interface GetReply {
  readonly origin: Origin;
  readonly username: string;
  readonly password: string;
  readonly saveNonce: string;
}

/** Required elements, resolved once. Missing markup is a programming error, not a runtime state. */
function required<T extends Element>(selector: string): T {
  const element = document.querySelector<T>(selector);
  if (element === null) throw new Error(`Credentials: missing element ${selector}`);
  return element;
}

const form = required<HTMLFormElement>('#credential-form');
const usernameInput = required<HTMLInputElement>('#username');
const passwordInput = required<HTMLInputElement>('#password');
const submitButton = required<HTMLButtonElement>('#submit');
const siteLine = required<HTMLElement>('#site');
const statusLine = required<HTMLElement>('#status');

/** The write capability, held in memory only and replaced by nothing: it is single-use. */
let saveNonce: string | null = null;

/** True once the session is dead; every handler checks it and every control is disabled. */
let expired = false;

/** Announcement for screen readers and sighted users alike, with a colour tone for the latter. */
function setStatus(message: string, tone: 'idle' | 'ok' | 'error' = 'idle'): void {
  statusLine.textContent = message;
  statusLine.dataset['tone'] = tone;
}

/** Disable every control. Used for "expired" and while a save is in flight. */
function setControlsEnabled(enabled: boolean): void {
  usernameInput.disabled = !enabled;
  passwordInput.disabled = !enabled;
  submitButton.disabled = !enabled;
}

/**
 * Terminal state: the nonce was refused, expired, or the extension is unreachable.
 *
 * The form stays visible (so the user knows what happened) but inert, and there is deliberately no
 * way to re-arm it in place — a new session requires a new click on the page, which is what mints a
 * new nonce. Auto-retrying would paper over a tampering signal.
 */
function failClosed(message: string): void {
  expired = true;
  saveNonce = null;
  setControlsEnabled(false);
  document.body.dataset['expired'] = 'true';
  setStatus(message, 'error');
}

/** Narrow an unknown `TOKEN_GET` reply to {@link GetReply}. */
function narrowGetReply(reply: unknown): Result<GetReply> {
  if (typeof reply !== 'object' || reply === null) {
    return { ok: false, error: 'No reply from the extension' };
  }

  const candidate = reply as { ok?: unknown; value?: unknown; error?: unknown };
  if (candidate.ok !== true) {
    return { ok: false, error: typeof candidate.error === 'string' ? candidate.error : 'Request refused' };
  }

  const value = candidate.value as Partial<Record<keyof GetReply, unknown>> | null | undefined;
  if (
    typeof value?.origin !== 'string' ||
    typeof value.username !== 'string' ||
    typeof value.password !== 'string' ||
    typeof value.saveNonce !== 'string'
  ) {
    return { ok: false, error: 'Malformed reply from the extension' };
  }

  return {
    ok: true,
    value: {
      origin: value.origin,
      username: value.username,
      password: value.password,
      saveNonce: value.saveNonce,
    },
  };
}

/** Ask the service worker to trade the redeem nonce for the bound origin, prefill and a save nonce. */
async function beginSession(nonce: string): Promise<void> {
  const message: WireMessage = { type: 'TOKEN_GET', nonce };

  let reply: unknown;
  try {
    reply = await chrome.runtime.sendMessage(message);
  } catch {
    // A dead service worker rejects the promise; that is a refusal like any other.
    failClosed('Session expired — reopen from the page');
    return;
  }

  const result = narrowGetReply(reply);
  if (!result.ok) {
    failClosed(result.error);
    return;
  }

  const { origin, username, password } = result.value;
  // Assigned as text, never as markup: `textContent` cannot be re-parsed as HTML.
  siteLine.textContent = origin;
  usernameInput.value = username;
  passwordInput.value = password;
  saveNonce = result.value.saveNonce;

  setControlsEnabled(true);
  setStatus(username.length > 0 || password.length > 0 ? 'Saved pair loaded' : 'No saved pair yet');
  usernameInput.focus();
}

/** Persist the current field values under the origin bound to `saveNonce`. */
async function save(): Promise<void> {
  if (expired || saveNonce === null) {
    failClosed('Session expired — reopen from the page');
    return;
  }

  const username = usernameInput.value;
  const password = passwordInput.value;

  // Client-side mirror of the service worker's own check. The SW validates again and is the
  // authority; this only avoids a pointless round trip and a vaguer error message.
  if (username.length > MAX_FIELD_LEN || password.length > MAX_FIELD_LEN) {
    setStatus(`Each field must be at most ${MAX_FIELD_LEN} characters`, 'error');
    return;
  }

  const nonce = saveNonce;
  setControlsEnabled(false);
  setStatus('Saving…');

  const message: WireMessage = { type: 'SAVE', nonce, username, password };

  let reply: unknown;
  try {
    reply = await chrome.runtime.sendMessage(message);
  } catch {
    // The nonce may or may not have been consumed before the worker died. Either way it cannot be
    // trusted again, so the session ends rather than retrying a write with an unknown outcome.
    saveNonce = null;
    failClosed('Session expired — reopen from the page');
    return;
  }

  const candidate = reply as { ok?: unknown; error?: unknown } | null;
  if (candidate === null || candidate.ok !== true) {
    saveNonce = null;
    failClosed(
      typeof candidate?.error === 'string' ? candidate.error : 'Save failed — reopen from the page',
    );
    return;
  }

  // The save nonce was spent by this write. A second Submit would be refused by the SW anyway; nulling
  // it here makes that refusal local, immediate and unambiguous. Re-arming requires a fresh click on
  // the page, which is the only thing that can mint a nonce.
  saveNonce = null;
  setControlsEnabled(false);
  setStatus('Saved ✓ — reopen from the page to save again', 'ok');
}

form.addEventListener('submit', (event) => {
  // `novalidate` plus a prevented default: nothing is ever "submitted" as a navigation. The document
  // has no `action`, and the CSP's `form-action 'none'` forbids form navigation outright.
  event.preventDefault();
  void save();
});

/**
 * Bootstrap.
 *
 * The nonce arrives as a fragment identifier, which is never sent to a server and never appears in a
 * `Referer`. It is read once, then `replaceState` rewrites the history entry so the nonce is gone from
 * `location`, the address bar, and anything that later reads the URL. `replaceState` (not
 * `pushState`) leaves no back-entry containing it.
 */
function bootstrap(): void {
  setStatus('Connecting…');

  const hasFragment = location.hash.length > 0;
  const fragment = location.hash.startsWith('#') ? location.hash.slice(1) : '';
  if (hasFragment) {
    history.replaceState(null, '', location.pathname);
  }

  if (fragment.length === 0) {
    // Opened directly (e.g. a top-level visit to `chrome-extension://<id>/assets/form.html`), or the
    // content script attached no nonce. Nothing to redeem, so nothing is shown or asked for.
    failClosed('No session — open Credentials from the page');
    return;
  }

  void beginSession(fragment);
}

bootstrap();


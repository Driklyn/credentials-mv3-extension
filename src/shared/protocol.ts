/**
 * Credentials wire protocol — pure values and pure types only.
 *
 * CRITICAL: this module is bundled twice, into an IIFE (content script) and into ES modules (form
 * document + service worker). It must therefore evaluate no side effects at import time, touch no
 * Chrome API, and import nothing. Origin binding lives here and nowhere else: `originOf` is the one
 * function in the extension allowed to decide what "the site the user is visiting" means.
 */

/** Storage key holding the whole vault. Versioned so a future schema change can be told apart. */
export const STORAGE_KEY = 'v1';

/** How long an issued nonce stays redeemable. Short on purpose: a nonce is a bearer capability. */
export const TOKEN_TTL_MS = 60 * 1000;

/** Maximum accepted length of a username or password, enforced on both sides of the wire. */
export const MAX_FIELD_LEN = 512;

/** DOM id of the closed-shadow-root host, used as the content script's double-mount guard. */
export const OPEN_BUTTON_ID = 'credentials-open-host';

/** A normalised web origin, e.g. `https://example.com`. Produced only by {@link originOf}. */
export type Origin = string;

/** The single plaintext credential pair for one origin. */
export interface CredentialPair {
  readonly username: string;
  readonly password: string;
}

/** On-disk shape. Plaintext by design: `chrome.storage.local` stands in for a credential API. */
export interface StoredVault {
  readonly [origin: Origin]: CredentialPair & { readonly updatedAt: number };
}

/** In-memory, single-use capability bound to one tab and one origin. Never persisted. */
export interface TokenRecord {
  readonly tabId: number;
  readonly origin: Origin;
  readonly expiresAt: number;
}

/** Uniform reply envelope: every handler answers with one of these, never a bare value. */
export type Result<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly error: string };

/**
 * The complete message vocabulary.
 *
 * No message carries an origin or a tab id. The service worker derives both from the sender, so a
 * hostile page has nothing in the payload it could rewrite to retarget a lookup.
 */
export type WireMessage =
  /** Content script → SW. Ask for a redeem nonce for the sender's own tab/origin. */
  | { readonly type: 'TOKEN_ISSUE' }
  /**
   * Form → SW. Consume the redeem nonce exactly once, returning the pair for the bound origin.
   * Kept in the union for completeness; the form uses TOKEN_GET so it can prefill and still save.
   */
  | { readonly type: 'TOKEN_REDEEM'; readonly nonce: string }
  /**
   * Form → SW. Consume the redeem nonce, reply `{origin, username, password, saveNonce}`: the
   * origin proves binding, the pair is the prefill, and `saveNonce` is a *second* single-use
   * capability so that prefetching does not spend the write authority.
   */
  | { readonly type: 'TOKEN_GET'; readonly nonce: string }
  /** Form → SW. Consume a save nonce and persist the pair under the origin bound to it. */
  | { readonly type: 'SAVE'; readonly nonce: string; readonly username: string; readonly password: string };

/**
 * The single place an origin is derived from a URL.
 *
 * Accepts only absolute `http:`/`https:` URLs and returns the serialised origin (`scheme://host:port`,
 * with default ports elided). Everything else — `chrome-extension:`, `about:blank`, `data:`, `blob:`,
 * `file:`, `javascript:`, opaque/sandboxed origins, malformed strings, `undefined` — yields `null`,
 * which every caller treats as a hard refusal.
 */
export function originOf(url: string | undefined): Origin | null {
  if (typeof url !== 'string' || url.length === 0) return null;

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
  if (parsed.origin === 'null') return null;

  return parsed.origin;
}

/** True when `value` is usable as a credential field: a string within {@link MAX_FIELD_LEN}. */
export function isValidField(value: unknown): value is string {
  return typeof value === 'string' && value.length <= MAX_FIELD_LEN;
}

/** True when `value` is shaped like a non-empty {@link WireMessage} with a known `type`. */
export function isWireMessage(value: unknown): value is WireMessage {
  if (typeof value !== 'object' || value === null) return false;
  const type = (value as { type?: unknown }).type;
  return type === 'TOKEN_ISSUE' || type === 'TOKEN_REDEEM' || type === 'TOKEN_GET' || type === 'SAVE';
}

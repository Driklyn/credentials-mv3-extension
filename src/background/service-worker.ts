/**
 * Credentials service worker — the token authority and the only writer of the credential store.
 *
 * Trust position: the SW trusts nothing that arrives in a message payload. Origin and tab id are
 * read exclusively from `sender` at mint time, and a nonce is single-use, tab-bound, origin-bound and
 * short-lived. This file is the *only* place `chrome.storage.local` is touched (see README).
 */
import {
  MAX_FIELD_LEN,
  STORAGE_KEY,
  TOKEN_TTL_MS,
  isValidField,
  isWireMessage,
  originOf,
  type Origin,
  type Result,
  type StoredVault,
  type TokenRecord,
} from '../shared/protocol';

/**
 * Outstanding capabilities, in memory only.
 *
 * A service-worker restart drops this map, so every previously issued nonce becomes worthless and
 * the form must be re-opened from the page. That is deliberate: losing state must fail closed.
 */
const pending = new Map<string, TokenRecord>();

/** Drop every capability whose TTL has elapsed. Called on each issue, so no timers are needed. */
function sweepExpired(now: number): void {
  for (const [nonce, record] of pending) {
    if (record.expiresAt <= now) pending.delete(nonce);
  }
}

/** Mint a fresh single-use capability bound to `tabId` + `origin`. */
function mint(tabId: number, origin: Origin): string {
  const nonce = crypto.randomUUID();
  pending.set(nonce, { tabId, origin, expiresAt: Date.now() + TOKEN_TTL_MS });
  return nonce;
}

/**
 * Consume a nonce: delete it immediately, then reject it if its TTL has elapsed.
 *
 * Deletion happens *before* the expiry check so that a replay fails even when the replay races the
 * original — the second caller finds nothing in the map regardless of timing.
 */
function consume(nonce: string, record: TokenRecord): TokenRecord | null {
  pending.delete(nonce);
  if (record.expiresAt <= Date.now()) return null;
  return record;
}

/** Read the vault, treating a corrupt or absent record as an empty vault. */
async function readVault(): Promise<StoredVault> {
  const stored = await chrome.storage.local.get<Record<string, unknown>>(STORAGE_KEY);
  const vault = stored[STORAGE_KEY];
  if (typeof vault !== 'object' || vault === null) return {};
  return vault as StoredVault;
}

/** The pair for `origin`, defaulting to empty strings when nothing has been saved. */
function pairFor(vault: StoredVault, origin: Origin): { username: string; password: string } {
  const entry = vault[origin];
  return {
    username: isValidField(entry?.username) ? entry.username : '',
    password: isValidField(entry?.password) ? entry.password : '',
  };
}

/**
 * Look up a capability presented by a caller, without consuming it yet.
 *
 * Binding is enforced against the *record*, never against the payload: the record already says which
 * tab and origin the nonce was minted for. A content-script sender has a tab and a page URL, so both
 * are re-checked here. The form iframe is an extension-origin document, so Chrome reports
 * `sender.tab === null` for it; that sender cannot supply a different tab or origin, and the nonce is
 * still single-use, so the record's binding is what it is held to.
 */
function findBound(nonce: unknown, sender: chrome.runtime.MessageSender): { nonce: string; record: TokenRecord } | null {
  if (typeof nonce !== 'string') return null;

  const record = pending.get(nonce);
  if (record === undefined) return null;

  const senderTab = sender.tab?.id;
  if (typeof senderTab === 'number') {
    if (senderTab !== record.tabId) return null;
    if (originOf(sender.tab?.url) !== record.origin) return null;
  }

  return { nonce, record };
}

/**
 * `TOKEN_ISSUE`: mint a redeem nonce for the sender's own tab and origin.
 *
 * Both `sender.tab.id` and an http(s) origin derived from `sender.tab.url` are required. An
 * extension-origin document, a sandboxed/opaque frame, or `about:blank` yields no origin and is
 * refused here — this is the check that blocks anyone but a real page's content script.
 */
function handleIssue(sender: chrome.runtime.MessageSender): Result<{ nonce: string }> {
  sweepExpired(Date.now());

  const tabId = sender.tab?.id;
  const origin = originOf(sender.tab?.url);
  if (typeof tabId !== 'number' || origin === null) {
    return { ok: false, error: 'Untrusted sender: no tab or no http(s) origin' };
  }

  return { ok: true, value: { nonce: mint(tabId, origin) } };
}

/**
 * `TOKEN_REDEEM`: consume a redeem nonce and return the pair for the origin it was bound to.
 *
 * Consumed exactly once, before any storage read, so a replayed nonce finds nothing.
 */
async function handleRedeem(
  nonce: unknown,
  sender: chrome.runtime.MessageSender,
): Promise<Result<{ origin: Origin; username: string; password: string }>> {
  const bound = findBound(nonce, sender);
  if (bound === null) return { ok: false, error: 'Session expired — reopen from the page' };

  const record = consume(bound.nonce, bound.record);
  if (record === null) return { ok: false, error: 'Session expired — reopen from the page' };

  const vault = await readVault();
  return { ok: true, value: { origin: record.origin, ...pairFor(vault, record.origin) } };
}

/**
 * `TOKEN_GET`: consume a redeem nonce and reply `{origin, username, password, saveNonce}`.
 *
 * The redeem nonce is spent here so the form can prove binding and prefill in one round trip, and a
 * *second* single-use capability (`saveNonce`) is minted for the eventual write. Two nonces keep the
 * read authority and the write authority separate; neither can stand in for the other.
 */
async function handleGet(
  nonce: unknown,
  sender: chrome.runtime.MessageSender,
): Promise<Result<{ origin: Origin; username: string; password: string; saveNonce: string }>> {
  const bound = findBound(nonce, sender);
  if (bound === null) return { ok: false, error: 'Session expired — reopen from the page' };

  const record = consume(bound.nonce, bound.record);
  if (record === null) return { ok: false, error: 'Session expired — reopen from the page' };

  const vault = await readVault();
  const saveNonce = mint(record.tabId, record.origin);
  return { ok: true, value: { origin: record.origin, ...pairFor(vault, record.origin), saveNonce } };
}

/**
 * `SAVE`: consume a save nonce and persist the pair under the origin it was bound to.
 *
 * The write target is `record.origin`, never anything from the payload — a page cannot ask for its
 * pair to be stored under someone else's origin because it cannot name an origin at all.
 */
async function handleSave(
  nonce: unknown,
  username: unknown,
  password: unknown,
  sender: chrome.runtime.MessageSender,
): Promise<Result<{ origin: Origin }>> {
  if (!isValidField(username) || !isValidField(password)) {
    return { ok: false, error: `Fields must be strings of at most ${MAX_FIELD_LEN} characters` };
  }

  const bound = findBound(nonce, sender);
  if (bound === null) return { ok: false, error: 'Session expired — reopen from the page' };

  const record = consume(bound.nonce, bound.record);
  if (record === null) return { ok: false, error: 'Session expired — reopen from the page' };

  const vault = await readVault();
  const next: StoredVault = {
    ...vault,
    [record.origin]: { username, password, updatedAt: Date.now() },
  };
  await chrome.storage.local.set({ [STORAGE_KEY]: next });

  return { ok: true, value: { origin: record.origin } };
}

/**
 * Dispatch one message.
 *
 * The payload is untrusted and therefore validated, not assumed: a non-`WireMessage` is refused. The
 * `default` branch is unreachable once every variant is handled, which makes the exhaustiveness
 * check a compile-time obligation (the `never` assignment fails if a variant is added unhandled).
 */
async function dispatch(message: unknown, sender: chrome.runtime.MessageSender): Promise<Result<unknown>> {
  if (!isWireMessage(message)) return { ok: false, error: 'Malformed message' };

  switch (message.type) {
    case 'TOKEN_ISSUE':
      return handleIssue(sender);
    case 'TOKEN_REDEEM':
      return handleRedeem(message.nonce, sender);
    case 'TOKEN_GET':
      return handleGet(message.nonce, sender);
    case 'SAVE':
      return handleSave(message.nonce, message.username, message.password, sender);
    default: {
      const unreachable: never = message;
      return { ok: false, error: `Unknown message type: ${String(unreachable)}` };
    }
  }
}

chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
  // Returning `true` keeps the channel open for the async reply exactly once per message.
  dispatch(message, sender).then(sendResponse, (error: unknown) => {
    sendResponse({ ok: false, error: error instanceof Error ? error.message : 'Internal error' });
  });
  return true;
});


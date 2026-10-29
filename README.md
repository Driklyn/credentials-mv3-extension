# Credentials

A Manifest V3 Chrome extension that stores **one synthetic credential pair per web origin** in
`chrome.storage.local` (the mocked credential API) and surfaces it in a small form anchored to the
page — without handing the page a single byte of it.

- **Runtime dependencies: none.** Three devDependencies, all build-time only (see [§7](#7-dependency-justification)).
- **Permissions: `storage`, `tabs`.** No `host_permissions`, no `activeTab`, no `scripting`, no `sidePanel` (see [§8](#8-permission-justification)).
- **Plaintext lives in exactly two execution contexts**, and one of them is the user's own keyboard (see [§2](#2-execution-contexts--plaintext-visibility)).

Source layout:

```
src/shared/protocol.ts             wire vocabulary + the one origin-derivation function
src/background/service-worker.ts   token authority; the only reader/writer of chrome.storage.local
src/content/content.ts             Open button + closed shadow root + iframe host (IIFE bundle)
src/form/form.{html,ts,css}        the form document (the only plaintext UI)
scripts/build.mjs, vite.config.ts  two-pass build
public/manifest.json, public/icons manifest + icons, copied verbatim into dist/
```

---

## 1. Why this architecture

The naive implementation is a content script that does:

```ts
iframe.src = chrome.runtime.getURL('form.html') + '?origin=' + location.origin;
document.body.appendChild(iframe);
```

That fails on three counts, and each one is load-bearing:

1. **The page chooses the lookup target.** `?origin=` is attacker-controlled. A hostile page simply
   rewrites the frame's `src`, and reads *another site's* saved pair. Nothing in the extension can tell
   the difference between "the user opened this on example.com" and "example.com asked for bank.com".
2. **The page can retarget or shadow the frame.** A frame in the page's light DOM is an element the
   page owns: it can move it, restyle it, overlay it, and read its `src`. The user cannot verify what
   they are typing into.
3. **The frame is a bearer capability anyone can hold.** If `form.html` can be loaded with no
   session proof, a page can open its own hidden copy and drive it.

Credentials' answer is three structural choices:

- **Closed shadow root** (`content.ts:88`, `attachShadow({ mode: 'closed' })`). The iframe is inside a
  shadow tree whose root reference never leaves `mount()`'s scope. The page sees one host `<div>` and
  cannot reach the frame, its attributes, or its `src`. `host.shadowRoot` returns `null`.
- **Nonce binding instead of an origin parameter.** The content script never learns the origin and
  never sends one. It asks the service worker (`TOKEN_ISSUE`) for a random, single-use, 60s capability;
  the service worker derives `{tabId, origin}` from `sender.tab` alone and stores them in an in-memory
  `Map`. The form redeems that nonce and *receives* the origin back. There is no message field in which
  an origin could be forged (`protocol.ts:54-69`, documented at `protocol.ts:48-53`).
- **A second capability for writing.** `TOKEN_GET` spends the redeem nonce and mints a fresh
  `saveNonce`, so prefilling a form cannot spend the authority to overwrite the vault
  (`service-worker.ts:141-154`).

The **side panel** would be strictly stronger: it has no DOM relationship to the page at all, so the
page cannot even infer geometry. It is out of scope per the brief (in-page extension-origin iframe),
and §6 prices that difference as *small* rather than pretending it is zero.

---

## 2. Execution contexts & plaintext visibility

| Context | Who controls it | Sees the username / password? | Sees the nonce? | Can the page read it? |
| --- | --- | --- | --- | --- |
| **Page main world** (`https://example.com`) | the site | ✗ — never | ✗ | — |
| **Content script** (`content.ts`, isolated world) | the extension | ✗ — no message type returns a credential, and it imports neither `STORAGE_KEY` nor a field reader | ✓ briefly, as `showPanel`'s argument, then it is inside the iframe `src` | ✗ (isolated world; not exposed on `window`) |
| **Shadow root DOM** (closed) | the extension | ✗ — contains a button, a style block and an empty container | ✗ — the nonce is in the iframe URL, which the page cannot read | ✗ — no `shadowRoot` handle |
| **Form iframe document** (`chrome-extension://<id>/form.html`) | the extension | ✓ — prefilled into two `<input>.value`s and held in one `SAVE` payload | ✓ — taken from the fragment, then scrubbed from the URL | ✗ — different origin, and unreachable from the shadow root anyway |
| **Service worker** | the extension | ✓ — it is the credential-API client; it moves the pair storage → reply and reply → storage | ✓ — it mints and consumes them | ✗ |
| **`chrome.storage.local`** | the extension (profile on disk) | ✓ — plaintext by design; it stands in for the credential API | ✗ | ✗ |
| **Network / page** | the site | ✗ — no `fetch`, no form navigation, no `postMessage` | ✗ | — |

Three properties make the table hold:

- `src/content/content.ts` contains **no** reference to `chrome.storage`, to a password field, or to an
  origin. Its only import from the protocol is `OPEN_BUTTON_ID` plus types (`content.ts:12`), so the
  bundled IIFE physically cannot read a pair.
- `chrome.storage` appears in exactly one source file, `service-worker.ts` (lines 57 and 183). There is
  no second writer to audit.
- The form document never persists anything: the write capability lives in a module-scoped
  `let saveNonce` (`form.ts:40`), and `localStorage` / `sessionStorage` / `document.cookie` /
  `postMessage` / `window.name` appear nowhere in `src/` outside the comment that forbids them
  (`form.ts:11-12`).

The **sixth** place plaintext exists is the user's display and keyboard. That is unavoidable for any UI
that shows a saved password, and it is why §6 lists clickjacking as the one residual, *partially*
mitigated risk.

---

## 3. Data flow

```
 page (untrusted)      content script (isolated)         service worker              storage
 ─────────────────     ──────────────────────────        ──────────────              ───────
  click "Open" ───────▶ issueNonce()            (1)
                       { type: 'TOKEN_ISSUE' } ─────────▶ handleIssue:
                                                         tabId + originOf(sender.tab.url)
                                                         refuse if either is absent
                                                         nonce = randomUUID()  (2)
                                                         pending.set(nonce,{tabId,origin,+60s})
                          ◀──────────────────────────── { ok, value: { nonce } }        (3)
                       iframe.src = form.html#<nonce>                                    (4)
                       (inside closed shadow root)
                          │
                          ▼  form document boots
                       location.hash.slice(1) → history.replaceState(path)               (5)
                       { type:'TOKEN_GET', nonce } ─────▶ findBound + consume (single use)
                                                         read vault[origin] (default '')
                                                         saveNonce = mint(same tab+origin) (6)
                          ◀──────────────────────────── { origin, username, password, saveNonce }
                       render origin, prefill fields, keep saveNonce in memory  (7)
  user edits & clicks Save
                       { type:'SAVE', nonce: saveNonce, username, password }
                                                     ─▶ validate ≤512 chars, consume saveNonce
                                                        vault[origin] = { …, updatedAt }  (8)
                          ◀──────────────────────────── { ok, value: { origin } }
                       "Saved ✓ — reopen from the page to save again"
```

1. **Issue** — `content.ts:35-43`. The service worker runs `sweepExpired`, then requires
   `sender.tab.id` **and** `originOf(sender.tab.url)` (`service-worker.ts:103-113`). An
   extension-origin document, a sandboxed/opaque frame, or `about:blank` has no http(s) origin and is
   refused here.
2. **Mint** — `crypto.randomUUID()` bound to `{tabId, origin, expiresAt}` in an in-memory `Map`
   (`service-worker.ts:37-41`). In memory means a service-worker restart silently invalidates every
   outstanding capability.
3. **Reply** — a `Result<T>` envelope; the content script narrows it rather than trusting it
   (`content.ts:46-61`).
4. **Fragment** — `form.html#<nonce>` (`content.ts:190`). A fragment is never sent to a server, never
   appears in `Referer`, and is not a query parameter a page script could rewrite.
5. **Scrub** — `form.ts:205-209`. The fragment is read once and `replaceState` rewrites the entry to the
   bare pathname, so the nonce is gone from `location` and from anything that later reads the URL.
   `replaceState` (not `pushState`) leaves no back-entry containing it. A page loaded with no fragment
   (e.g. `chrome-extension://<id>/form.html` opened directly) fails closed here (`form.ts:211-216`).
6. **Bind + prefetch** — `TOKEN_GET` consumes the redeem nonce and returns the *bound origin*, the pair,
   and a fresh `saveNonce` for the write (`service-worker.ts:141-154`).
7. **Display** — `siteLine.textContent = origin` (`form.ts:126`): the origin is shown as provenance, so
   the user can see which site this pair belongs to before touching the password. The fields are
   `disabled` in the markup and only enabled after a successful reply (`form.html:36,42,46`).
8. **Write** — the target is `record.origin` from the token record, never a payload field
   (`service-worker.ts:178-183`). The save nonce is spent here; `form.ts:182` nulls its local copy so a
   second Submit fails locally and unambiguously.

`TOKEN_REDEEM` (`service-worker.ts:120-132`) is implemented and kept in the union for completeness; the
form deliberately uses `TOKEN_GET` so that one round trip can both prefill and arm a write.

---

## 4. How a lookup is bound to the visited site

Three independent layers, any one of which alone would prevent a cross-origin read:

**Layer 1 — the origin exists only on the service-worker side.** No message type has an `origin`,
`tabId` or `url` field (`protocol.ts:54-69`). The service worker reads `sender.tab.url` itself
(`service-worker.ts:106-107`) and writes the result into the token record. There is nowhere to put a
forged origin, so a hostile page has no parameter to attack.

**Layer 2 — the capability is single-use, tab-bound and short-lived.** `findBound`
(`service-worker.ts:81-94`) refuses a nonce unless the record exists, the TTL has not elapsed, and the
sender (when Chrome reports one) is the same tab with the same origin; `consume`
(`service-worker.ts:49-53`) deletes the nonce *before* the expiry check, so a replay race finds nothing
rather than a stale record. Sharing a nonce out of band buys an attacker one redemption, from the
victim's own tab, within 60s — and no ability to convert it into a different origin.

**Layer 3 — `originOf` is the only definition of "the site".** `protocol.ts:79-93` accepts absolute
`http:`/`https:` URLs only, rejects `parsed.origin === 'null'` (sandboxed frames, `data:`, `blob:`), and
returns the serialised origin, so scheme and port are part of the key: `https://example.com`,
`http://example.com` and `https://example.com:8443` are three different entries.

**Why the page can influence none of them:**

- It cannot send extension messages: `chrome.runtime` is not exposed to main-world script, and the
  service worker's only listener is `chrome.runtime.onMessage` fed by extension contexts.
- It cannot write `sender.tab.url`: the browser fills that in from the frame that sent the message.
- It cannot reach the form's nonce: the iframe lives in a closed shadow root, and the nonce has been
  scrubbed from the frame URL before any page script could look.
- It cannot read the reply: the form's document is on the extension origin, cross-origin to the page.

A page *can* request its own pair — that is the feature. It cannot make the extension believe it is
somewhere else.

---

## 5. Frame-busting analysis

**Can the page retarget the iframe?**

| Attempt | Outcome |
| --- | --- |
| `document.getElementById('credentials-open-host').shadowRoot` | `null` — closed mode (`content.ts:88`); the root reference never escapes `mount()`. |
| `document.querySelectorAll('iframe')` | Finds nothing of ours: the frame is a child of the shadow tree, not of the document. |
| `frameElement` from inside the frame | `null` — the parent node is in a closed shadow root. |
| `host.innerHTML = …` / `host.replaceChildren()` | The host has no light-DOM children, so this can only detach the *host*; it never reaches into the shadow tree. |
| Move / restyle / overlay the host | Possible — it is a page element. Mitigated, not blocked: the host's properties are inline `!important` after `all: initial` (`content.ts:80-84`), so `#credentials-open-host { display: none }` or `* { all: unset }` cannot falsify the overlay. §6 keeps the pixel-geometry residue. |
| `contentWindow.location.replace('…')` | The `contentWindow` handle is reachable only from the shadow root, i.e. from extension code. The page can detach or remove the host, which *kills* the form rather than retargeting it — and the next open mints a fresh session for the same origin. |
| Put its own `chrome-extension://…/form.html` frame on the page and drive it | Waits for a nonce that only a real `TOKEN_ISSUE` can mint. With none, the form renders "No session — open Credentials from the page" with every control disabled (`form.ts:211-216`, `form.html:36,42,46`). |
| Steal the nonce by reading the iframe `src` | Cannot read it. |
| Leak via `window.name` / `postMessage` / `document.cookie` | No such channel exists in `src/` — the form never writes to one. |

**What `web_accessible_resources` exposure means.** `form.html`, `form.js` and `form.css` are listed
(`public/manifest.json:20-25`) because a content script's iframe must load them from the page's context;
that is a requirement of the frame, not a convenience. The consequence is real and worth stating:
**any web page can load these resources in its own frame and can therefore detect that Credentials is
installed** by observing whether the load succeeds. Chrome offers no way to narrow this for in-page
frames short of moving the UI out of the page (side panel / action popup), which is exactly the trade
§1 acknowledges. What the exposure does *not* grant is capability: the form refuses without a live
nonce, the nonce is unguessable and tab-bound, and the form holds no data until one is redeemed. The
exposure is **fingerprinting**, not data theft.

Framing it is not enough either: the most a hostile page gets by embedding `form.html` is a copy of
Credentials' own inert UI, on a different origin, with no session — it cannot read across the frame boundary,
and an unredeemed form has nothing to read.

---

## 6. Threat model

| Threat | Covered by | Residual risk |
| --- | --- | --- |
| **Clickjacking overlay** — the page puts an invisible layer over the panel to make the user click "Save" with attacker-chosen values, or fakes the panel | The panel lives in a closed shadow root with `z-index: 2147483647` and inline `!important` geometry (`content.ts:80-84,117-129`), so page elements cannot cover it; the origin is shown in the Site line (`form.ts:126`) so the target is verifiable | **Partial.** A page can still move or reorder the *host* and mis-label its own content around the panel. A tricked save only writes under the true origin, so it can damage the attacker's own site, not another. |
| **Iframe geometry inference** — the page polygons the panel's position to learn *whether* and *where* a form opened | The frame is not in the document; the page can only observe its own layout and pointer activity | **Small, accepted.** Whether the user uses Credentials on this page, and roughly where the panel is, is inferable. No content, origin or credential is. |
| **Keystroke theft** — page script sniffs keys or `input` events meant for the form | The form's document is on the extension origin and unreachable from the page. The same isolation shows up in the other direction: `content.ts:222-226` notes that Escape presses *inside* the frame cannot reach the content script, so the ✕ control is the guaranteed close path | **Blocked.** |
| **Cross-origin pair request** — `evil.test` asks for `bank.com`'s pair | §4, layers 1–3: no origin in any payload, nonce bound to `{tabId, origin}`, single-use, 60s TTL | **Blocked.** |
| **Token replay / theft** — reuse a nonce, or obtain one over a page-visible channel | Single-use by construction: deleted before the expiry check (`service-worker.ts:49-53`); minted only for a real `sender.tab`; carried in a fragment that is scrubbed on load (`form.ts:205-209`) | **Blocked.** Worst case for a stolen, unused nonce is one read of the victim's own origin's pair, from that origin's tab. |
| **Service-worker restart / eviction** — the SW dies between open and submit | `pending` is an in-memory `Map` (`service-worker.ts:21-27`); a restart empties it, so the form's nonce no longer resolves; the `sendMessage` rejection is caught and rendered as "Session expired" (`form.ts:112-115,162-167`) | **Fail closed.** The user must reopen from the page. Nothing is ever written on an unverified session. |
| **Oversized / non-string fields** | `isValidField` on both sides (`protocol.ts:96-98`; `service-worker.ts:168-170`; `form.ts:148-151`) | **Blocked.** |
| **Redirect or tab race** — the user is navigated between issue and redeem | `findBound` re-checks `originOf(sender.tab.url)` against the record whenever the sender has a tab (`service-worker.ts:87-91`) | **Detected → refused.** |
| **Extension XSS via the form** | `extension_pages` CSP `script-src 'self'; object-src 'none'` (`public/manifest.json:32-34`), mirrored by the document's own `<meta>` CSP with `default-src 'none'`, `base-uri 'none'`, `form-action 'none'` (`form.html:10-13`); the origin is assigned with `textContent`, never as markup (`form.ts:125-126`) | **Blocked** at the policy layer. |
| **Plaintext at rest** | Nothing — **this is the mock**, by instruction | **Accepted and stated.** §9 is where production fixes it. |

---

## 7. Dependency justification

| Package | Scope | Why |
| --- | --- | --- |
| `vite` | dev | The bundler; emits the IIFE content script and the ES-module form/service-worker bundles with stable, non-hashed filenames (`vite.config.ts:131-138`). |
| `typescript` | dev | `tsc --noEmit` is the only static check in the project (`npm run typecheck`); Vite strips types without checking them. |
| `@types/chrome` | dev | Types for `chrome.runtime`, `chrome.storage` and `MessageSender` (`tsconfig.json:7`). Type-only; nothing is emitted from it. |
| *(no `@types/node`)* | — | `scripts/build.mjs` orchestrates the two Vite passes, and `vite.config.ts` reaches Node builtins through `process.getBuiltinModule` (`vite.config.ts:164-166`) so the dependency budget stays at three packages. |

**Zero runtime dependencies.** Everything shipped in `dist/` is written in this repo or emitted from
`src/shared/protocol.ts`. There is no runtime supply-chain surface, no `node_modules` inside the
extension, and no third-party code that could phone home — consistent with a form document whose CSP
grants no `connect-src`.

---

## 8. Permission justification

```jsonc
"permissions": ["storage", "tabs"]
```

- **`storage`** — `chrome.storage.local` *is* the credential API stand-in. Used only in
  `service-worker.ts` (read at line 57, write at line 183). One key, `v1` (`protocol.ts:11`), holding the
  whole map `{ [origin]: { username, password, updatedAt } }`.
- **`tabs`** — the service worker must read `sender.tab.url` at mint time (§4, layer 1). It is required
  for a second, structural reason too: **the form iframe is an extension-origin document, so Chrome
  reports `sender.tab === null` for its messages.** Binding therefore has to happen when the *content
  script* asks — it does have a tab — and the form redeems what that mint produced
  (`service-worker.ts:72-80` spells this out). Without `tabs`, `sender.tab.url` is unavailable on
  arbitrary origins and the binding collapses to "whatever the payload claims".
- **`host_permissions` — deliberately absent.** A declared `content_scripts` match pattern is enough to
  inject, and the content script makes no cross-origin requests. Adding `host_permissions` would widen
  what the extension *could* do (fetch/XHR to every site) for no functionality.
- **`activeTab` — deliberately absent.** It is gesture-scoped: the button would only work in the tab
  where the user invoked the extension action, which is not this UI.
- **`scripting` — deliberately absent.** Nothing is injected programmatically; the content script is
  declared in the manifest.
- **`sidePanel` — deliberately absent.** The form is an in-page frame by design (§1); the side panel was
  considered and rejected as out of scope.

The content-script pattern is `http://*/*` + `https://*/*` with `all_frames: false` and
`run_at: document_idle` (`public/manifest.json:12-19`), so only top-level pages on the two schemes the
model understands are touched — and `content.ts:20-24` re-checks both, so manifest drift cannot silently
widen the surface.

---

## 9. What production would add

1. **Encryption at rest.** Replace the plaintext `v1` blob with per-record ciphertext (e.g. AES-GCM) keyed
   by a session-scoped key unlocked on first use and never written to `chrome.storage`. `protocol.ts:31`
   already labels the current shape "plaintext by design", so the migration points are the `StoredVault`
   type and `readVault`/`handleSave` in the service worker.
2. **OS keychain / platform credential provider.** Hold the key in Keychain, Credential Manager or
   libsecret — or delegate the whole store to a real credential API so the extension never persists
   secrets at all, leaving `chrome.storage.local` as a metadata cache.
3. **Origin allow-list and eTLD+1 grouping.** Opt-in per origin, with a management UI (list, edit, delete,
   pause) instead of today's one-pair-per-origin, no-management-UI model. It also forces a decision the
   code makes implicitly today: `https://example.com` and `https://login.example.com` are *different*
   entries under `protocol.ts:79-93`, deliberately.
4. **User-gesture-gated autofill into the page.** The natural next feature — typing the pair into the
   site's own login form — is where a page could finally get the plaintext. It would need a per-fill
   confirmation, a visible indicator of which fields receive the value, and preferably a design where the
   content script writes into the field itself rather than handing the string to page script.
5. **A hardened token lifecycle.** A per-tab nonce *generation* invalidated on navigation
   (`tabs.onUpdated`), constant-time nonce comparison, and rate limiting on `TOKEN_ISSUE`.
6. **Breadth.** Multiple pairs per origin, TOTP, import/export, and an audit log of reads.

---

## 10. Load & test

### Build and load

```bash
npm install
npm run typecheck   # tsc --noEmit, strict
npm run build       # typecheck, then both Vite passes → dist/
```

`npm run build` runs `scripts/build.mjs`, which invokes Vite twice (content script as an IIFE first, then
the application pass) and produces a flat `dist/` in which every filename is literal — no content hashes,
because the manifest, `web_accessible_resources`, the iframe `src` and the service-worker path all
reference exact names:

```
dist/manifest.json   dist/icons/{16,32,48,128}.png   dist/content.js   dist/form.html
dist/form.js         dist/form.css                    dist/protocol.js  dist/service-worker.js
```

(`protocol.js` is the shared chunk. `service-worker.js` imports it by relative specifier
(`import{…}from"./protocol.js"`), while the form pass, which has a single script input, inlines it into
`form.js`; neither is named in the manifest.)

Then: `chrome://extensions` → **Developer mode: on** → **Load unpacked** → select `dist/`.

### Manual test matrix

| # | Steps | Expected |
| --- | --- | --- |
| 1 | `https://example.com/a` → **Open** → save `u`/`p` → navigate to `/b` → **Open** | fields pre-filled with `u`/`p`; Site line reads `https://example.com` |
| 2 | `https://example.org` → **Open** | both fields blank, "No saved pair yet" |
| 3 | Restart the browser → `https://example.com` → **Open** | `u`/`p` persist (from `chrome.storage.local`) |
| 4 | Page console: `document.getElementById('credentials-open-host').shadowRoot` | `null` |
| 5 | Page console: `document.querySelectorAll('iframe')` | none of them is Credentials' |
| 6 | Open `chrome-extension://<id>/form.html` as a top-level page | refuses: "No session — open Credentials from the page", fields disabled |
| 7 | **Open**, wait >60s, then **Save** | refused: "Session expired — reopen from the page" |
| 8 | In `chrome://extensions`, stop the service worker (or let it be evicted), then **Save** | refused, fail closed — no write |

Also worth confirming by eye after **Open**: the frame's address is `…/form.html` with **no** `#nonce`
left in it (the fragment is scrubbed on boot), and the page's console offers no `frameElement`,
`contentWindow` or `shadowRoot` path to the form.

### Deliberate non-goals

No unit tests. The logic that matters is bound to Chrome APIs and to browser process state
(`sender.tab`, message routing, SW eviction), so the checks above are the ones that actually exercise it;
the remaining pure logic (`originOf`, `isValidField`) is three lines each and is covered by the matrix
rows 1–2 and 6.

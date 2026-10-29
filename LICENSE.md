# Source-Available Educational License & Terms of Use

Copyright (c) 2026. All rights reserved.

### 1. Purpose and Scope

This repository contains **Credentials** (`package.json` name: `credentials`), a Manifest V3 Chrome
extension that keeps **one synthetic username/password pair per web origin** in `chrome.storage.local` and
surfaces it in an in-page form hosted in an extension-origin iframe inside a closed shadow root. It was
built as a response to a design brief: a single, short-lived, tab-bound nonce issued by the extension's
service worker stands in for any origin parameter, so an untrusted host page can never ask for — or learn
— another origin's pair.

What is in scope:

- **Its subject matter is browser extension security, not application features.** The repository is a
  worked example of extension isolation, data flow, and trust boundaries: the service worker is the only
  reader/writer of storage; the content script touches no credential and no origin; the form document is
  the only plaintext UI; plaintext never reaches the page's main world.
- **The written analysis is part of the deliverable.** `README.md` (execution contexts, data flow,
  capability binding, frame-busting, threat model, permission and dependency justifications,
  production gaps) and `scope.md` (the original brief) document _why_ each structural choice was made,
  including the residual risks that are accepted rather than solved.
- **The implementation.** TypeScript under `src/` (`shared/protocol.ts`, `background/service-worker.ts`,
  `content/content.ts`, `form/*`), a two-pass Vite build in `scripts/build.mjs` and `vite.config.ts`, and
  a hand-written `public/manifest.json`. Runtime dependencies: none. DevDependencies: three, build-time
  only.
- **The delivery format.** It loads as an unpacked extension built to `dist/` and is exercised through the
  manual test matrix in `README.md` §10.

What is explicitly **out of scope** — these are learning aids, not a product:

- **It is a mock, not a credential vault.** Storage is plaintext by design and holds synthetic data only.
  There is no server, authentication, encryption, key management, vault UI, multi-pair support, TOTP, or
  autofill into the host page's own login form. `README.md` §9 enumerates what production would add.
- **No release, signing, CI, or support commitment.** No packaged `.crx`, no Chrome Web Store listing, no
  test suite (`README.md` §10 states this deliberately), no maintenance guarantee.
- **Chrome only.** `minimum_chrome_version` is 116; Firefox, Safari, and MV2 are not targeted.

It is published strictly as a personal portfolio project for educational, instructional, and review
purposes. The design is intended to be read and reasoned about, not deployed. Nothing here is security
advice, and the architecture should not be taken as clearance to handle real secrets.

### 2. Permitted Use

You are permitted and encouraged to:

- **Review and Study:** Analyze the architectural design, the TypeScript implementation, the Manifest V3
  extension patterns (service worker, content script, closed shadow root, `postMessage`-free iframe
  hosting), and the nonce-based capability model that binds a lookup to the visited origin.
- **Learn:** Use the concepts, logic, and patterns as inspiration or reference points for your own
  independent projects.

### 3. Prohibited Use

You are strictly prohibited from:

- **Direct Copying & Production Deployment:** Copying, pasting, mirroring, or deploying this codebase—or
  substantial portions of it—directly into any production, commercial, or live environment, or using it
  to store, transport, or handle real credentials.
- **Direct Redistribution:** Republication or distribution of this source code or its derivatives as your
  own functional software product, extension, or template.
- **Commercial Exploitation:** Selling, leasing, or monetizing the code or the extension configuration
  contained within this repository.

### 4. Disclaimer of Liability

THIS SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE, AND NONINFRINGEMENT. IN NO EVENT SHALL THE AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES, OR OTHER LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT, OR OTHERWISE, ARISING FROM, OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE SOFTWARE.

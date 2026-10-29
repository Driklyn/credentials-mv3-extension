/**
 * Two-pass build.
 *
 * Vite 8 accepts a single config object, not an array, so the two passes that `plan.md` Step 1 calls
 * for are orchestrated here, each in its own `vite build` invocation so neither inherits the other's
 * inputs (Vite deep-merges an inline config over `vite.config.ts`):
 *
 *   1. `--mode content` — content script as an IIFE → dist/content.js. This pass owns
 *      `emptyOutDir`, so `dist/` is rebuilt from clean every time.
 *   2. no mode          — form document/script/stylesheet + service worker, then manifest + icons,
 *      all flat in dist/ (the `credentials-assemble` plugin in `vite.config.ts` copies the latter).
 *
 * `--watch` starts both passes in watch mode (the switches only observe changes; each rebuild only
 * writes the files that changed, so the app pass does not clear `dist/` on every content edit).
 */
import { spawnSync } from 'node:child_process';

const npx = process.platform === 'win32' ? 'npx.cmd' : 'npx';
const watch = process.argv.includes('--watch');

const passes = [
  { label: 'content script (iife)', args: ['vite', 'build', '--mode', 'content'] },
  { label: 'application (form + service worker)', args: ['vite', 'build'] },
];

for (const pass of passes) {
  console.log(`\n[credentials] building ${pass.label}`);
  const args = watch ? [...pass.args, '--watch'] : pass.args;
  const result = spawnSync(npx, args, { stdio: 'inherit', shell: process.platform === 'win32' });
  if (result.status !== 0) {
    process.exit(result.status ?? 1);
  }
}

console.log(watch ? '\n[credentials] watching for changes' : '\n[credentials] build complete → dist/');

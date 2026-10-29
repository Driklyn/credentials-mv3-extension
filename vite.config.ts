import { defineConfig, type ConfigEnv, type UserConfig } from 'vite';

/** Input shape of Rolldown's `assetFileNames` callback, as exposed by Vite's `rollupOptions`. */
type AssetFileNameInfo = { names: string[] };

/** Minimal shape of the `writeBundle` hook context this config uses. */
type WriteBundleContext = {
  environment: { config: { root: string; build: { outDir: string } } };
};

/** Minimal shape of the Node builtins this config needs, declared locally to keep `@types/node` out. */
interface NodePathModule {
  join(...parts: string[]): string;
  resolve(...parts: string[]): string;
}
interface NodeFsPromisesModule {
  cp(from: string, to: string, options: { recursive: boolean; force: boolean }): Promise<void>;
  mkdir(path: string, options: { recursive: boolean }): Promise<string | undefined>;
  rm(path: string, options: { recursive: boolean; force: boolean }): Promise<void>;
}
interface NodeProcess {
  getBuiltinModule(id: 'node:fs/promises'): NodeFsPromisesModule;
  getBuiltinModule(id: 'node:path'): NodePathModule;
}

/**
 * Every emitted path is referenced by a literal string (manifest, `web_accessible_resources`, iframe
 * `src`, content script), and `chrome-extension:` is an opaque scheme where root-absolute URLs are
 * meaningless. `./` makes Vite emit document-relative references (`./form.js`, `./form.css`), which
 * resolve correctly inside `chrome-extension://<id>/assets/`.
 */
const BASE = './';

/**
 * Content-script pass: `src/content/content.ts` → `dist/content.js`, as a classic IIFE.
 *
 * `content_scripts[].js` cannot be an ES module, so the bundle must be a single classic script. This
 * pass owns `emptyOutDir`, because it always runs first.
 *
 * No `inlineDynamicImports`: Rolldown deprecated it, and Vite already sets `codeSplitting: false`
 * for IIFE output, which is exactly the single-file bundle that is needed here.
 */
const contentConfig: UserConfig = {
  base: BASE,
  build: {
    emptyOutDir: true,
    outDir: 'dist',
    lib: {
      entry: 'src/content/content.ts',
      formats: ['iife'],
      name: 'CredentialsContent',
      fileName: () => 'content.js',
    },
    rollupOptions: {
      output: { entryFileNames: 'content.js' },
    },
  },
};

/**
 * Application pass: form document, form script, stylesheet and service worker, all flat in `dist/`.
 *
 * Filenames are deliberately stable (no content hashes) because `web_accessible_resources`, the
 * iframe `src`, the manifest's service-worker path and the content script's `getURL` all reference
 * literal paths.
 */
const appConfig: UserConfig = {
  base: BASE,
  /**
   * The app pass is rooted at `src/`, which is what makes every emitted path flat.
   *
   * Vite derives both the HTML chunk's file name *and* the document-relative URLs injected into it
   * from the document's path relative to `root` (`relativeUrlPath`). With the project root, the form
   * document is `src/form/form.html`, so Rolldown emits it to `dist/src/form/form.html` and Vite
   * rewrites its tags to `../../form.js`. Rooting at `src/` makes the document `form/form.html`, so it
   * is emitted as `dist/form.html` with tags pointing at `./form.js` — the names that the manifest,
   * `web_accessible_resources` and `chrome.runtime.getURL('form.html')` all reference.
   *
   * This is safe because the service worker input is path-independent: its name comes from the input
   * key, not from its location.
   */
  root: 'src',
  // `public/` is copied by the `credentials-assemble` plugin below, not by Vite. Vite's own copy would land
  // the files relative to this pass's `src/` root, putting them beside the sources instead of in
  // `dist/`; the plugin writes them where the manifest says they are.
  publicDir: false,
  experimental: {
    /**
     * Two path problems remain, both caused by a `chrome-extension:` target where every URL resolves
     * against `chrome-extension://<id>/` and no web server participates.
     *
     * 1. Icons. They are copied into `dist/` by `credentials-assemble` (not by Vite), so Vite has already
     *    turned `icons/16.png` into `/icons/16.png`. Mapped back to a path relative to the manifest
     *    (which lives in `dist/`), so the reference resolves on the extension origin.
     *
     * 2. The form's script tag. Vite emits it relative to the document's source directory, yielding
     *    `../form.js` from `form/form.html`. The document and the bundle end up as siblings in `dist/`,
     *    so the bare file name is what is wanted. Stylesheets are emitted as URLs (not CSS chunks) and
     *    already come out as `./form.css`; only `type: 'asset'` on an HTML host is rewritten here, and
     *    the form has no other assets.
     */
    renderBuiltUrl(
      filename: string,
      { hostType, type }: { hostType: string; type: string },
    ): string | undefined {
      const icon = /\/(?:public\/)?icons\/[^/]+$/.exec(filename);
      if (icon !== null) return hostType === 'html' ? `.${icon[0]}` : icon[0];

      if (hostType === 'html' && type === 'asset') {
        return `./${filename.replace(/^.*\//, '')}`;
      }

      return undefined;
    },
  },
  build: {
    // `emptyOutDir` lives on the content pass (it always runs first); this pass only adds to
    // `dist/`, so it must never clear it.
    emptyOutDir: false,
    // Resolved against `root` (`src/`), so `../dist` is the project's `dist/`.
    outDir: '../dist',
    rollupOptions: {
      input: {
        form: 'form/form.html',
        'service-worker': 'background/service-worker.ts',
      },
      output: {
        format: 'es',
        // The form document is deliberately flat: the HTML sits next to the JS/CSS it references and
        // next to the shared protocol chunk if Rolldown decides to hoist one.
        entryFileNames: '[name].js',
        chunkFileNames: '[name].js',
        assetFileNames: (assetInfo: AssetFileNameInfo) => {
          const name = assetInfo.names[0] ?? 'asset';
          // Stylesheets keep literal names; anything else keeps a readable, non-hashed name too, so
          // nothing can silently break a literal reference.
          return /\.css$/.test(name) ? '[name].css' : '[name][extname]';
        },
      },
    },
  },
  plugins: [
    /**
     * Assemble the extension's static files into `dist/`.
     *
     * This pass is rooted at `src/` (see `root` above), so every path derived from `root` lands in the
     * wrong place: Vite's own `publicDir` copy would write beside the sources, and copy plugins resolve
     * their `dest` against the config root too. The two static inputs are therefore copied here with
     * paths computed explicitly — source `<root>/../public`, destination `<root>/<outDir>`.
     *
     * One emitted file also needs relocating: Rolldown mirrors the HTML entry's directory and writes
     * `dist/form/form.html`, but every reference is the bare `form.html` (`web_accessible_resources`,
     * `chrome.runtime.getURL('form.html')`). Its script/style tags are already flat (`./form.js`,
     * `./form.css`), so moving the document up leaves those correct.
     *
     * `apply: 'build'` keeps this out of `vite serve`, where there is no `dist/` to assemble.
     */
    {
      name: 'credentials-assemble',
      apply: 'build',
      async writeBundle(this: WriteBundleContext): Promise<void> {
        // Builtins are reached through `process.getBuiltinModule` rather than `import 'node:*'` so
        // this file typechecks without `@types/node` (the dependency budget is fixed at four devDeps).
        const nodeProcess = (globalThis as unknown as { process: NodeProcess }).process;
        const { cp, mkdir, rm } = nodeProcess.getBuiltinModule('node:fs/promises');
        const { join, resolve } = nodeProcess.getBuiltinModule('node:path');

        const { root, build } = this.environment.config;
        // Both absolute: Vite resolves `root`, and `outDir` is relative to it (`src` + `../dist`).
        const outDir = resolve(root, build.outDir);
        const publicDir = resolve(root, '..', 'public');
        const overwrite = { recursive: true, force: true } as const;

        // 1. `public/manifest.json` and `public/icons/` → `dist/`, exactly the paths the manifest and
        //    `web_accessible_resources` name.
        await mkdir(join(outDir, 'icons'), { recursive: true });
        await cp(join(publicDir, 'manifest.json'), join(outDir, 'manifest.json'), overwrite);
        await cp(join(publicDir, 'icons'), join(outDir, 'icons'), overwrite);

        // 2. `dist/form/form.html` → `dist/form.html`.
        await cp(join(outDir, 'form', 'form.html'), join(outDir, 'form.html'), overwrite);
        await rm(join(outDir, 'form'), overwrite);
      },
    },
  ],
};

/**
 * Vite 8 accepts one config object, not an array, so the two passes are selected by `--mode`:
 *
 *   `vite build --mode content` → pass 1 (must run first; it clears `dist/`)
 *   `vite build`               → pass 2 (the default: application + manifest + icons)
 *
 * `npm run build` runs both, in order, via `scripts/build.mjs`. Because the selection is a function
 * of the mode rather than a mutable named export, one pass can never inherit the other's inputs.
 */
export default defineConfig(({ mode }: ConfigEnv): UserConfig => {
  return mode === 'content' ? contentConfig : appConfig;
});

/**
 * How Chromium is told to rasterize, in ONE place.
 *
 * The pre-encode RGBA hash depends on the rasterization backend. Measured on
 * fixtures/basic, same code and same project:
 *
 *   GPU          10a05a330f3524ce778280311bb390972c2e5ba4ae313bd437e6068839a1e936
 *   swiftshader  bc03e397e8629bcb306860652830fa314d10f1ab6b404bc75f8b9d9af5b8cb79
 *
 * `composite()` draws to a canvas and the pixels are Chromium's to produce, so
 * the determinism this repo gates on holds WITHIN a backend, not across two.
 * Every gate compares inside a single browser and is unaffected. A test that
 * compares ACROSS engines — the app's Electron against the CLI's Chrome — is
 * asserting something the codebase does not control unless both are pinned.
 *
 * That is not hypothetical: app/test/export-identity.slow.test.ts passed here
 * for weeks and failed on its first CI run with exactly the two hashes above,
 * because Electron went software and Chrome went GPU.
 *
 * Software is the pin, because it is the backend every environment can provide.
 * Two copies of this list is how the two sides drift back apart, which is why
 * it lives here and transform/test/render-backend.test.ts refuses a copy.
 */
export const SOFTWARE_RENDER_ARGS = [
  "--disable-gpu",
  "--disable-software-rasterizer",
  "--use-gl=swiftshader",
];

/** Set by a caller that needs two engines to agree; unset, a gate runs however the machine prefers. */
export const forceSoftwareRender = () => Boolean(process.env.STC_FORCE_SOFTWARE_RENDER);

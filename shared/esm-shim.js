/**
 * shared/esm-shim.js
 * ------------------------------------------------------------------
 * Tiny shim so the browser can `import` the CommonJS `shared/config.js`.
 *
 * Strategy: load shared/config.js as a classic script first (from HTML,
 * BEFORE this module runs). That script attaches the config to
 * `globalThis.__CITYFALL_CONFIG`. This ESM module then re-exports it as a
 * named `CONFIG` export, so client modules can write:
 *
 *     import { CONFIG } from '../shared/esm-shim.js';
 *
 * and the same `shared/config.js` is still require()-able on the server.
 * One source of truth, no build step.
 * ------------------------------------------------------------------
 */

const CONFIG = (typeof globalThis !== 'undefined' && globalThis.__CITYFALL_CONFIG) || {};

export { CONFIG };
export default CONFIG;

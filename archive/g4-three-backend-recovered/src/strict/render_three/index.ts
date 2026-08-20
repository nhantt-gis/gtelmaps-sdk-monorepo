import {setRenderBackendFactory} from '../../render/backend_registry';

import {ThreeBackend} from './three_backend';

/**
 * The library, with the Three.js backend installed.
 *
 * ## Why this is a separate entry and not a flag on the main one
 *
 * `src/index.ts` may not import `src/strict/` — `tsconfig.legacy.json` enforces
 * it, and it rejected the first attempt with `TS6307`. That rule is what keeps
 * the ported upstream tier rebasable and the strict tier optional, so the fix is
 * a second entry rather than a hole in the rule.
 *
 * The direction here is the legal one: strict imports legacy. Everything the
 * main entry exports is re-exported, so a page loading this bundle gets the same
 * API with a different renderer underneath.
 *
 * ## What this buys the migration
 *
 * A **control**. The render suite can run twice against the same 1560 fixtures —
 * once on the stock bundle, once on this one — and the difference between the
 * two numbers is the entire effect of the backend swap. Building the Three
 * backend into the shipping bundle instead would have removed the control and
 * grown `dist/gtelmaps-gl.js` by the whole of Three.js for a backend that, at
 * G4-1, draws nothing.
 *
 * When the migration finishes and Three is the only renderer, this file goes
 * away and the installation moves into `src/index.ts`.
 */
setRenderBackendFactory((gl, transform) => new ThreeBackend(gl, transform));

export * from '../../index';
export {ThreeBackend};

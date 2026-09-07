// The zoom ranges the tilesets are built over, and why each one stops where it does.

/**
 * The finest zoom anything static is built to.
 *
 * The demo is inspected at z18.85, and overzooming a z14 tile that far quantises
 * every coordinate to 0.29 m — 0.88 screen pixels there. At z16 the same figure
 * is 0.073 m, a fifth of a pixel.
 */
export const MAX_ZOOM = 16;

/** Carpets are district-sized and worth reading from far out. */
export const GROUND_MIN_ZOOM = 8;

/** Everything drawn above the ground only starts mattering at estate scale. */
export const RAISED_MIN_ZOOM = 10;

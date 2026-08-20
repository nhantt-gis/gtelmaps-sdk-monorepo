/**
 * Resolves a constant pattern's atlas rectangles, faithfully to
 * `src/render/update_pattern_positions_in_program.ts`.
 *
 * ## Why this is not a lookup
 *
 * A `fill-pattern` transitions between two images, `from` and `to`, and the
 * shader needs both rectangles plus their pixel ratios. The obvious version is
 * two dictionary lookups. It is wrong in a way that only appears at a moment
 * nobody tests by hand.
 *
 * `tile.imageAtlas` is rebuilt by the worker. During a pattern transition there
 * are frames where the atlas already holds only the *new* image while the render
 * code is still asking for the previous one, so one or both lookups miss. Upstream
 * carries two fallbacks for it — and the bug that motivated them was not a blank
 * pattern but a **wrong pixel ratio**: with the positions unresolved,
 * `setConstantPatternPositions` never ran and the ratio silently stayed at its
 * default of 1, ignoring whatever `map.addImage` was given
 * (maplibre-gl-js#3377, and the note on the upstream helper).
 *
 * That is the failure mode this file exists to preserve: not an error, not a
 * missing pattern, just a pattern at the wrong scale for a few frames. Porting
 * the happy path alone would look correct in every still frame.
 */

/** The atlas entry shape this needs, without depending on `ImagePosition`. */
export type PatternPosition = {
    tlbr: Array<number>;
    pixelRatio: number;
};

export type ResolvedPatternPositions = {
    from: PatternPosition;
    to: PatternPosition;
};

/**
 * @param positions - `tile.imageAtlas.patternPositions`.
 * @param pattern - the evaluated constant `CrossFaded<ResolvedImage>`.
 * @param declaredValue - `layer.getPaintProperty('fill-pattern')`, used only by
 * the second fallback below.
 * @returns both positions, or `null` when the atlas cannot supply them and the
 * caller must skip the tile this frame.
 */
export function resolvePatternPositions(
    positions: Record<string, PatternPosition> | null | undefined,
    pattern: {from: {toString(): string}; to: {toString(): string}} | null | undefined,
    declaredValue: string | null | undefined,
): ResolvedPatternPositions | null {
    if (!pattern || !positions) return null;

    let to: PatternPosition | undefined = positions[pattern.to.toString()];
    let from: PatternPosition | undefined = positions[pattern.from.toString()];

    // One side present is enough: during a transition the atlas may hold only
    // the image being moved to, or only the one being moved from. Using it for
    // both renders a still pattern rather than none.
    if (!to && from) to = from;
    if (!from && to) from = to;

    // Both missing: the worker has replaced the atlas wholesale, and the names
    // the evaluated value carries no longer appear in it. The style's declared
    // value is the one name that survives that swap.
    if (!to || !from) {
        const transitioned = declaredValue ? positions[declaredValue] : undefined;
        to = transitioned;
        from = transitioned;
    }

    if (!to || !from) return null;
    return {from, to};
}

/**
 * Writes the atlas rectangles into uniforms, for a **constant** pattern only.
 *
 * A per-feature pattern carries the same four values as vertex attributes, and
 * the corresponding uniforms are not declared at all — writing them would throw
 * on the missing slot rather than fail quietly, which is the better of the two
 * but still worth not doing.
 *
 * Shared by `fill-pattern` and `line-pattern`: the two shaders locate their
 * samples completely differently, but the four values and their names are the
 * same, because both come from the same `CrossFadedPatternBinder`.
 */
export function setConstantPatternUniforms(
    material: {uniforms: Record<string, {value: any}>},
    binders: ReadonlyArray<{name: string; kind: string}>,
    positions: ResolvedPatternPositions,
): void {
    if (binders.find((binder) => binder.name === 'pattern_from')?.kind !== 'uniform') return;

    material.uniforms.u_pattern_from.value.fromArray(positions.from.tlbr);
    material.uniforms.u_pattern_to.value.fromArray(positions.to.tlbr);
    material.uniforms.u_pixel_ratio_from.value = positions.from.pixelRatio;
    material.uniforms.u_pixel_ratio_to.value = positions.to.pixelRatio;
}

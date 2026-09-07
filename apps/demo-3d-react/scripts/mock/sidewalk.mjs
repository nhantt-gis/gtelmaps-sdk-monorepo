// Đẩy tuyến người đi bộ từ tim đường ra vỉa hè.
//
// Đi trên đường thì không vô lý về hình học nhưng vô lý về đời sống: người đi bộ
// đi trên vỉa hè. Và `base/landuses.geojson` **có** vỉa hè — 238 MultiPolygon
// `subclass_code: 'sidewalk'` — nên khoảng lệch không phải do đoán mà đo được.
//
// Ba con số đo trên 3.596 đoạn đường:
//
//   · tim đường nằm trong vỉa hè: 45 đoạn. Vỉa hè nằm CẠNH đường, không phủ lên.
//   · mép trong của vỉa hè cách tim: trung vị 4 m (p25 3,5 · p75 6).
//   · mỗi bên chỉ có vỉa hè ở ~57% số đoạn (2.043 và 2.040 trên 3.596).
//
// Con số thứ ba định hình cách làm: không thể "mỗi đỉnh nhảy sang bên nào có vỉa
// hè", vì thế là người đi bộ băng qua đường vài lần một tuyến. Mỗi tuyến chọn
// **một** bên và **một** khoảng lệch, tìm bằng cách thử và giữ cái phủ vỉa hè
// nhiều nhất. Đường song song thì trông ra một vỉa hè; đường nhảy bên thì không.

import {bisectors, densify, offsetPath, shift} from './geometry.mjs';

/** Thử từ mép trong ra: 3 m là còn trên mặt đường, quá 7 m là qua bên kia vỉa hè. */
const OFFSETS = [3.5, 4, 4.5, 5, 5.5, 6, 6.5, 7];

/**
 * Chia nhỏ đoạn dài trước khi dời, mét.
 *
 * Không phải để đường mượt hơn — đường thẳng vẫn thẳng — mà vì mọi phép ở đây
 * làm việc **trên đỉnh**. Tuyến thứ ba chỉ có 3 đỉnh cho 990 m, và cả ba rơi
 * đúng vào ngã tư nơi vỉa hè hở ra, nên nó đo được 0% phủ trong khi thực tế cả
 * hai đoạn của nó đều có vỉa hè hai bên.
 *
 * 20 m, và **dày hơn thì tệ hơn** — điều này không đoán ra được. Đo trên ba
 * tuyến, phủ vỉa hè và cỡ feed:
 *
 *   8 m → 92/75/94 %, 656 KB      20 m → 97/78/94 %, 302 KB
 *  12 m → 94/76/94 %, 459 KB      30 m → 97/71/91 %, 230 KB
 *
 * Chia dày thì đỉnh mới rơi vào đúng những chỗ vỉa hè hở ra ở ngã tư, và mỗi
 * đỉnh như thế là một điểm trượt. 20 m đủ thưa để bước qua chỗ hở, đủ dày để bám
 * mép vỉa hè.
 */
const DENSIFY_M = 20;

/** Coi là "cũng tốt như nhau" nếu độ phủ chỉ kém cái tốt nhất chừng này. */
const NEAR_BEST = 0.03;

/** Dải dò khi một đỉnh trượt khỏi vỉa hè: vỉa hè không rộng đều suốt tuyến. */
const SEEK_MIN = 2.5;
const SEEK_MAX = 9;
const SEEK_STEP = 0.25;

export function sidewalks(read) {
    const polys = [];
    for (const feature of read('base/landuses.geojson').features) {
        if (feature.properties.subclass_code !== 'sidewalk') continue;
        const parts = feature.geometry.type === 'MultiPolygon'
            ? feature.geometry.coordinates : [feature.geometry.coordinates];
        for (const rings of parts) {
            let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
            for (const [x, y] of rings[0]) {
                minX = Math.min(minX, x); minY = Math.min(minY, y);
                maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
            }
            polys.push({rings, minX, minY, maxX, maxY});
        }
    }
    return polys;
}

const inRing = (point, ring) => {
    let inside = false;
    for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
        const [xi, yi] = ring[i];
        const [xj, yj] = ring[j];
        if ((yi > point[1]) !== (yj > point[1]) &&
            point[0] < (xj - xi) * (point[1] - yi) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
};

/** Trong vòng ngoài và không rơi vào lỗ. */
export function onSidewalk(point, polys) {
    for (const p of polys) {
        if (point[0] < p.minX || point[0] > p.maxX || point[1] < p.minY || point[1] > p.maxY) continue;
        if (!inRing(point, p.rings[0])) continue;
        let hole = false;
        for (let k = 1; k < p.rings.length; k++) if (inRing(point, p.rings[k])) { hole = true; break; }
        if (!hole) return true;
    }
    return false;
}

/**
 * Đường song song với `path`, lệch `distance` mét về một bên.
 *
 * Dời từng đỉnh theo **phân giác** của hai đoạn kề, không theo pháp tuyến của
 * một đoạn: dời theo pháp tuyến thì ở mỗi khúc cua hai đoạn lệch ra hai chỗ khác
 * nhau và đường đứt quãng.
 */



/**
 * Tuyến đã dời ra vỉa hè, chọn bên và khoảng lệch theo chính dữ liệu.
 *
 * Trả về `{path, side, distance, covered}` — `covered` là tỉ lệ đỉnh thật sự
 * nằm trong một polygon vỉa hè, để chỗ gọi in ra thay vì tin lời.
 */
export function toSidewalk(centreline, polys, lane = 0) {
    const path = densify(centreline, DENSIFY_M);
    const candidates = [];
    for (const side of [1, -1]) {
        for (const distance of OFFSETS) {
            const moved = offsetPath(path, side, distance);
            const covered = moved.filter((p) => onSidewalk(p, polys)).length / moved.length;
            candidates.push({path: moved, side, distance, covered});
        }
    }
    candidates.sort((a, b) => b.covered - a.covered);

    // Không lấy thẳng cái tốt nhất: nhiều tuyến đi chung một vỉa hè, và nếu tuyến
    // nào cũng chọn đúng một khoảng lệch thì người của chúng đi đè lên nhau. Vỉa
    // hè rộng vài mét, đủ chỗ cho vài lối. Trong nhóm gần bằng nhau về độ phủ,
    // mỗi tuyến lấy một lối theo chỉ số của mình.
    const equals = candidates.filter((c) => c.covered >= candidates[0].covered - NEAR_BEST);
    let best = equals.length ? equals[lane % equals.length] : candidates[0];
    if (best.covered === 0) best = {path, side: 0, distance: 0, covered: 0};
    if (best.side === 0) return best;

    // Vỉa hè không rộng đều suốt tuyến: một khoảng lệch cứng đúng ở đoạn này thì
    // trượt ra lòng đường ở đoạn kia. Đỉnh nào trượt thì dò dọc **cùng một** phân
    // giác, nên nó chỉ nhích ngang chứ không đổi bên — người đi bộ bám mép vỉa
    // hè, không băng qua đường.
    const vertices = bisectors(path);
    const tracked = vertices.map((v, i) => {
        if (onSidewalk(best.path[i], polys)) return best.path[i];
        for (let d = SEEK_MIN; d <= SEEK_MAX; d += SEEK_STEP) {
            const candidate = shift(v, best.side, d);
            if (onSidewalk(candidate, polys)) return candidate;
        }
        return best.path[i];
    });
    return {
        ...best,
        path: tracked,
        covered: tracked.filter((p) => onSidewalk(p, polys)).length / tracked.length,
    };
}

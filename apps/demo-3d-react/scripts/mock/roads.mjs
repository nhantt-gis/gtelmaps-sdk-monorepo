// Đưa người đi bộ về đúng mạng đường.
//
// Bản trước cắt tuyến ở bức tường đầu tiên nó gặp, và nó chữa sai bệnh: tuyến
// thôi *đâm vào* nhà nhưng vẫn cắt ngang lô đất và bãi trống, vì hình dạng gốc
// trong `employee-tracks.geojson` là một vài đỉnh nối thẳng chứ không bám đường.
//
// Ở đây tuyến được **dựng lại** trên `base/roads.geojson`: neo hai đầu vào nút
// gần nhất rồi tìm đường ngắn nhất. Đo được trên chính bộ đường ấy — 4.003 đoạn,
// **0 đoạn nào cắt qua footprint** — nên đi trên đường là đủ để không vào nhà,
// và không cần thêm một phép chắn thứ hai.
//
// Mạng đủ liền để làm việc này: 3.787 nút, 4 thành phần, thành phần lớn nhất giữ
// 87% số nút. Toạ độ trùng khít tới 6 chữ số ở chỗ hai đường gặp nhau, nên khoá
// nút là chính toạ độ, không cần dung sai.

import {LAT_M, LON_M, lengthOf, metres} from './geometry.mjs';
import {onSidewalk} from './sidewalk.mjs';

const key = (c) => `${c[0].toFixed(6)},${c[1].toFixed(6)}`;

/**
 * Đường không có vỉa hè đắt gấp bốn lần.
 *
 * Không phải cấm — cấm thì một toà nhà chỉ tới được bằng đường trần sẽ không tới
 * được nữa. Phạt thì người đi bộ đi vòng qua phố có vỉa hè khi có đường vòng hợp
 * lý, và chỉ bước xuống đường trần khi không còn cách nào. Bốn lần là đủ để một
 * đường vòng dài gấp ba vẫn thắng.
 */
const NO_PAVEMENT_PENALTY = 4;

/** Khoảng lệch để dò vỉa hè hai bên; đo được: mép trong cách tim trung vị 4 m. */
const PROBE_M = [4, 5.5, 7];

/** Cạnh này có vỉa hè bên nào không. Dò ở điểm giữa, cả hai bên. */
function hasPavement(a, b, pavements) {
    const dx = (b[0] - a[0]) * LON_M;
    const dy = (b[1] - a[1]) * LAT_M;
    const len = Math.hypot(dx, dy);
    if (len < 0.5) return true;
    const nx = -dy / len;
    const ny = dx / len;
    const mid = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2];
    for (const side of [1, -1]) {
        for (const d of PROBE_M) {
            if (onSidewalk([mid[0] + side * nx * d / LON_M, mid[1] + side * ny * d / LAT_M], pavements)) return true;
        }
    }
    return false;
}

/**
 * Đồ thị vô hướng: nút là đỉnh đường, cạnh là đoạn giữa hai đỉnh liền nhau.
 *
 * Trọng số là mét **đã phạt**, không phải mét thật: xem `NO_PAVEMENT_PENALTY`.
 */
export function roadGraph(read, pavements) {
    const at = new Map();
    const adj = new Map();
    // Hai trọng số trên mỗi cạnh: `cost` đã phạt, dùng cho người đi bộ; `span`
    // là mét thật, dùng cho xe. Xe đi đường không vỉa hè là chuyện bình thường.
    const link = (a, b, cost, span) => {
        if (!adj.has(a)) adj.set(a, []);
        adj.get(a).push([b, cost, span]);
    };

    for (const road of read('base/roads.geojson').features) {
        for (const strand of road.geometry.coordinates) {
            for (let i = 1; i < strand.length; i++) {
                const a = key(strand[i - 1]);
                const b = key(strand[i]);
                if (a === b) continue;
                at.set(a, strand[i - 1]);
                at.set(b, strand[i]);
                const span = metres(strand[i - 1], strand[i]);
                const cost = span *
                    (hasPavement(strand[i - 1], strand[i], pavements) ? 1 : NO_PAVEMENT_PENALTY);
                link(a, b, cost, span);
                link(b, a, cost, span);
            }
        }
    }
    return {at, adj};
}

/** Nút gần một điểm nhất. Quét thẳng 3.787 nút — ba lần cho cả bộ dữ liệu. */
function nearest(graph, point) {
    let best = null;
    let bestD = Infinity;
    for (const [k, c] of graph.at) {
        const d = metres(point, c);
        if (d < bestD) { bestD = d; best = k; }
    }
    return best;
}

/**
 * Đường ngắn nhất giữa hai nút, Dijkstra với hàng đợi tuyến tính.
 *
 * O(n²) là cố ý: cả bộ dữ liệu chỉ có **ba** tuyến người, nên phép này chạy ba
 * lần trong một lượt build. Một binary heap ở đây là ba chục dòng để tiết kiệm
 * vài mili giây.
 */
function shortestPath(graph, from, to) {
    const dist = new Map([[from, 0]]);
    const prev = new Map();
    const left = new Set(graph.at.keys());

    while (left.size) {
        let node = null;
        let best = Infinity;
        for (const k of left) {
            const d = dist.get(k);
            if (d !== undefined && d < best) { best = d; node = k; }
        }
        if (node === null) break;
        if (node === to) break;
        left.delete(node);

        for (const [next, w] of graph.adj.get(node) ?? []) {
            if (!left.has(next)) continue;
            const d = best + w;
            if (d < (dist.get(next) ?? Infinity)) { dist.set(next, d); prev.set(next, node); }
        }
    }

    if (!dist.has(to)) return null;
    const path = [to];
    while (path[0] !== from) {
        const p = prev.get(path[0]);
        if (!p) return null;
        path.unshift(p);
    }
    return path.map((k) => graph.at.get(k));
}

/**
 * Tuyến đi bộ trên đường, giữa hai đầu của hình dạng gốc.
 *
 * Giữ lại **ý định** của dữ liệu gốc — đi từ đâu tới đâu — và vứt đường nối
 * thẳng giữa chúng. Đầu cuối của tuyến gốc nằm trong một toà nhà, nên nút gần
 * nhất với nó là đoạn đường chạy trước cửa toà ấy: người đi bộ đi dọc đường tới
 * trước cửa rồi quay lại, thay vì cắt chéo qua sân.
 */
export function walkOnRoads(graph, geometry) {
    const strands = geometry.type === 'MultiLineString' ? geometry.coordinates : [geometry.coordinates];
    let longest = [];
    for (const strand of strands) if (strand.length > longest.length) longest = strand;
    if (longest.length < 2) return null;

    const from = nearest(graph, longest[0]);
    const to = nearest(graph, longest[longest.length - 1]);
    if (!from || !to || from === to) return null;
    return shortestPath(graph, from, to);
}

/**
 * Sinh tuyến trải khắp mạng đường, tất định.
 *
 * Vì sao cần: bộ dữ liệu gốc chỉ có **22** tuyến xe cho **100** chiếc, tức 4–5
 * chiếc chạy trên cùng một đường vẽ. Đo được lúc ấy — 19 cặp xe cách nhau dưới
 * 8 m, cặp gần nhất **0,1 m**, tức chồng đúng lên nhau — trong khi cả đội chỉ
 * dùng **3,8%** của 170 km đường.
 *
 * Đi bộ ngẫu nhiên chứ không phải đường ngắn nhất, và đó là lựa chọn chứ không
 * phải lối tắt: đường ngắn nhất giữa những cặp điểm ngẫu nhiên dồn hết lên vài
 * trục chính, đúng cái đang muốn tránh. Xe thật cũng không đi đường tối ưu.
 *
 * Ưu tiên cạnh **ít được dùng nhất** ở mỗi bước, nên các tuyến tự đẩy nhau ra
 * thay vì chồng lên nhau.
 *
 * Và **không đi lại cạnh của chính mình**. Đây là chỗ đã trả giá: một tuyến quay
 * lại con đường nó vừa đi thì hai xe của chính nó gặp nhau ở cùng một điểm, cùng
 * chiều — và vì cùng tuyến thì cùng tốc độ, chúng khoá cứng vào nhau và đi cạnh
 * nhau mãi. Đo được trước khi cấm: 12 cặp dính trên 20 giây, **9 trong số đó là
 * hai xe cùng tuyến**, cặp lâu nhất 74 giây.
 */

/** PRNG tất định — cùng dữ liệu thì cùng tuyến, build lại không đổi feed. */
function mulberry32(seed) {
    return () => {
        seed = (seed + 0x6d2b79f5) | 0;
        let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

const edgeKey = (a, b) => (a < b ? `${a}|${b}` : `${b}|${a}`);

/**
 * Tuyến có tự chạy sát cạnh chính nó, cùng chiều, không.
 *
 * Đây là chỗ đã trả giá: tuyến 45 dài 1854 m đi ra rồi vòng lại một con đường
 * song song cách 3 m, nên **bốn xe liền kề** của nó — cách nhau 309 m dọc tuyến,
 * cùng tốc độ vì cùng tuyến — đi cạnh nhau suốt 26–46 giây. Không phải xe rải
 * sai; là tuyến tự chồng lên chính nó.
 *
 * Chỉ xét cặp đỉnh cách nhau xa dọc tuyến: gần nhau dọc tuyến thì tất nhiên gần
 * nhau ngoài thực địa, đó là hai đỉnh liên tiếp của một con đường.
 */
const SELF_ALONG_M = 100;
const SELF_CLEAR_M = 8;

function runsBesideItself(path) {
    const along = [0];
    for (let i = 1; i < path.length; i++) along.push(along[i - 1] + metres(path[i - 1], path[i]));
    for (let i = 0; i < path.length; i++) {
        for (let j = i + 1; j < path.length; j++) {
            if (along[j] - along[i] < SELF_ALONG_M) continue;
            if (metres(path[i], path[j]) < SELF_CLEAR_M) return true;
        }
    }
    return false;
}

export function spreadRoutes(graph, count, {minLength, maxLength, seed = 1}) {
    const nodes = [...graph.at.keys()];
    const rand = mulberry32(seed);
    const usage = new Map();
    const routes = [];

    for (let attempt = 0; routes.length < count && attempt < count * 40; attempt++) {
        const target = minLength + rand() * (maxLength - minLength);
        let node = nodes[Math.floor(rand() * nodes.length)];
        let previous = null;
        let span = 0;
        const path = [graph.at.get(node)];

        const mine = new Set();
        while (span < target) {
            const all = graph.adj.get(node) ?? [];
            const forward = all.filter(([n]) => n !== previous);
            const choices = forward.length ? forward : all;
            if (choices.length === 0) break;

            let least = Infinity;
            for (const [n] of choices) least = Math.min(least, usage.get(edgeKey(node, n)) ?? 0);
            const fresh = choices.filter(([n]) => (usage.get(edgeKey(node, n)) ?? 0) === least);
            const [next, , step] = fresh[Math.floor(rand() * fresh.length)];

            usage.set(edgeKey(node, next), least + 1);
            mine.add(edgeKey(node, next));
            previous = node;
            node = next;
            span += step;
            path.push(graph.at.get(node));
        }

        if (span >= minLength && path.length >= 2 && !runsBesideItself(path)) routes.push(path);
    }
    return routes;
}

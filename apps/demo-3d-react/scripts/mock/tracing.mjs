// Truy vết hành trình xe — dataset thứ hai KHÔNG phải tileset, cùng lý do với
// `movers.mjs`: trong sản phẩm thật đây là câu trả lời của một API ("cho tôi
// hành trình của biển số này"), nạp bằng `addSource`/`addLayer` lúc chạy chứ
// không nằm trong style của bản đồ nền. Đổi sang endpoint thật là đổi mỗi URL.
//
// Cũng như ở đó, không có xentimét nguyên: feed đi thẳng qua `JSON.parse`, không
// qua tippecanoe, nên số lẻ tới nơi nguyên vẹn.
//
// Hai file ra, vì chúng phục vụ hai câu hỏi khác nhau:
//
//   traces.geojson    tuyến đã ghép — hình học, để vẽ dải sáng và để cái xe chạy
//   trace-legs.json   bảng chặng    — thuộc tính, để dựng danh sách và để tua
//
// Tách ra chứ không nhét chặng vào `properties` của tuyến, bởi bảng chặng đi qua
// một layer `model-3d` thì chẳng để làm gì, còn tuyến thì phải đi qua đó.

import {mkdirSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {lines, parts, points} from '../lib/geojson.mjs';

/**
 * Mét trên một độ, phẳng — CHÍNH XÁC công thức đã sinh ra `trace_distance_m`
 * (`3d-plugins/scripts/enrich-vehicle-trace.mjs`, hàm `meters`).
 *
 * Không phải chuyện làm tròn: đo cùng tuyến ấy bằng Mercator quanh gốc cảnh (thứ
 * `CoordinateSystem` của plugin dùng lúc chạy) ra dài hơn 13–16 m mỗi tuyến, tức
 * lệch 4‰. Cổng ±2 m dưới đây bắt được ngay, và nó bắt đúng: mốc phải trùng với
 * cái thước đã khắc ra dữ liệu, không phải với một cái thước khác cũng đúng.
 */
const M_PER_DEG_LAT = 110540;
const M_PER_DEG_LNG_AT_EQUATOR = 111320;

function meters(a, b) {
    const midLatRad = ((a[1] + b[1]) / 2) * Math.PI / 180;
    const lngM = M_PER_DEG_LNG_AT_EQUATOR * Math.cos(midLatRad);
    return Math.hypot((a[0] - b[0]) * lngM, (a[1] - b[1]) * M_PER_DEG_LAT);
}

/** Khoảng hở lớn nhất còn coi là "hai đoạn nối nhau" (m). */
const JOIN_MAX_M = 25;
/** Dưới ngưỡng này hai đầu là MỘT đỉnh — nối vào thì bỏ bản sao (m). */
const WELD_M = 0.5;

/** Tổng chiều dài một chuỗi toạ độ (m). */
function lengthOf(chain) {
    let total = 0;
    for (let i = 1; i < chain.length; i++) total += meters(chain[i], chain[i - 1]);
    return total;
}

/** Đoạn rời chưa dùng có đầu gần `point` nhất, kèm hướng cần lật. */
function nearestFree(segments, used, point) {
    let best = -1;
    let atEnd = false;
    let bestD = JOIN_MAX_M;
    for (let j = 0; j < segments.length; j++) {
        if (used[j]) continue;
        const seg = segments[j];
        const dStart = meters(point, seg[0]);
        const dEnd = meters(point, seg[seg.length - 1]);
        if (dStart < bestD) [bestD, best, atEnd] = [dStart, j, false];
        if (dEnd < bestD) [bestD, best, atEnd] = [dEnd, j, true];
    }
    return {best, atEnd};
}

/**
 * Ghép các đoạn rời của một biển số thành MỘT tuyến liền, mọc greedy về **cả hai
 * đầu**: thử nối vào cuối trước, hết thì nối vào đầu.
 *
 * Chỉ mọc về phía cuối (như `buildChainedRoute` của plugin) là không đủ, và cái
 * giá đo được: đoạn đầu tiên của biển số 99L-557.63 nằm giữa tuyến, nên chuỗi
 * chỉ-nối-đuôi phải nhảy thẳng qua những đoạn nằm phía trước nó — 3661 m tuyến
 * thật thành 6222 m, hơn 2,5 km là đường thẳng cắt ngang khu công nghiệp.
 *
 * `JOIN_MAX_M` là phần còn lại của cùng một ý: một đoạn cách mọi đầu mút hơn 25 m
 * KHÔNG được hàn vào bằng một đường thẳng — nó là con đường khác. Thà bỏ nó (và
 * để cổng đo báo tuyến ngắn hơn `trace_distance_m`) còn hơn bịa ra quãng đường.
 */
function chainSegments(segments) {
    const used = segments.map(() => false);
    used[0] = true;
    let chain = segments[0].slice();

    for (;;) {
        const tail = nearestFree(segments, used, chain[chain.length - 1]);
        if (tail.best >= 0) {
            used[tail.best] = true;
            const seg = tail.atEnd ? segments[tail.best].slice().reverse() : segments[tail.best];
            const skip = meters(chain[chain.length - 1], seg[0]) < WELD_M ? 1 : 0;
            chain = chain.concat(seg.slice(skip));
            continue;
        }
        const head = nearestFree(segments, used, chain[0]);
        if (head.best < 0) return chain;
        used[head.best] = true;
        // Nối vào đầu thì đoạn phải KẾT THÚC tại đầu chuỗi — ngược chiều với lúc nối đuôi.
        const seg = head.atEnd ? segments[head.best] : segments[head.best].slice().reverse();
        const drop = meters(chain[0], seg[seg.length - 1]) < WELD_M ? 1 : 0;
        chain = seg.slice(0, seg.length - drop).concat(chain);
    }
}

/**
 * Quay tuyến sao cho nó BẮT ĐẦU ở chặng 1.
 *
 * Ghép greedy cho ra đúng hình học nhưng không nói gì về chiều — chiều là do
 * đoạn nào tình cờ đứng đầu file quyết định. Đo trên bộ dữ liệu này: 1 trong 4
 * tuyến (72C-551.07) ra ngược, hai đầu cách chặng 1 tới 2263 m.
 *
 * Và chiều là tất cả, bởi `trace_distance_m` là quãng đường cộng dồn TỪ chặng 1.
 * Tuyến ngược thì tua tới mốc d đưa cái xe tới `tổng − d`: mọi chặng vẫn nằm trên
 * đường, chỉ sai chỗ — một lỗi không hề lộ ra ở cổng đo độ dài.
 */
function orientFromFirstLeg(chain, legs) {
    const first = legs[0];
    if (!first) return chain;
    const start = [first.lng, first.lat];
    return meters(chain[0], start) <= meters(chain[chain.length - 1], start) ? chain : chain.slice().reverse();
}

/** Gom theo biển số, giữ thứ tự xuất hiện trong file nguồn. */
function groupByPlate(features) {
    const groups = new Map();
    for (const f of features) {
        const plate = f.properties?.license_plate;
        if (!plate) continue;
        const group = groups.get(plate) ?? {plate, route: String(f.properties.route ?? ''), segments: []};
        group.segments.push(...parts(f));
        groups.set(plate, group);
    }
    return [...groups.values()];
}

/** Các thuộc tính của một chặng mà bảng bên trang cần, không hơn. */
function legOf(feature) {
    const p = feature.properties;
    const [lng, lat] = feature.geometry.coordinates;
    return {
        sequence: Number(p.trace_sequence) || 0,
        name: String(p.name ?? ''),
        camera_code: String(p.camera_code ?? ''),
        distance_m: Number(p.trace_distance_m) || 0,
        capture_time: String(p.capture_time ?? ''),
        direction: String(p.direction ?? ''),
        speed_kmh: Number(p.speed_kmh) || 0,
        ai_confidence: Number(p.ai_confidence) || 0,
        lng,
        lat,
    };
}

/**
 * Tuyến còn dư bao nhiêu trước khi tràn khỏi **tile nhận nó**, tính bằng tile.
 *
 * Phép thử này chặt hơn "có bị geojson-vt cắt không", và chặt hơn là đúng. Chỉ
 * một tile vẽ cái xe — tile chứa đỉnh đầu — vì `model_3d_bucket.ts` bỏ mọi bản
 * sao có anchor ngoài `[0, EXTENT)`, và tile hàng xóm nhận hình tuyến qua vùng
 * đệm thì anchor của bản sao ấy nằm ngoài. Mà một tile chỉ được vẽ khi nó nằm
 * trong khung nhìn. Nên tuyến thò sang tile khác là cái xe **biến mất** khi
 * camera đi theo nó sang bên ấy, dù hình học vẫn còn nguyên.
 *
 * Đo được đúng như vậy: ở `maxzoom 13`, `51C-902.13` thò 0,559 tile và truy vấn
 * tại đích trả về **0 hit**, trong khi `99L-557.63` nằm trọn và trả về 36 hit
 * cách đích 0,14 m.
 *
 * Trả về khoảng dư nhỏ nhất tới cạnh tile. Âm là đã tràn.
 */
function tileMargin(chain, zoom) {
    const n = Math.pow(2, zoom);
    const mercX = (lng) => (180 + lng) / 360;
    const mercY = (lat) => (180 - (180 / Math.PI) *
        Math.log(Math.tan(Math.PI / 4 + lat * Math.PI / 360))) / 360;

    const tileX = Math.floor(mercX(chain[0][0]) * n);
    const tileY = Math.floor(mercY(chain[0][1]) * n);

    let margin = Infinity;
    for (const [lng, lat] of chain) {
        const u = mercX(lng) * n - tileX;
        const v = mercY(lat) * n - tileY;
        margin = Math.min(margin, u, 1 - u, v, 1 - v);
    }
    return margin;
}

/**
 * Tốc độ phát lại của tuyến truy vết, mét mỗi giây.
 *
 * Đúng 1 và điều đó có chủ ý: layer `model-3d` đặt `travelled = route_offset +
 * t × route_speed`, nên ở 1 m/s **mốc thời gian bằng đúng số mét đã đi** —
 * `model-3d-route-time` trở thành `gotoDistance` của bản gốc, không một phép quy
 * đổi nào ở giữa để mà sai.
 *
 * Nhưng **mét của ai** thì phải nói rõ, và đây là chỗ dễ hiểu nhầm nhất của cả
 * file. Cổng đo dưới đây chứng minh `trace_distance_m` là độ dài cung trên tuyến
 * đã ghép **theo thước đã khắc ra nó** (`meters` ở đầu file, thước phẳng của bản
 * gốc). Layer thì đo bằng thước khác: `tileUnitsPerMetre` → Mercator bảo giác
 * trên quả cầu 6371008,8 m. Đo trên chính bốn tuyến này, hai thước lệch
 * 0,27–0,40%, tức mốc của một chặng trôi tới **14,3–16,7 m** — thấy được, vì cái
 * xe dài 5 m.
 *
 * Nên phía client KHÔNG tua bằng `trace_distance_m`: nó chiếu toạ độ chặng lên
 * tuyến rồi đo lại bằng thước của layer (`src/tracing/route.ts`, `distanceAt`).
 * Đo được cả 40 chặng nằm đúng 0,00 m trên tuyến của chúng, nên phép chiếu ấy là
 * chính xác chứ không phải xấp xỉ. `trace_distance_m` ở đây là con số để **hiển
 * thị** và để cổng đo đối chiếu — không phải mốc tua.
 */
const TRACE_SPEED_MPS = 1;

/** Xe bắt đầu ở chặng 1, tức đầu tuyến — không rải như đội xe nền. */
const TRACE_OFFSET_M = 0;

/**
 * Ghi hai feed và trả về bảng đo, một dòng mỗi biển số.
 *
 * Trả về số đo chứ không tự in: cổng đo là việc của người gọi, và một dòng bảng
 * in ở đây thì `build-tiles.mjs` không xếp được vào chỗ của nó.
 */
export function writeTraceFeeds(read, outDir) {
    const junctions = points(read('tracing/vehicle-junctions.geojson'));

    const traces = groupByPlate(lines(read('tracing/vehicle-routes.geojson'))).map((group) => {
        const legs = junctions
            .filter((f) => f.properties?.license_plate === group.plate)
            .map(legOf)
            .sort((a, b) => a.sequence - b.sequence);
        const chain = orientFromFirstLeg(chainSegments(group.segments), legs);
        return {...group, chain, legs, length: lengthOf(chain),
            margin: tileMargin(chain, SOURCE_MAXZOOM)};
    });

    mkdirSync(outDir, {recursive: true});
    writeFileSync(join(outDir, 'traces.geojson'), `${JSON.stringify({
        type: 'FeatureCollection',
        features: traces.map((t) => ({
            type: 'Feature',
            properties: {
                id: `trace-${t.plate}`,
                license_plate: t.plate,
                route: t.route,
                // Milimét trên một tuyến suy từ ảnh camera là nhiễu, không phải số đo.
                total_distance_m: Math.round(t.length * 10) / 10,
                route_speed: TRACE_SPEED_MPS,
                route_offset: TRACE_OFFSET_M,
            },
            geometry: {type: 'LineString', coordinates: t.chain},
        })),
    })}\n`);

    const legTable = {};
    for (const t of traces) legTable[t.plate] = t.legs;
    writeFileSync(join(outDir, 'trace-legs.json'), `${JSON.stringify(legTable)}\n`);

    return traces.map((t) => ({
        plate: t.plate,
        vertices: t.chain.length,
        lengthM: t.length,
        junctionMaxM: t.legs.reduce((max, leg) => Math.max(max, leg.distance_m), 0),
        startGapM: t.legs.length ? meters(t.chain[0], [t.legs[0].lng, t.legs[0].lat]) : Infinity,
        legs: t.legs.length,
        tileMargin: t.margin,
    }));
}

/** Tuyến ghép phải trùng thước đã khắc ra `trace_distance_m` (m). */
const LENGTH_TOLERANCE_M = 2;

/** Phải khớp `maxzoom` của source trong `src/layers/tracing.ts`. Cổng dưới đây giữ chúng khớp. */
const SOURCE_MAXZOOM = 12;

/**
 * Khoảng dư tối thiểu tới cạnh tile nhận tuyến (tile).
 *
 * Ở z12 một tile rộng 9617 m tại vĩ độ này, nên 0,05 tile là khoảng 480 m — đủ
 * để một hành trình dài thêm chút ít không lặng lẽ hỏng. Đo hiện tại: cả bốn dư
 * 0,13–0,22 tile.
 *
 * z12 là mức thấp nhất còn chấp nhận được về độ mịn: toạ độ tile lượng tử hoá ở
 * 1,17 m/đơn vị và sai số độ dài tuyến do làm tròn là 2,51 m (ở z13 là 0,35 m,
 * z14 là 0,18 m). Nhưng z13 làm `51C-902.13` tràn sang tile khác, và một cái xe
 * biến mất thì tệ hơn hẳn một cái xe lệch 2,5 m.
 */
const TILE_MARGIN_MIN = 0.05;

/**
 * Chặng 1 phải nằm ngay đầu tuyến (m).
 *
 * Mốc 0 của `trace_distance_m` là chặng 1, nên đầu tuyến lệch bao nhiêu thì MỌI
 * lần tua lệch đúng bấy nhiêu. Trên bộ dữ liệu này khoảng cách ấy là 0 tròn —
 * điểm chặng là chính một đỉnh của tuyến — nên trần 2 m đã rất rộng tay.
 */
const START_GAP_MAX_M = 2;

/** Ném lỗi nếu một tuyến lệch mốc hoặc quá khổ. Gọi SAU khi đã in bảng đo. */
export function assertTraceGates(rows) {
    const failures = [];
    for (const r of rows) {
        if (r.startGapM > START_GAP_MAX_M) {
            failures.push(`${r.plate}: đầu tuyến cách chặng 1 tới ${r.startGapM.toFixed(1)} m — ` +
                `mốc 0 của trace_distance_m không nằm ở đầu tuyến`);
        }
        const delta = Math.abs(r.lengthM - r.junctionMaxM);
        if (delta > LENGTH_TOLERANCE_M) {
            failures.push(`${r.plate}: tuyến ghép ${r.lengthM.toFixed(1)} m lệch ` +
                `${delta.toFixed(1)} m so với trace_distance_m lớn nhất ${r.junctionMaxM} m`);
        }
        if (r.tileMargin < TILE_MARGIN_MIN) {
            failures.push(`${r.plate}: chỉ còn ${r.tileMargin.toFixed(3)} tile dư trong tile ` +
                `nhận nó ở z${SOURCE_MAXZOOM} (cần ${TILE_MARGIN_MIN}) — tuyến tràn sang ` +
                `tile khác, và cái xe sẽ BIẾN MẤT khi camera đi theo nó sang bên ấy. ` +
                `Hạ maxzoom trong src/layers/tracing.ts, rồi sửa hằng ở đây cho khớp.`);
        }
    }
    if (failures.length) throw new Error(`cổng đo truy vết không đạt:\n  ${failures.join('\n  ')}`);
}

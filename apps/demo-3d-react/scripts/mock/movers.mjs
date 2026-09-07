// Vehicle and employee movements — the one dataset here that is NOT a tileset.
//
// In production these are queried from an API, which answers with GeoJSON, and
// the map adds them with `map.addSource` / `map.addLayer` at runtime. They must
// not be baked into the base map's style: the base map is a published artefact
// with its own cadence, and a fleet's position has nothing to do with it.
//
// This demo has no API, so the same GeoJSON is written to `public/api/` and
// fetched over HTTP. Swapping in a real endpoint is a change of URL and nothing
// else — which is exactly the point of writing it this way rather than inlining
// the data into the bundle.
//
// Nothing is scaled to integers here, unlike everything that goes through
// tippecanoe: JSON carries a double faithfully, and the fractional heights that
// tippecanoe 1.36.0 corrupts (83 of the 100 vehicles, all 100 employees) survive
// a `JSON.parse` untouched.

import {mkdirSync, writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {pick, points} from '../lib/geojson.mjs';
import {lengthOf, offsetPath, round6} from './geometry.mjs';
import {roadGraph, spreadRoutes, walkOnRoads} from './roads.mjs';
import {sidewalks, toSidewalk} from './sidewalk.mjs';

/**
 * Nửa bề rộng làn, mét. Đo được: mép trong vỉa hè cách tim đường trung vị 4 m,
 * nên lòng đường rộng khoảng 8 m và tim làn nằm cách tim đường chừng 2 m.
 */
const LANE_M = 2;

/** Phân giác quay 90° ngược kim đồng hồ, nên −1 là bên **phải** theo chiều đi. */
const RIGHT = -1;

/**
 * Tuyến ngắn hơn thế này bị bỏ. Bộ gốc có 8 tuyến dưới 300 m, ngắn nhất **30 m**
 * — một chiếc xe tải chạy tới lui trên ba chục mét thì không giống giao thông,
 * nó giống một lỗi.
 */
const MIN_ROUTE_M = 300;

/** Dài mục tiêu của tuyến tự sinh, mét. */
const SPREAD_MIN_M = 600;
const SPREAD_MAX_M = 2200;

/** Số tuyến khác nhau cho mỗi hạm đội. */
const VEHICLE_ROUTES = 100;
const EMPLOYEE_ROUTES = 100;

/**
 * Số mover trên mỗi tuyến — con số người ta thật sự nghĩ bằng.
 *
 * Không phải một trần cứng: `*_GAP_M` vẫn chặn ở trên, nên một tuyến quá ngắn
 * chở ít hơn. Đo được với 6 xe/tuyến: tuyến ngắn nhất 623 m còn chứa được 13
 * chiếc, nên không tuyến nào bị chặn.
 */
const VEHICLE_PER_ROUTE = 6;
const EMPLOYEE_PER_ROUTE = 6;

/** Tuyến đi bộ ngắn hơn tuyến xe: người không đi 2 km để giao một gói hàng. */
const WALK_MIN_M = 350;
const WALK_MAX_M = 1100;

/** Sinh dư bấy nhiêu lần rồi giữ những tuyến bám vỉa hè nhất. */
const WALK_OVERDRAW = 3;

/**
 * Dải tốc độ của mỗi hạm đội: nới bao nhiêu quanh giá trị nguồn, và **chặn ở
 * đâu**.
 *
 * Cái chặn mới là phần đáng nói, vì trước đây không có. Bản trước giữ cho các
 * tuyến khác tốc độ bằng cách **cộng dồn** 0,25 m/s cho tới khi không trùng —
 * mà nguồn chỉ có 3 giá trị cho người và 5 cho xe, còn tuyến thì 100 mỗi bên.
 * Cái vòng ấy leo thành một cái thang: đo được **96/100 tuyến người vượt quá
 * tốc độ đi bộ, tới 153 km/h**, và 64 tuyến xe tới 176 km/h.
 *
 * Không phép đo nào của tôi bắt được, vì tôi chỉ đo khoảng cách giữa các mover
 * chứ chưa bao giờ đo tốc độ của chúng — và nghịch lý là tốc độ vô lý làm phép
 * đo khoảng cách **đẹp lên**, vì mọi thứ văng ra khỏi nhau. Nên giờ mỗi lượt
 * build in ra dải tốc độ, và có một cái chặn cứng.
 *
 * Biên độ nới của người rộng hơn của xe, và có lý do đo được: người đi bộ đều
 * quanh 4–6 km/h nên hai người trên cùng vỉa hè rất dễ đi cạnh nhau mãi. Thử ba
 * mức, đếm cặp dính trên 20 giây ở ngưỡng 1 m (bề rộng một người):
 *
 *   0,15 → 3,7–6,4 km/h, 5 cặp (lâu nhất 40 s)
 *   0,22 → 3,6–6,6 km/h, 3 cặp (lâu nhất 26 s)   ← chọn
 *   0,30 → 3,4–6,8 km/h, 3 cặp (lâu nhất 50 s)
 *
 * Ba cặp còn lại trên 600 người là hai đồng nghiệp đi cùng nhau nửa phút.
 */
const SPEED_BAND = {
    vehicle: {spread: 0.12, min: 8, max: 22},
    employee: {spread: 0.22, min: 0.8, max: 1.9},
};

/**
 * Vòng chạy hai chiều: đi bên phải, về cũng bên phải.
 *
 * Dời **sau khi đảo chiều** chứ không đảo đường đã dời: bên phải theo chiều về
 * là bên kia của con đường, nên hai chiều thành hai vệt song song cách nhau
 * ~4 m thay vì một vệt mà xe xuyên qua nhau. Đây cũng là chỗ chữa cái đã thấy:
 * cặp xe gần nhất trước đây cách nhau 0,1 m.
 */
function circuit(path) {
    const out = offsetPath(path, RIGHT, LANE_M);
    const back = offsetPath([...path].reverse(), RIGHT, LANE_M);
    return out.concat(back);
}

/** The instance fields a `model-3d` layer reads off a mover. */
/**
 * Số mover trong mỗi feed.
 *
 * Nguồn chỉ có 100 xe và 100 người, nên vượt quá đó là dùng lại thuộc tính của
 * chúng — chấp nhận được với dữ liệu giả, và `id` được gắn thêm số thứ tự để
 * không trùng.
 */
const VEHICLE_FLEET = VEHICLE_ROUTES * VEHICLE_PER_ROUTE;
const EMPLOYEE_FLEET = EMPLOYEE_ROUTES * EMPLOYEE_PER_ROUTE;

/**
 * Khoảng cách tối thiểu giữa hai mover cùng tuyến, mét.
 *
 * Đây là thứ quyết định một tuyến nhận được bao nhiêu mover: `floor(dài / khoảng
 * cách)`. Xe tải dài chừng chục mét nên 45 m là ba thân xe; người đi bộ 18 m là
 * một quãng đi bộ dễ chịu.
 */
const VEHICLE_GAP_M = 45;
const EMPLOYEE_GAP_M = 18;

const KEEP = ['id', 'code', 'name', 'subclass_code', 'class_code',
    'scale', 'bearing', 'pitch', 'roll', 'height', 'altitude', 'speed_kmh', 'status'];

/**
 * Longest line of a (Multi)LineString feature, followed by its own reverse.
 *
 * Out and back, so the loop closes on itself: a mover that reaches the end walks
 * home rather than teleporting to the start. The plugin's own route planner does
 * the same thing for the same reason.
 */
function outAndBack(geometry) {
    const best = longestStrand(geometry);
    if (!best) return null;
    return best.concat(best.slice(0, -1).reverse());
}

/** Nhánh dài nhất của một feature (Multi)LineString. */
function longestStrand(geometry) {
    const strands = geometry.type === 'MultiLineString' ? geometry.coordinates : [geometry.coordinates];
    let best = [];
    for (const strand of strands) if (strand.length > best.length) best = strand;
    return best.length >= 2 ? best : null;
}

/**
 * One line feature per mover: the route it follows, plus how fast it goes and
 * where along it it starts.
 *
 * Deliberately one copy of the geometry each, rather than one shared route with a
 * fleet pointing at it. The bucket resamples what it is given and has nowhere to
 * keep a shared table.
 *
 * Hai luật giữ cho mover không chồng nhau, và **phải có cả hai**:
 *
 * 1. **Rải đều theo vị trí**: mover thứ `k` trên một tuyến `n` chiếc đứng ở
 *    `dài × k / n`. Bản trước rải bằng tỉ lệ vàng — gần đều nhưng không đều, và
 *    "gần" thì vẫn có cặp dính nhau.
 * 2. **Một tốc độ cho cả tuyến**. Đây mới là luật quan trọng, và nó là chỗ bản
 *    trước sai: mỗi xe mang `speed_kmh` riêng, nên dù xuất phát cách đều thì xe
 *    nhanh vẫn đuổi kịp xe chậm. Đo được lúc ấy — 19 cặp dưới 8 m ở giây thứ 60
 *    so với 10 cặp ở giây 0, tức càng chạy càng dồn. Cùng tốc độ thì khoảng cách
 *    là bất biến của cả vòng chạy.
 *
 * Tốc độ vẫn khác nhau **giữa các tuyến**, và phải khác **thật sự**. Nguồn chỉ
 * có 5 giá trị `speed_kmh` (46, 52, 54, 58, 64), nên nhiều tuyến trùng tốc độ y
 * hệt; hai tuyến trùng tốc độ mà lại đi chung một đoạn đường thì xe của chúng
 * khoá cứng vào nhau và đi cạnh nhau mãi. Đo được: 13 cặp dính trên 20 giây, cặp
 * lâu nhất **92 giây**. Nới mỗi tuyến một chút quanh giá trị gốc là mọi cặp lại
 * trôi khỏi nhau, và một lần chạm thành một lần vượt.
 *
 * Và mỗi tuyến có một **pha** riêng. Không có nó thì mọi tuyến đều đặt chiếc số
 * 0 đúng vạch xuất phát, nên ở giây 0 những tuyến bắt đầu gần nhau cho ra một
 * chùm xe đứng chồng — đo được 9 cặp cùng chiều dưới 8 m, cặp gần nhất 0,1 m.
 * Pha chỉ dịch cả tuyến đi một đoạn, nên khoảng cách đều bên trong tuyến không
 * đổi một mét nào.
 */
function fleet(read, pointFile, count, routes, minGap, band) {
    if (routes.length === 0) return [];

    const source = points(read(pointFile));
    // Làm tròn một lần ở đây, không phải mỗi feature: các mover cùng tuyến dùng
    // chung đúng một mảng toạ độ, nên `JSON.stringify` ghi ra bản đã gọn.
    routes = routes.map(round6);
    const lengths = routes.map(lengthOf);
    // Tuyến dài chở được nhiều hơn, và không tuyến nào nhận quá sức chứa của nó.
    const capacity = lengths.map((L) => Math.max(1, Math.floor(L / minGap)));

    const assigned = routes.map(() => 0);
    let placed = 0;
    for (let round = 0; placed < count; round++) {
        let moved = false;
        for (let r = 0; r < routes.length && placed < count; r++) {
            if (assigned[r] >= capacity[r]) continue;
            assigned[r]++;
            placed++;
            moved = true;
        }
        if (!moved) break;
    }

    const features = [];
    let taken = 0;
    routes.forEach((line, r) => {
        const n = assigned[r];
        if (n === 0) return;
        const lead = source[taken % source.length];
        const base = lead.properties.speed_kmh ? lead.properties.speed_kmh / 3.6 : band.min;
        // Nới quanh tốc độ gốc, tất định theo chỉ số tuyến — hai tuyến liền nhau
        // không bao giờ cùng nhịp — rồi chặn trong dải của hạm đội.
        const spread = 1 + (((r * 0.7548776662) % 1) - 0.5) * band.spread;
        const speed = Math.min(band.max, Math.max(band.min, base * spread));
        // Tỉ lệ vàng: tất định, và hai tuyến liền nhau không bao giờ cùng pha.
        const phase = (r * 0.6180339887) % 1;
        for (let k = 0; k < n; k++) {
            const f = source[taken % source.length];
            const props = pick(f.properties, KEEP);
            // Dùng lại thuộc tính khi hạm đội đông hơn nguồn, nên `id` phải khác.
            props.id = `${props.id}-${taken}`;
            props.route_offset = lengths[r] * ((k / n + phase) % 1);
            props.route_speed = speed;
            features.push({type: 'Feature', properties: props, geometry: {type: 'LineString', coordinates: line}});
            taken++;
        }
    });
    return features;
}

/**
 * Write the feeds an API would serve.
 *
 * Trả về số feature mỗi feed, kèm `walks` — bên nào, lệch bao nhiêu mét, và bao
 * nhiêu phần trăm đỉnh thật sự rơi vào một polygon vỉa hè. Chỗ gọi in ra, vì
 * "đi trên vỉa hè" là một tuyên bố đo được và nó nên được đo.
 */
export function writeMoverFeeds(read, outDir) {
    // Hai hạm đội, hai nguồn tuyến khác nhau về chất.
    //
    // Xe đã có tuyến bám đường sẵn trong `vehicle-routes.geojson` — đo được 22
    // tuyến, 374 đoạn, **0 đoạn cắt qua nhà** — nên chúng đi thẳng vào feed. Đưa
    // chúng qua bộ định tuyến là thay 22 tuyến đang đúng bằng 22 tuyến khác vì
    // không lý do gì.
    //
    // Người thì ngược lại: `employee-tracks.geojson` chỉ là vài đỉnh nối thẳng,
    // cắt ngang lô đất và kết thúc trong nhà. Ba tuyến ấy được dựng lại trên
    // mạng đường — xem `roads.mjs`.
    const pavements = sidewalks(read);
    const graph = roadGraph(read, pavements);
    const walked = [];

    // Một tuyến cho **một** chiếc xe. Tuyến trong dữ liệu gốc dùng trước — chúng
    // là dữ liệu thật — rồi sinh thêm cho đủ đội. Xem `spreadRoutes`.
    const authored = read('tracing/vehicle-routes.geojson').features
        .map((f) => longestStrand(f.geometry))
        .filter((path) => path && lengthOf(path) >= MIN_ROUTE_M);
    const generated = spreadRoutes(graph, VEHICLE_ROUTES - authored.length, {
        minLength: SPREAD_MIN_M,
        maxLength: SPREAD_MAX_M,
    });
    const vehicleRoutes = authored.concat(generated).map(circuit);

    // Người đi bộ: cùng cách chia như xe. Ba tuyến trong dữ liệu gốc là **ba**,
    // và 180 người trên ba tuyến là một đám đông chứ không phải một khu công
    // nghiệp — đo được 22 cặp đứng chồng đúng một chỗ. Sinh thêm cho tới 30.
    //
    // Tuyến sinh ra đi trên đồ thị **đã phạt đường không vỉa hè**, nên chúng tự
    // tìm tới phố có vỉa hè trước khi được dời ra lề.
    const walkCentres = read('tracing/employee-tracks.geojson').features
        .map((f) => walkOnRoads(graph, f.geometry))
        .filter(Boolean)
        .concat(spreadRoutes(graph, EMPLOYEE_ROUTES * WALK_OVERDRAW, {
            minLength: WALK_MIN_M,
            maxLength: WALK_MAX_M,
            seed: 7,
        }));

    // Tim đường mới là thứ định tuyến được — đồ thị nằm ở đó. Dời ra vỉa hè là
    // bước cuối, sau khi đã biết đi đường nào.
    //
    // Sinh dư rồi **giữ những tuyến bám vỉa hè nhất**. Phạt trong đồ thị đã kéo
    // tuyến về phía phố có vỉa hè, nhưng nó chỉ nhìn được từng cạnh; chỉ sau khi
    // dời ra lề mới biết cả tuyến bám được bao nhiêu. Không lọc thì 7 trên 30
    // tuyến nằm dưới 50%.
    const walkRoutes = walkCentres
        .map((path, i) => toSidewalk(path, pavements, i))
        .sort((a, b) => b.covered - a.covered)
        .slice(0, EMPLOYEE_ROUTES)
        .map((moved) => {
            walked.push(moved);
            return outAndBack({type: 'LineString', coordinates: moved.path});
        })
        .filter(Boolean);
    const feeds = {
        vehicles: fleet(read, 'overlay/vehicles.geojson', VEHICLE_FLEET, vehicleRoutes, VEHICLE_GAP_M, SPEED_BAND.vehicle),
        employees: fleet(read, 'overlay/employees.geojson', EMPLOYEE_FLEET, walkRoutes, EMPLOYEE_GAP_M, SPEED_BAND.employee),
    };
    mkdirSync(outDir, {recursive: true});
    const counts = {};
    for (const [name, features] of Object.entries(feeds)) {
        writeFileSync(join(outDir, `${name}.geojson`),
            `${JSON.stringify({type: 'FeatureCollection', features})}\n`);
        counts[name] = features.length;
    }
    counts.walks = walked;
    // In ra để một tốc độ vô lý không lọt lần nữa: bản trước có người đi bộ
    // 153 km/h suốt mấy lượt build mà không phép đo nào kêu.
    counts.speeds = Object.fromEntries(Object.entries(feeds).map(([name, features]) => {
        const kmh = features.map((f) => f.properties.route_speed * 3.6);
        return [name, [Math.min(...kmh), Math.max(...kmh)]];
    }));
    return counts;
}

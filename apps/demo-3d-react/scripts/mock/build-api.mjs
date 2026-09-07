// Feed GeoJSON đứng thay cho API xe, người và hành trình truy vết.
//
//   node scripts/mock/build-api.mjs [path-to-3d-plugins]
//
// **Dữ liệu giả, và tách khỏi pipeline vector tile là có chủ ý.** `scripts/` còn
// lại chỉ sinh ba thứ một tile server phục vụ — tile, style, sprite; những thứ
// ấy là bản đồ. Còn vị trí một chiếc xe lúc chín giờ sáng thì trong sản phẩm
// thật đến từ một endpoint, không đến từ một lượt build. Ở đây nó được sinh ra
// chỉ để trang demo có gì mà vẽ.
//
// Hệ quả có lợi: xoá cả thư mục `mock/` này thì phần còn lại không sứt mẻ gì —
// không file nào trong `lib/` hay ba lệnh build nhập từ đây. Chiều phụ thuộc chỉ
// chạy một hướng, từ thứ bỏ được sang thứ giữ lại.
//
// Cái mất khi xoá: sáu layer đọc ba source ấy và bảng truy vết ở giao diện. Bản
// đồ nền, nhà, mạng kỹ thuật, nhãn và cảnh báo không đụng tới nó.
//
// Tuyến người đi bộ được dựng lại trên mạng đường — xem `roads.mjs`. Hình dạng
// gốc chỉ là vài đỉnh nối thẳng, cắt ngang lô đất và kết thúc trong nhà, vì bộ
// dữ liệu gốc có cả phần trong nhà mà trang này không vẽ.

import {resolve, dirname} from 'node:path';
import {fileURLToPath} from 'node:url';

import {reader} from '../lib/geojson.mjs';
import {PUBLIC_DIR} from '../lib/paths.mjs';
import {writeMoverFeeds} from './movers.mjs';
import {assertTraceGates, writeTraceFeeds} from './tracing.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const pluginRoot = process.argv[2] ? resolve(process.argv[2]) : resolve(here, '../../../../../3d-plugins');
const read = reader(resolve(pluginRoot, 'public/data'));
const outDir = resolve(PUBLIC_DIR, 'api');

const describe = (counts) => Object.entries(counts)
    .filter(([k]) => k !== 'walks' && k !== 'speeds')
    .map(([k, v]) => `${k} ${v}`).join(', ');

const feeds = writeMoverFeeds(read, outDir);
const traces = writeTraceFeeds(read, outDir);

console.log(`public/api  ${describe(feeds)}, traces ${traces.length}  (GeoJSON, không phải tile — nạp bằng addLayer)`);
for (const [name, [lo, hi]] of Object.entries(feeds.speeds)) {
    console.log(`   tốc độ:      ${name} ${lo.toFixed(1)}–${hi.toFixed(1)} km/h`);
}
const covered = feeds.walks.map((w) => w.covered);
const onPavement = covered.reduce((a, b) => a + b, 0) / covered.length;
const stranded = covered.filter((c) => c < 0.5).length;
console.log(`   vỉa hè:      ${feeds.walks.length} tuyến đi bộ · trung bình ` +
    `${(onPavement * 100).toFixed(0)}% đỉnh nằm trong polygon vỉa hè` +
    (stranded ? ` · ${stranded} tuyến dưới 50% (khu ấy không có vỉa hè)` : ''));

// Bảng đo của tuyến truy vết. `chênh` là bằng chứng cho một tuyên bố mà cả trang
// dựa vào: `trace_distance_m` CHÍNH LÀ độ dài cung trên tuyến đã ghép, nên tua tới
// một chặng là gán thẳng con số ấy — theo ĐÚNG cái thước đã khắc ra nó; phía
// client đo lại bằng thước của layer. `dư tile` là khoảng còn lại trước khi
// geojson-vt cắt tuyến, và nó là phép thử đúng chứ không phải bề rộng hộp bao.
// Xem `tracing.mjs`.
console.log('   biển số      đỉnh   tuyến(m)  chặng xa nhất(m)  chênh  chặng  đầu↔chặng1(m)  dư tile');
for (const t of traces) {
    console.log(`   ${t.plate.padEnd(12)} ${String(t.vertices).padStart(4)}` +
        `   ${t.lengthM.toFixed(1).padStart(8)}  ${String(t.junctionMaxM).padStart(16)}` +
        `  ${(t.lengthM - t.junctionMaxM).toFixed(1).padStart(5)}  ${String(t.legs).padStart(5)}` +
        `  ${t.startGapM.toFixed(1).padStart(13)}  ${t.tileMargin.toFixed(2).padStart(7)}`);
}
assertTraceGates(traces);

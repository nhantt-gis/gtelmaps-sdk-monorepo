/**
 * Sinh `style.json` từ style **đang chạy** của trang, không phải từ mã nguồn.
 *
 * Chép tay 138 giá trị là 138 cơ hội gõ sai một chữ số mà không phép kiểm nào
 * bắt được; đọc `map.getStyle()` thì cái ghi ra đúng bằng cái đang vẽ, theo định
 * nghĩa. Chạy một lần lúc tách style ra khỏi mã, và chạy lại mỗi khi cần dựng
 * lại từ đầu:
 *
 *     pnpm dev            # cần 5181 đang chạy
 *     node scripts/build-style.mjs
 *
 * Ba chỗ phải sửa lại sau khi đọc:
 *
 * 1. **Dữ liệu sống bị loại ra.** `getStyle()` trả về cả `vehicles`,
 *    `employees` và `traces` — ba source GeoJSON mà `scene/` dựng bằng
 *    `<Source>` sau một lượt `fetch`, kèm nguyên 204 feature nội tuyến. Chúng
 *    không thuộc về một tài liệu style: style mô tả cảnh **trông như thế nào**,
 *    còn vị trí một chiếc xe lúc 9 giờ sáng thì không. Luật lọc là chính kiểu
 *    source, nên thêm một feed nữa cũng không phải sửa gì ở đây.
 * 2. **`models` và `textures` bị bỏ.** `Style.serialize()` không mang hai bảng
 *    ấy ra, nên chúng được dựng lại từ chính các layer — `model-3d-id` và
 *    `fill-3d-textures` là nơi tên asset thật sự được dùng, nên bảng dựng từ đó
 *    không thể lệch khỏi thứ layer đang hỏi.
 * 3. **URL tuyệt đối theo cổng.** `getStyle()` trả `http://localhost:5181/...`.
 *    Cắt phần gốc đi thì file dùng được ở bất kỳ đâu nó được phục vụ, thay vì
 *    dính chặt vào cổng của máy đã sinh ra nó.
 */
import {writeFileSync} from 'node:fs';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {open, REACT, VIEW} from './lib/browser.mjs';
import {STYLE_DIR} from './lib/paths.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const OUT = resolve(STYLE_DIR, 'style.json');

/**
 * Layer đọc source tĩnh nhưng vẫn ở lại trong mã.
 *
 * `alerts`: hình học đến từ tile `overlay` như `label_poi`, nhưng **bảng ba mức**
 * của nó (màu, bán kính ping, chiều cao cột, nhịp đập theo `status`) là thứ sẽ
 * được sửa — thêm một mức, dời một ngưỡng — và sửa thường xuyên hơn hẳn màu mặt
 * nước hay chu kỳ hoa văn nền. Thứ đổi thường xuyên thì để nơi có kiểu và có
 * `git blame` từng dòng. Xem `src/scene/alerts.tsx`.
 */
const MANAGED_IN_CODE = new Set(['alerts']);

/** Đuôi file của từng texture — bảng `textures` cần URL đầy đủ, không chỉ tên. */
const TEXTURE_EXT = {'water-normals': 'jpg'};

/** Tên asset mà layer đang hỏi, gom từ chính các layer. */
function assetsOf(layers) {
  const models = new Set();
  const textures = new Set();
  for (const layer of layers) {
    const id = layer.layout?.['model-3d-id'];
    // `model-3d-id` là chuỗi hoặc một biểu thức; chuỗi nằm ở các vị trí lá của
    // `match`, nên gom mọi chuỗi trong cây trừ tên toán tử và tên property.
    if (typeof id === 'string') models.add(id);
    else if (Array.isArray(id)) collectLeaves(id, models);
    for (const name of layer.paint?.['fill-3d-textures'] ?? []) textures.add(name);
    const wave = layer.paint?.['water-3d-wave-texture'];
    if (typeof wave === 'string') textures.add(wave);
  }
  return {models: [...models], textures: [...textures]};
}

/**
 * Lá chuỗi của một biểu thức `match`: bỏ phần tử đầu (toán tử) và mọi mảng con
 * (`['get', 'kind']` là chỗ đọc property, không phải tên asset).
 */
function collectLeaves(expression, out) {
  for (const item of expression.slice(1)) {
    // `''` là nhánh mặc định của `match` trong layer `poi`, và nó có nghĩa là
    // "không vẽ mô hình nào". Nhận nó vào bảng là hỏi server `/models/.glb`.
    if (typeof item === 'string' && item !== '') out.add(item);
    else if (Array.isArray(item) && item[0] === 'match') collectLeaves(item, out);
  }
}

/** Bỏ `http://host:port` để URL bám gốc trang phục vụ, không bám một cổng. */
const rootRelative = (url) => url.replace(/^https?:\/\/[^/]+/, '');

const {browser, page, errors} = await open(REACT + VIEW);
const live = await page.evaluate(() => JSON.parse(JSON.stringify(window.map.getStyle())));
await browser.close();

// Feed ra một đường, tile ra một đường. Xem chú thích đầu file, mục 1.
const feeds = new Set(
  Object.entries(live.sources)
    .filter(([, source]) => source.type === 'geojson')
    .map(([id]) => id),
);

const sources = Object.fromEntries(
  Object.entries(live.sources)
    .filter(([id]) => !feeds.has(id))
    .map(([id, source]) => [id, {...source, tiles: source.tiles.map(rootRelative)}]),
);

const layers = live.layers.filter((l) => !feeds.has(l.source) && !MANAGED_IN_CODE.has(l.id));

// Gom asset từ **mọi** layer, kể cả sáu layer vừa bị loại. `truck` và `patrol`
// chỉ được đội xe và đội người hỏi tới, nhưng một file GLB là tài sản tĩnh —
// `model-3d-id: 'truck'` phân giải qua bảng này, nên bỏ nó ra là layer dựng bằng
// `addLayer` hỏi một tên không ai biết. Layer động, asset thì không.
const {models, textures} = assetsOf(live.layers);

const style = {
  version: live.version,
  sprite: rootRelative(live.sprite),
  models: Object.fromEntries(models.map((name) => [name, `/models/${name}.glb`])),
  textures: Object.fromEntries(
    textures.map((name) => [name, `/textures/${name}.${TEXTURE_EXT[name] ?? 'png'}`]),
  ),
  sky: live.sky,
  light: live.light,
  shadow: live.shadow,
  sources,
  layers,
};

writeFileSync(OUT, `${JSON.stringify(style, null, 2)}\n`);
console.log(`${OUT}: ${style.layers.length} layer, ${Object.keys(sources).length} source`);
console.log(`bỏ ra ngoài: source ${[...feeds].join(', ')} và ${live.layers.length - layers.length} layer (feed + ${[...MANAGED_IN_CODE].join(', ')})`);
console.log(`models: ${models.join(', ')}`);
console.log(`textures: ${Object.keys(style.textures).join(', ')}`);
if (errors.length) console.log(`lỗi console lúc đọc: ${errors.length}\n  ${errors.join('\n  ')}`);

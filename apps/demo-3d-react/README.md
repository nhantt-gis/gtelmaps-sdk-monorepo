# demo-3d-react — mười layer 3D, khai báo bằng React

Cả mười layer 3D của fork, vẽ bằng `<Layer>` trong JSX. Phần **tĩnh** của style
là một tài liệu (`public/styles/gtelmaps-3d-poc/style.json`) chứ không phải một
object dựng trong mã;
những gì đổi được lúc chạy đi qua `<Layer>` chứ không qua `map.setPaintProperty`.
Bộ áo giao diện mượn từ `3d-plugins/apps/demo-3d-react`.

Trang này từng có một anh em, `apps/demo-3d-parity`, dựng cùng cảnh bằng maplibre
trần để so từng pixel. App ấy đã gỡ; pipeline dựng dữ liệu và toàn bộ ghi chép đo
đạc của nó chuyển sang đây:

| | |
|---|---|
| [`.claude/docs/data-pipeline.md`](../../.claude/docs/data-pipeline.md) | Tile, sprite, feed được sinh ra thế nào — và những chỗ tippecanoe không tin được |
| [`.claude/docs/tracing.md`](../../.claude/docs/tracing.md) | Hai cái thước đo tuyến, vì sao `maxzoom` phải là 12, giá của một paint property mỗi frame |
| [`.claude/docs/layer-notes.md`](../../.claude/docs/layer-notes.md) | Giới hạn đã biết của từng layer type, và đọc số hiệu năng thế nào |

`.claude/` **không nằm trong repo** (`.gitignore`) — đó là ghi chép cục bộ để tham
chiếu khi phát triển, không phải tài liệu phát hành. Ai clone repo sẽ không có ba
file trên; chúng ở lại máy đã sinh ra phép đo.

## Chạy

```bash
cd ../../packages/gtelmaps-gl-js && npm run build-dev   # demo nạp thẳng dist/
cd ../../apps/demo-3d-react
node scripts/build-tiles.mjs        # public/{tiles,models,textures}
node scripts/build-sprite.mjs       # public/sprites/gtelmaps-3d-poc
node scripts/mock/build-api.mjs     # public/api — dữ liệu giả, xem bên dưới
pnpm dev                            # http://localhost:5180
```

Bố cục `public/`:

```
tiles/basemap/{z}/{x}/{y}.pbf     thư mục tile, thứ dev server phục vụ
tiles/basemap.mbtiles             cùng bộ tile, đóng gói cho tile server
styles/gtelmaps-3d-poc/style.json 22 layer tĩnh
sprites/gtelmaps-3d-poc/sprite.*  atlas mặt tiền và mái
models/ textures/ api/            tài sản và feed
```

Cả cây sinh ra được và bị `.gitignore` bỏ qua, trừ `styles/` — `style.json` là
nguồn, sửa tay được.

Hai ngoại lệ: `models/camera_cone.glb` và `camera_cone_edges.glb` không script
nào ở đây sinh ra được (script từng làm việc đó đã không còn). `build-tiles.mjs`
không xoá thư mục nên chúng sống qua mọi lần dựng lại; một `rm -rf public/models`
thì mất, và mất thì thôi.

`build-tiles.mjs` cũng đóng thêm `{basemap,overlay}.mbtiles` — cùng bộ tile, một
file, đã nén, dành cho một tile server. Trang này không đọc chúng, nhưng vì nằm
trong `public/` nên chúng vẫn lấy được ở `/basemap.mbtiles`. Chi tiết ở
[`.claude/docs/data-pipeline.md`](../../.claude/docs/data-pipeline.md).

## Docker

Bản đóng gói: build tĩnh trong container rồi phục vụ qua nginx.

```bash
task                # danh sách task
task docker:build   # dựng image
task docker:up      # chạy nền → http://localhost:8180
task docker:down
```

Cấu hình ở [`docker/.env`](docker/.env) (cổng, tên image, đường dẫn `public/`).
Không có biến nào của trang trong đó — app này không dùng `import.meta.env.VITE_*`
nào cả.

Hai điều sẽ làm người sau vấp, nên nói trước:

**Image không chứa dữ liệu.** `public/` (31 MB) được mount `:ro` vào `/srv/public`
lúc chạy chứ không nướng vào image, vì cây ấy sinh ra từ `sdk/3d-plugins/public/data`
— một kho ~150 MB nằm ngoài monorepo và không có git remote — bằng tippecanoe +
sqlite3, và riêng `models/camera_cone*.glb` thì không script nào sinh lại được.
Hệ quả: **image một mình không chạy được ở máy khác**; mang đi thì phải mang theo
cả `public/`.

**Image dựng từ cây làm việc, không từ git.** Cả app này lẫn
`packages/gtelmaps-gl-js/dist` đều chưa được commit, nên `git clone` rồi
`docker build` sẽ ra một image rỗng. `docker/Dockerfile` vì thế liệt kê tường
minh từng artefact nó chép vào, thay vì một `COPY . .` giấu việc đó đi.

Phép kiểm quan trọng nhất sau khi `task docker:up`:

```bash
curl -sI localhost:8180/tiles/basemap/15/0/0.pbf | head -1   # phải là 404
```

Tile không tồn tại **phải** trả 404. Trả `index.html` kèm 200 thì bộ giải mã gặp
HTML ở chỗ chờ protobuf, tile bị tính là hỏng chứ không phải rỗng, và MapLibre
giữ một tile thô hơn lấp chỗ trống vĩnh viễn. `docker/nginx.conf` xử lý bằng cách
đặt bốn khối `location` regex trước SPA fallback — nginx so khớp regex trước tiền
tố, nên fallback không bao giờ với tới đường dẫn tile.

## Mã nguồn

| Chỗ | Việc |
|---|---|
| `index.html` | Khung `#map`, không hơn |
| `src/gl.ts` | Cầu nối tới `window.gtelmapsgl` |
| `public/styles/gtelmaps-3d-poc/style.json` | 22 layer tĩnh, 2 source tile, ánh sáng, bóng đổ, bảng model và texture |
| `scripts/lib/paths.mjs` | Bố cục `public/` khai một chỗ |
| `scripts/build-style.mjs` | Sinh lại `style.json` từ style **đang chạy** của trang |
| `scripts/build-{tiles,sprite,style}.mjs` | Ba thứ một tile server phục vụ: tile, sprite, style |
| `scripts/lib/` | Module dùng chung của ba lệnh trên |
| `scripts/mock/` | Feed xe, người, truy vết — dữ liệu giả, tách riêng vì bỏ được |
| `src/style.ts` | Nạp `style.json` và gắn URL của nó vào origin |
| `src/scene/` | Chỉ phần công tắc cầm được: một component một nhóm layer |
| `src/state.tsx` | Bảng công tắc dùng chung giữa `scene/` và `ui/` |
| `src/ui/` | Chrome và bảng điều khiển ba tab |
| `src/tracing/` | Truy vết một xe: tuyến, phát lại, camera bám |
| `src/styles.css` | Bộ áo mượn về, giữ nguyên tên class |

## Style là dữ liệu, và những gì còn lại trong mã

Ranh giới là **bản chất của dữ liệu**, không phải "cái gì đứng yên lúc chạy":

| | |
|---|---|
| `style.json` | 22 layer trên hai source tile — màu, biểu thức, chu kỳ texture, filter, thứ tự chồng |
| `scene/` | 15 khoá do công tắc cầm, cộng spec đầy đủ của **bảy layer** không thuộc về tài liệu |

Một tài liệu style mô tả cảnh **trông như thế nào**. Hai loại thứ không thuộc về
nó, và chúng ở lại trong mã dưới dạng `<Source>`/`<Layer>` — đúng cặp
`addSource`/`addLayer` mà bản đối chiếu gọi:

| Ra khỏi tài liệu | Vì |
|---|---|
| `vehicles`, `employees`, `traces` và 6 layer của chúng | Dữ liệu đến từ API, sau khi style đã nạp. Vị trí một chiếc xe lúc chín giờ sáng không phải một phần mô tả cảnh. |
| `alerts` | Đọc tile như mọi layer tĩnh, nhưng **bảng ba mức** của nó là thứ sẽ được sửa — thêm một mức, dời một ngưỡng. Thứ đổi thường xuyên thì để nơi có kiểu và có `git blame` từng dòng. |

Sửa một màu trong `style.json` rồi tải lại trang là thấy ngay; không phải dựng
lại gì.

Phần tĩnh chia được như thế vì `<Layer>` chấp nhận cả hai vai:

```
<Layer>  ─┬─▶  getLayer(id) có   ──▶ updateLayer   (chỉ ghi khoá ĐỔI)
          └─▶  getLayer(id) rỗng ──▶ createLayer   (addLayer + beforeId)
```

Nhánh dưới là đường của sáu layer feed, và của mọi layer dựng lúc chạy.

`layer.ts:105` đọc `map.getLayer(id)` trước; layer đã tồn tại thì nó đi thẳng vào
`updateLayer`, và `updateLayer` so props lần này với props lần trước — không phải
với style. Nên ở lần render đầu không có một lời ghi nào, và những khoá `<Layer>`
không nhắc tới thì không bao giờ bị đụng vào.

### Đừng tháo một `<Layer>` mà `style.json` sở hữu

Cái giá của cách ghép này nằm ở chiều ngược lại. Effect dọn dẹp của `<Layer>` gọi
`map.removeLayer(id)`, và nó không biết layer ấy đến từ tài liệu:

```tsx
{show && <Layer id="water" type="water-3d" />}   // ĐỪNG
```

Tháo là **xoá hẳn** layer khỏi style. Gắn lại thì `createLayer` chạy, và nó dựng
layer từ đúng những gì JSX khai — mất sạch mười giá trị `water-3d-*` của tài
liệu, và nối vào **cuối** chồng chứ không về chỗ cũ. Bật tắt phải đi qua
`visibility`, đúng như `withVisibility` làm; đó không phải sở thích mà là điều
kiện để tài liệu còn là nguồn duy nhất.

Luật này chỉ áp cho 22 layer của tài liệu. Sáu layer feed thì ngược lại — chúng
**thuộc về** `<Source>`, nên tháo `<Source>` là tháo đúng thứ nó dựng lên, và
gắn lại là dựng lại đủ. Đó cũng là lý do `Trace` trả `null` khi chưa có dữ liệu
thay vì dựng layer rỗng.

Cùng lý do, app này không bọc `<StrictMode>`. Nó dựng–huỷ–dựng lại mọi effect một
lượt, tức đúng chuỗi ở trên, cho cả 22 layer của tài liệu.

### URL trong `style.json` bám gốc, và phải được gắn origin trước khi dùng

Tài liệu viết `/tiles/basemap/{z}/{x}/{y}.pbf`, không phải `http://localhost:5181/...`,
để hai app ở hai cổng đọc chung một file. Nhưng MapLibre không nhận dạng ấy ở hai
chỗ:

```
Invalid sprite URL "/sprites/…/sprite", must be absolute   ← load_sprite.ts:25
Failed to construct 'Request': …URL from /tiles/basemap/16/…  ← trong worker
```

Sprite bị chặn ngay ở validator, trước cả `transformRequest`, nên không vá sau
được. Tile thì được `fetch` trong **worker**, nơi `self.location` là một blob URL
và đường dẫn tương đối không có gốc để bám. `src/style.ts` gắn origin cho đúng
những trường mang URL — liệt kê từng cái, không quét đệ quy, vì trong biểu thức
paint dấu gạch chéo là ký tự dữ liệu.

Phép nối chuỗi chứ không `new URL`: `URL` mã hoá `{z}` thành `%7Bz%7D`, MapLibre
thôi nhận ra chỗ thay số, và mọi tile trả 404.

### Thứ tự chồng: 22 layer đọc từ tài liệu, 7 layer dựng lúc chạy

Với 22 layer tĩnh, mảng `layers` của tài liệu quyết định — đảo hai dòng JSX trong
`scene/index.tsx` không đổi một pixel, đảo hai phần tử trong `style.json` mới đổi.

Bảy layer còn lại đi qua `addLayer`, và chúng chia đôi:

- **Sáu layer feed** khai `beforeId="camera_cone"`, bắt buộc. `<Source>` chỉ
  render con của nó **sau** khi `fetch` xong, nên `addLayer` không kèm `beforeId`
  sẽ nối vào **cuối** chồng — sau cả nhãn và cảnh báo.
- **`alerts`** không khai gì, cũng bắt buộc: chỗ đúng của nó *là* cuối chồng, mà
  đó đúng là chỗ `addLayer` nối vào. Đo được: nó nằm ở vị trí 28/29, sau
  `label_poi`.

Thứ tự ấy nặng hơn z-order ở cả hai đường: nó đặt `opaquePassCutoff`, ranh giới
giữa lượt vẽ đục và lượt vẽ trong, nên thảm nền cùng mặt đường phải nằm trước
khối nhà.

### `paint` và `layout` phải là hằng ở tầng module

```ts
if (layout !== prevProps.layout) {
  for (const key in layout) if (!deepEqual(layout[key], prevLayout[key])) ...
}
```

`updateLayer` so identity trước rồi mới duyệt từng khoá. Một object dựng thẳng
trong JSX có identity mới **mỗi lần render**, nên toàn bộ property của layer bị
quét lại mỗi khi một state chẳng liên quan gì đổi. Chỗ nào giá trị phụ thuộc một
công tắc thì dựng bằng `useMemo` khoá trên đúng con số ấy, và chỗ nào chỉ bật/tắt
thì đi qua `withVisibility` — nó trả về một trong **hai** object đã cache, nên
phép so vẫn chỉ là một `===`.

### `onError` không phải tuỳ chọn

`addSource` và `addLayer` **không ném** khi spec sai; chúng bắn một sự kiện
`error`. Một `buffer` vượt trần 512 từng nuốt im lặng cả source lẫn hai layer.
Trang này nghe sự kiện ấy ở `App.tsx` và in nó ra ô `#readout` bằng chữ đỏ.

## Nhãn bám con trỏ

`ui/HoverLabel.tsx` mở một `<Label3D>` tại chỗ con trỏ đang trỏ vào — cùng việc
mà bản đối chiếu maplibre trần làm, nhưng ranh giới hiệu năng phải nói rõ:

- **Đổi vật** thì đi qua React. Khoá là `layer:tên`, nên trượt con trỏ dọc một
  toà nhà không sinh ra một lần render nào.
- **Đổi chỗ** thì không. Vị trí ghi thẳng vào instance qua `ref` — đúng đường
  thoát mà `<Popup>` của react-map-gl bày sẵn, và `<Label3D>` giữ nguyên. Đo
  được: 25 nhịp con trỏ trên cùng một vật cho **0** lần render và 25 vị trí nhãn
  khác nhau.

Tiết lưu 50 ms chỉ chặn **câu hỏi**, không chặn việc dời nhãn. Bản đầu bọc cả
hàm và nhãn tụt xuống 19,5 lần/giây so với 59,8 của bản vanilla — mắt thấy giật
ngay. Bản gốc gộp hai thứ làm một là đúng ở bên ấy, vì vị trí chip **là** điểm
va chạm raycast; ở đây vị trí nằm sẵn trong sự kiện nên tách được, và phải tách.
Giá phải trả: rời khỏi một vật thì nhãn nán lại nhiều nhất 50 ms, vì chỉ câu hỏi
mới biết là đã rời — bản gốc cũng vậy.

Ba thứ lấy của `3d-plugins` mà bản vanilla không có: tiết lưu **50 ms** trước khi
hỏi (bản gốc chặn ngay ở lượt raycast, `hoverThrottleMs ?? 50`), con trỏ đổi
thành `pointer` khi trúng vật, và **màu nhấn theo loại** đối tượng thay vì trắng
tất — dùng đúng bộ màu mà `layers/labels.ts` đã dùng cho nhãn cố định.

Và một chỗ sửa: danh sách layer để hỏi. Bản vanilla ghi `'infra'`, một layer
**không tồn tại** — tên thật là `'poi'`. `queryRenderedFeatures` bỏ qua id lạ mà
không kêu ca, nên bên ấy 651 thiết bị hạ tầng lặng lẽ không hover được.

Một điều đáng biết khi đọc cái nhãn: ở khung nhìn nghiệm thu (pitch 64, cao độ
nhân 2,4) một nhà xưởng lớn phủ phần lớn màn hình, nên nhãn hay gọi tên cùng một
toà. Đó **không** phải lỗi của fork — `fill-extrusion` gốc của upstream trả về
đúng cùng feature ấy tại cùng những điểm đó; cả hai layer nhà đều đi qua một
`prismIntersection`.

## Vòng 60 Hz không đi qua React

Bảng truy vết ghi `model-3d-route-time` mỗi frame. Nếu con số ấy đi qua
`useState` thì mỗi frame là một lượt render cả cây React — hơn hai chục ô điều
khiển — để đổi một dòng chữ. Nên trạng thái bị chẻ đôi ở `tracing/hooks.ts`:

- `playing`, `speed`, `legIndex` đi qua `useState`. Chúng đổi vài chục lần cho cả
  hành trình.
- `distance` chỉ đi tới những ai đăng ký nghe. Thanh tua và ô chữ tự ghi vào DOM
  qua ref.

`TracePlayback` không tự đi tìm bản đồ: chỗ duy nhất nó chạm vào được truyền từ
ngoài, và chỗ gọi đưa `useMapPaintProperty` của SDK — hook ấy đã chắn sẵn cả
`style._loaded` lẫn `getLayer()`. `setPaintProperty` **ném** nếu style chưa xong,
nên thiếu vế đầu là một ngoại lệ; thiếu vế sau là mất giá trị mà không có tiếng
động nào.

Cùng bẫy ấy đổi mặt khi style thành một URL: `useShadows` gọi `map.setShadow`
trong một effect chạy ngay sau mount, và style tải qua mạng thì lúc ấy chưa xong
— một object style nạp **đồng bộ** nên trước đây nó luôn kịp. Chữa bằng cách chờ
`style.load`, không phải bằng cách bỏ hiệu ứng đi.

## Sinh lại `style.json`

`scripts/` giờ chỉ còn ba lệnh, và cả ba đều **sinh ra** thứ gì đó chứ không
kiểm tra gì:

```bash
node scripts/build-tiles.mjs       # cả cây public/, xem .claude/docs/data-pipeline.md
node scripts/build-sprite.mjs      # public/sprites/gtelmaps-3d-poc
node scripts/build-style.mjs       # style.json — cần dev server đang chạy
```

`build-style.mjs` mở trang trong Chrome không đầu, đọc `map.getStyle()` và ghi ra
file. Chép tay 138 giá trị là 138 cơ hội gõ sai một chữ số mà không ai bắt được;
đọc style đang chạy thì cái ghi ra đúng bằng cái đang vẽ, theo định nghĩa.

Nó loại theo hai luật — kiểu source (geojson là feed) và danh sách
`MANAGED_IN_CODE` (hiện có `alerts`). Nhưng bảng `models` thì gom từ **mọi**
layer, kể cả bảy layer bị loại: `truck` và `patrol` là file GLB, tài sản tĩnh, và
`model-3d-id: 'truck'` phân giải qua đúng bảng ấy. Bản đầu gom từ danh sách đã
lọc, và bản đồ báo `Model "truck" is neither a key in the style's "models" table
nor a URL`.

### Những con số trong file này đến từ đâu

Chúng từng có bộ đo tự động — năm script chạy trên Chrome không đầu — và bộ ấy
đã gỡ. Các con số ở lại vì chúng **đã được đo**, không phải vì còn chạy lại được
bằng một lệnh:

| | |
|---|---|
| 34/34 ô điều khiển đổi đúng property, kể cả bốn ô đóng băng phải trả lại giá trị cũ | `check-controls.mjs` |
| 25 nhịp con trỏ trên cùng một vật → **0** lần render, nhãn dời 25 chỗ | `check-hover.mjs` |
| 60 nhịp cách nhau 8 ms → nhãn dời 36 lần (bản lỗi: 9–10) | `check-hover.mjs` |
| vài trăm lần ghi `model-3d-route-time` trên **0** lần React render | `check-render-cost.mjs` |
| 0/1.024.000 pixel so với bản đối chiếu, rồi 83/1.024.000 sau khi bỏ `solid` | `compare-pixels.mjs` |
| 411 giá trị trên 30 layer, 8 chỗ lệch và cả 8 vô hại | `audit-layers.mjs` |

Hai phép đo cuối cần app đối chiếu, nên chúng chết cùng nó. Bốn phép đầu thì tự
đứng được — gỡ đi là một lựa chọn, không phải một điều bắt buộc, và dựng lại
được từ `scripts/lib/browser.mjs`, thứ còn ở lại vì `build-style.mjs` cần.

Cùng lúc ấy `window.__renders` và `window.__hoverRenders` cũng đi: hai bộ đếm ấy
tồn tại chỉ để bộ đo đọc, và một bộ đếm không ai đọc là một dòng mã nói dối về
mục đích của nó.

## Chỗ chệch khỏi bản gốc, nói trước

Bản gốc ở đây là `3d-plugins` — bản dựng bằng three.js mà cả fork lẫn trang này
đối chiếu tới. Những chỗ dưới đây khác nó **có chủ ý**.

- **Góc nắng khi bật lại bóng đổ.** Bản đối chiếu maplibre trần khai
  `elevation: 40` trong style nhưng công tắc bóng của nó ghi `42`, nên tắt rồi
  bật là mặt trời dịch 2° và hai lần bật cho hai cái bóng khác nhau. Ở đây công
  tắc gọi `map.getShadow()` rồi chỉ thay `intensity`, nên không có bản sao nào
  của góc nắng để trôi: `style.json` là chỗ duy nhất khai nó.
- **`building-atlas-night`.** Bản đối chiếu ghi cứng `1` trong style trong khi
  thanh trượt của nó hiển thị `0`. Ở đây mặc định là `1` — vẽ ra đúng cùng khung
  hình, và thanh trượt nói thật. Cùng loại với chuyện trên: bám theo cái bản kia
  **vẽ**, không bám theo cái nó **gõ**.
- **Không có layer `fill-extrusion`.** Bản đối chiếu giữ một layer khối đặc để
  đặt cạnh `atlas`/`glass` mà nhìn. Nó tồn tại **để đối chiếu**, nên nó đi cùng
  việc đối chiếu.
- **Danh sách layer để hỏi khi hover.** Bản đối chiếu ghi `'infra'`, một layer
  **không tồn tại** — tên thật là `'poi'`. `queryRenderedFeatures` bỏ qua id lạ
  mà không kêu ca, nên bên ấy 651 thiết bị hạ tầng lặng lẽ không hover được. Ở
  đây dùng tên thật.

- Bản React của `3d-plugins` có 6 tab dashboard; ở đây 3. Ba tab kia (bóc tầng và
  explode từng toà, khoét đất, camera tự do Explore) cần tính năng render mà fork
  chưa có — đó là ranh giới đã chốt, không phải thiếu sót.
- Renderer được `import` theo **đường dẫn con** — `@gis/gtelmaps-gl-js/dist/
  gtelmaps-gl-dev.js` — chứ không theo tên package, vì `main` của gói còn trỏ vào
  `dist/maplibre-gl.js`, tên artefact của bản thượng nguồn mà fork không dựng ra.
  Đường dẫn con bỏ qua `main`. Xem `.claude/specs/2026-09-03-react-3d-layers.md` §8.
- Chỉ bản `gtelmaps-gl-dev.js` là mới. `gtelmaps-gl.js` (bản production) có từ
  26/08 và thiếu vài layer 3D, nên đừng đổi `import` sang nó.
- Bundle ấy là **UMD**, nên nó cần hai chỗ khai trong `vite.config.ts`:
  `optimizeDeps.include` cho `dev` (esbuild gói lại) và `build.commonjsOptions.
  include` cho `build` (Rollup mặc định chỉ ngó `node_modules/`, mà đường tới file
  này đi qua symlink workspace). Thiếu vế đầu: `module is not defined`. Thiếu vế
  sau: `"default" is not exported`.

# demo-3d-parity

Cổng nghiệm thu bằng mắt cho ba layer type `building-glass`, `building-atlas` và
`model`: cùng một tập dữ liệu, vẽ bằng `gtelmaps-gl-js` qua vector tiles, đặt cạnh
bản `3d-plugins` để so. Chọn layer nhà bằng hai nút ở góc dưới trái; model bật tắt
bằng ô "Model 3D".

## Chạy

```sh
pnpm install                      # từ gốc monorepo
cd packages/gtelmaps-gl-js && npm run build-dev    # demo nạp thẳng dist/
cd ../../apps/demo-3d-parity
node scripts/build-tiles.mjs       # sinh public/tiles từ GeoJSON của 3d-plugins
node scripts/build-model-tiles.mjs # sinh public/model-tiles và chép public/models
node scripts/build-sprite.mjs     # sinh public/sprite từ texture mặt tiền của 3d-plugins
pnpm dev                          # http://localhost:5180
```

Tile dựng với `--no-clipping`, và đó không phải tuỳ chọn: `building-atlas` trải
ảnh mái **một lần** lên mỗi footprint, nên nó chỉ đo được cái footprint được đưa
cho. Một toà nhà bị cắt ở biên tile sẽ được đo hai lần, mỗi nửa một lần, và hai
nửa nhận hai ánh xạ khác nhau. Khi kéo bản đồ, tile vào ra thì nửa nào đang hiện
cũng đổi — đọc ra là mái "giật".

Và một tile **không tồn tại** phải trả về 404, không phải 200. tippecanoe không
ghi tile ở chỗ không có gì để vẽ, còn SPA fallback của Vite thì trả `index.html`
kèm 200 cho mọi thứ nó không tìm thấy — bộ giải mã gặp HTML ở chỗ chờ protobuf và
báo `Unimplemented type: 4`, một câu không nói gì về nguyên nhân. Tệ hơn: tile đó
bị tính là *hỏng* chứ không phải *rỗng*, nên MapLibre giữ một tile thô để lấp chỗ
vĩnh viễn, và mỗi toà nhà trong vùng chồng lấn được vẽ nhiều lần. `vite.config.ts`
có một middleware trả 404 cho đúng việc này.

`build-tiles.mjs` cần `tippecanoe` trên PATH. Nó đọc
`sdk/3d-plugins/public/data/overlay/buildings.geojson` (372 toà nhà KCN Châu Đức)
— **đúng tập dữ liệu bản plugin đang vẽ**, nên hai khung so cùng một thứ chứ
không phải hai tập trông giống nhau. Truyền đường dẫn khác làm tham số nếu cần.

`build-model-tiles.mjs` sinh tile cho 5.635 cây, 651 hạ tầng, 100 xe và 100 nhân
viên, rồi chép các file `.glb` sang `public/models`. Tile model dựng ở **`-z14`**,
thô hơn tile nhà một cách có chủ ý: layer `model` vẽ một lần cho mỗi cặp
(tile, model), nên tám mươi tile z16 tốn gấp nhiều lần một chục tile z14 phủ cùng
diện tích — mà mỗi tile trong số đó vẫn được cull, vốn là lý do đưa instance vào
tile ngay từ đầu.

Xe và nhân viên **không** phải feature điểm mà là **đường**: một layer `model` đặt
lên feature đường sẽ mang mỗi bản sao chạy dọc đường ấy thay vì cắm nó tại một
điểm. Đường được lấy mẫu theo bước quãng đường đều lúc parse tile, và vị trí tính
trên GPU từ đồng hồ — không có một dòng CPU nào mỗi frame. Tile của chúng cũng cần
`--no-clipping`: một tuyến phải tới nguyên vẹn ở tile đã nhận nó, mà tile ấy được
chọn theo chỗ tuyến **bắt đầu**; cắt tuyến ra thì mỗi tile cầm một mẩu khác nhau và
mover sẽ chạy hết mẩu của mình rồi biến mất.

Nhân viên dùng `patrol.glb` — bản **có xương**, không phải bản `.vat.glb` bake sẵn
của plugin. Layer tự lấy lại mẫu clip `Di_Bo` ra thành vertex animation texture
trong worker. Đó là ca plugin chưa từng chạy: `loadRig` của nó không có ai gọi.

`build-sprite.mjs` gom năm ảnh mặt tiền (`plaster`, `brick`, `block`, `wood`,
`glass`) cộng một mặt nạ cửa sổ thành một sprite. Mọi ảnh bị ép **đục hoàn
toàn**: atlas theo tile lưu alpha đã nhân trước, nên một pixel alpha 0 sẽ mất
luôn màu — và vài ảnh nguồn có sẵn kênh alpha không nhằm để đọc như độ trong
suốt.

Tiles ghi ra **không nén**. tippecanoe gzip mặc định, static server trả byte gzip
mà không kèm `Content-Encoding`, và lỗi hiện ra là `Unimplemented type: 3` từ sâu
trong decoder — không có gì chỉ về phía nén.

## So cạnh nhau

```sh
# khung phải: bản plugin, chạy riêng
cd ../../../3d-plugins && pnpm demo-js        # :5173
```

rồi mở `http://localhost:5180/?ref=http://localhost:5173/`. Khung phải là iframe
và được đồng bộ viewport qua hash `#zoom/lat/lng/bearing/pitch` mỗi lần `moveend`
(cross-origin nên chỉ đặt được `src`, không đẩy được từng frame).

Nếu host basemap của plugin không tới được, dùng `?mode=standalone` ở phía nó —
route đó không dựng `maplibregl.Map`.

## Đọc kết quả thế nào

**Đừng so pixel.** Ba khác biệt đã biết trước và không phải lỗi port:

| | `3d-plugins` | ở đây |
|---|---|---|
| Chiều cao | nhân `exaggeration = 2.4` | đúng mét trong dữ liệu |
| Camera | bake vào `projectionMatrix`, `cameraPosition` uniform là `(0,0,0)` | eye truyền qua `u_eye_tile` |
| Màu | `NoColorSpace`, không tonemapping | qua đường màu của MapLibre |

Cái cần so là **hành vi** của hiệu ứng:

- rìa kính có sáng lên theo góc nhìn khi camera xoay không (bật "Xoay camera" —
  một khung hình đứng yên thì fresnel nào cũng trông hợp lý);
- bật "X-quang": khối có xuyên qua nền và qua nhà khác không;
- viền có đọc ra **khung xương** không, hay chỉ là khối tối mờ — đây chính là
  điều làm bản golden image lần trước bị bác;
- bật "Đối chiếu `fill-extrusion` đặc": kính có nằm đúng chỗ khối đặc không.

Với `building-atlas`:

- ảnh mặt tiền có **dính vào tường** không — kéo zoom ra vào, ô cửa phải to nhỏ
  theo toà nhà chứ không giữ nguyên kích thước trên màn hình (đó là khác biệt
  với `fill-extrusion-pattern`);
- đường sàn có rơi đúng vào số tầng của toà nhà không (`floor-height` lấy
  `height / num_floors`);
- kéo "Đêm": cửa sổ sáng phải rải ngẫu nhiên, khác nhau giữa các nhà cạnh nhau,
  và chỉ nằm đúng chỗ có kính;
- kéo "Bề rộng ô": số cột cửa trên mỗi tường đổi, không có gì khác đổi theo.

## Giới hạn đã biết

- Yêu cầu WebGL2. Trên WebGL1 layer từ chối vẽ và ghi một `console.warn`.
- Viền chỉ suy được đường **ngang** (mái, chân tường). Cạnh theo góc gãy giữa hai
  tường không suy được: bucket phát mỗi cạnh ring thành một quad độc lập, không
  có thông tin kề. Xem R-4 trong spec thiết kế.
- Dưới globe, hình học đúng nhưng fresnel tắt dần theo `u_projection_transition`
  — tile space không còn là hệ mà eye sống trong đó. Xem R-1.
- `building-atlas`: **mái không có ảnh riêng**, chỉ có `building-atlas-roof-color`.
  Bản gốc có 9 texture mái; ở đây MapLibre khoá `feature.patterns` theo layer id
  nên mỗi layer chỉ có một ảnh data-driven, và ảnh đó phải là mặt tiền.
- `building-atlas`: mặt nạ cửa sổ là **hằng số theo layer**, trong khi bản gốc
  ghép mặt nạ theo từng loại mặt tiền. Cùng một lý do.
- `model`: một mover bị cull cùng tile đã sinh ra nó. Với `maxzoom 14` thì tile
  rộng ~2,4 km ở vĩ độ này và tuyến dài 0,9–2,2 km, nên actor cách tile nhà nhiều
  nhất một tile — để hỏng, camera phải zoom sát tới mức actor đã ở rất xa ngoài
  màn hình. Xem MD-1 trong spec.
- `model`: picking trúng **điểm neo**, không trúng bóng model. Bóng đúng cần chiếu
  từng tam giác của từng bản sao.
- `model`: `map.on('idle')` không nổ khi có model đang động. Đúng hành vi, nhưng
  sẽ làm bất ngờ một harness — đặt `model-animation-rate` và
  `model-sway-amplitude` về 0 là lối thoát.

## Đọc số hiệu năng thế nào

`model` vẽ **một draw call cho mỗi cặp (tile, model)**, không phải một cho mỗi bản
sao. Đo trên khung nhìn phủ khu công nghiệp: **3.535 bản sao trong 16 lượt vẽ
instanced**, và kéo bản đồ ra khỏi khu thì **về 0** — điều bản gốc không làm được
vì nó tắt frustum culling.

Thời gian frame dưới SwiftShader **không** đo được GPU. Nhưng tách theo layer thì
626 cột đèn đắt gấp chín lần 2.747 cái cây, và nguyên nhân nằm ở asset chứ không ở
renderer: `street_light.glb` có 18.393 đỉnh, trong khi `docs/model-rules.md` của
chính bản gốc đặt trần 1.500 tam giác cho một prop instance hàng nghìn lần. Bản gốc
dùng đúng asset ấy và vẽ cả 651 cái mọi frame.

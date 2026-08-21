# demo-3d-parity

Cổng nghiệm thu bằng mắt cho hai layer type `building-glass` và `building-atlas`:
cùng một tập nhà, vẽ bằng `gtelmaps-gl-js` qua vector tiles, đặt cạnh bản
`3d-plugins` để so. Chọn layer bằng hai nút ở góc dưới trái.

## Chạy

```sh
pnpm install                      # từ gốc monorepo
cd packages/gtelmaps-gl-js && npm run build-dev    # demo nạp thẳng dist/
cd ../../apps/demo-3d-parity
node scripts/build-tiles.mjs       # sinh public/tiles từ GeoJSON của 3d-plugins
node scripts/build-sprite.mjs     # sinh public/sprite từ texture mặt tiền của 3d-plugins
pnpm dev                          # http://localhost:5180
```

Tile dựng với `--no-clipping`, và đó không phải tuỳ chọn: `building-atlas` trải
ảnh mái **một lần** lên mỗi footprint, nên nó chỉ đo được cái footprint được đưa
cho. Một toà nhà bị cắt ở biên tile sẽ được đo hai lần, mỗi nửa một lần, và hai
nửa nhận hai ánh xạ khác nhau. Khi kéo bản đồ, tile vào ra thì nửa nào đang hiện
cũng đổi — đọc ra là mái "giật".

`build-tiles.mjs` cần `tippecanoe` trên PATH. Nó đọc
`sdk/3d-plugins/public/data/overlay/buildings.geojson` (372 toà nhà KCN Châu Đức)
— **đúng tập dữ liệu bản plugin đang vẽ**, nên hai khung so cùng một thứ chứ
không phải hai tập trông giống nhau. Truyền đường dẫn khác làm tham số nếu cần.

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

# `building-glass` — bản đã hiện thực, và những chỗ kế hoạch sai

- **Ngày:** 2026-08-20
- **Trạng thái:** đã hiện thực và qua cổng; `building-atlas` chưa làm
- **Thay cho:** phần §6 (tầng render) của `2026-08-20-building-glass-design.md`, vốn viết cho backend Three
- **Lưu ý:** hai tài liệu kia nằm trên nhánh `spike/g0-g1-3d-core`; monorepo hiện đang ở `main`

## 1. Quyết định nền

Layer viết bằng **painter và GLSL của chính MapLibre**, không dùng Three.js.

Tiền đề cũ — *"để phát triển các layer như 3D-plugins thì cần một renderer
Three.js"* — sai với layer này. `fill_extrusion.vertex.glsl` đã dựng khối 3D
thật, đã có sẵn cả `#ifdef GLOBE` lẫn `#ifdef TERRAIN3D`, và đã mang đúng bốn
đại lượng fresnel cần: `posInTile`, `elevation`, `normal`, `a_normal_ed.w`.
Kính là một fragment shader khác, không phải một tầng render khác.

Đổi lại: **không fixture nào trong 1560 fixture bị đụng tới** (không cái nào khai
type mới), globe/terrain thừa hưởng miễn phí, và không có chi phí giao quyền
giữa hai renderer — thứ đã đo được ở lần thử trước là **1,75×–5,29×** chậm hơn.

## 2. Năm chỗ kế hoạch sai, phát hiện khi làm

**S-1. Bước 0 đã quá muộn.** Kế hoạch mở đầu bằng `git tag` để giữ 88 commit đã
bị reset. Khi chạy thì object **đã bị `git gc` thu dọn** — reflog cắt về 0 byte
lúc 14:53, repack thành một pack 963 MB, `git fsck --lost-found` không còn gì.
Thư mục `gk/` trong gitdir cho thấy công cụ bên ngoài chạy bảo trì. Cứu lại được
nhờ `dist/gtelmaps-gl-three-dev.js.map` còn `sourcesContent` cho cả 497 nguồn:
**498 file** đã trích ra `archive/g4-three-backend-recovered/`, gồm trọn
`src/strict/render_three/` (45 file) và toàn bộ phần building-glass.

> Đáng ghi: source map của bản dev là **một bản sao đầy đủ của mã nguồn**. Ở đây
> nó là bản sao duy nhất còn lại.

**S-2. Công thức `eyeInTile` trong kế hoạch thiếu một nửa.** Kế hoạch chỉ chép
phần quy đổi `xy`. Bản cứu được nói rõ phần còn lại, và nó không tuỳ chọn:
`eyeTile.z` để nguyên **mét** trong khi `xy` là đơn vị tile. Ma trận chịu được
đơn vị hỗn hợp vì mỗi trục mang scale riêng; **một vector hướng thì không**. View
direction là một phép trừ, nên cả hai đầu phải quy về cùng đơn vị bằng
`metresToTileUnits = pixelsPerMeter · EXTENT / tileWorldSize` trước khi trừ. Sai
chỗ này không báo lỗi — nó nghiêng vành sáng theo zoom, đọc như một lựa chọn ánh
sáng.

**S-3. `sdk-support` không được bỏ trống `android`/`ios`.** Kế hoạch ghi *"Không
có khoá `android`/`ios`"*. Nhưng `test/integration/style-spec/validate_spec.test.ts`
bắt buộc: một khi **bất kỳ** nền tảng nào có giá trị thì cả ba đều phải có, và
giá trị phải là số phiên bản `\d+\.\d+\.\d+`, một link issue của maplibre,
`supported`, hoặc `wontfix`. Giá trị `1.0.0-alpha.3` mà kế hoạch đề nghị **cũng
trượt** regex phiên bản. Đúng là `{js: "supported", android: "wontfix", ios:
"wontfix"}` — `wontfix` nói thật: fork này sẽ không có SDK native.

**S-4. gl-js chưa hề trỏ vào style-spec của workspace.** Nó khai
`"@maplibre/maplibre-gl-style-spec": "^24.8.1"` và phân giải về **gói npm thượng
nguồn**, nên codegen chạy xong mà **im lặng bỏ qua** `building-glass`. Quy ước
alias `workspace:@gis/gtelmaps-gl-style-spec@*` mới là thứ đúng, và
`gtelmaps-sdk-js` đã theo nó từ trước. Sau khi sửa, file `.g.ts` sinh ra **trùng
byte-for-byte** với file của bản đã mất — xác nhận `v8.json` tái lập đúng bộ
property.

**S-5. Hai công cụ của fork đang hỏng sẵn, không phải do thay đổi này.**
- `build/generate-style-spec.ts` sửa thẳng vào `spec.layer` dùng chung, nên nhánh
  `background` xoá `source`/`source-layer`/`filter` **vĩnh viễn** cho mọi type xử
  lý sau nó. Thượng nguồn không gặp vì `background` là type cuối. Đã sửa bằng bản
  sao nông.
- `test/integration/render/run_render_tests.ts` nạp `dist/maplibre-gl-dev.js` —
  tên artifact thượng nguồn mà fork đã đổi từ lâu. **`pnpm test-render` chưa từng
  chạy được**, và ENOENT không hề nhắc tới việc đổi tên.

## 3. Một quyết định depth đi xa hơn upstream

`draw_fill_extrusion.ts` dùng **một** `DepthMode` `ReadWrite` cho cả hai lượt.
Vô hại ở đó chỉ vì lượt hai ghi lại đúng giá trị lượt một vừa ghi.

`building-glass` cho lượt hai **`ReadOnly`**. Như vậy quy tắc ADR-001 §8.1 — một
stack đồng phẳng có đúng MỘT sheet ghi depth — đúng **do cấu trúc** chứ không do
trùng hợp, và bỏ được các lượt ghi depth trên lượt alpha-blend. Xác minh là
pixel-identical: 7/7 fixture khớp golden trước và sau khi đổi.

Chỗ này do `draw_building_glass.test.ts` phát hiện, không phải do đọc lại mã.

## 4. Cổng đã qua

| | |
|---|---|
| style-spec | **2220/2220** |
| gl-js unit | **2836/2836** (đường cơ sở 2804 + 32 test mới) |
| gl-js render | **1565/1567** — hai fixture đỏ là `text-local-ideographs/cjk-symbols` và `text-local-glyphs/cjk`, phụ thuộc font máy, **đỏ từ đường cơ sở** |
| họ fill-extrusion | **42/42** — seam `hasPatternSupport` không đổi hành vi cũ |
| typecheck / lint | sạch ở cả hai submodule |

Bảy fixture `building-glass` mỗi cái hỏi đúng một câu, trong đó có **một cặp đối
chứng**: `xray/through-extrusion` (kính xuyên khối đặc 30 m) và
`xray/off-is-occluded` (kính bị che đúng cách). Cặp này chứng minh chế độ depth,
chứ không phải một ảnh đơn lẻ trông hợp lý.

## 5. Rủi ro còn mở

- **R-1 globe.** Hình học đúng (`projectTileFor3D` lo cả hai phép chiếu), nhưng
  fresnel tắt dần theo `u_projection_transition` vì tile space không còn là hệ mà
  eye sống trong đó. Có vẽ, và khác đi một cách được nói rõ — không im lặng.
- **R-2 terrain.** Đã có: `#ifdef TERRAIN3D` + `a_centroid` kế thừa nguyên, và
  `elevation` đã cộng sẵn offset địa hình nên phép trừ với eye tuyệt đối vẫn
  đúng, không cần số hạng thêm. **Chưa có fixture terrain riêng.**
- **R-3 picking khi X-quang.** Chốt: `queryIntersectsFeature` không biết depth,
  giống hệt fill-extrusion. Kính X-quang trả về nhà mà người dùng **nhìn thấy**.
- **R-4 viền góc.** Chỉ suy được đường ngang (mái, chân tường). Cạnh theo góc gãy
  cần thông tin kề mà bucket không phát ra. Đường lui là một lượt `gl.LINES`.
- **R-5 `edgeDistance` wrap ở 32768** (giới hạn Int16). Chưa ảnh hưởng kính; sẽ
  ảnh hưởng `building-atlas` trên tường rất dài.

## 6. `building-atlas` — đã khảo sát, chưa làm

Kết quả khảo sát đáng ghi vì nó đổi chi phí: **không cần một vertex attribute mới
nào.** Bảy attribute của `3d-plugins` ánh xạ hết vào thứ MapLibre đã có —
`aLayer`/`aGlowLayer`/`aTint` thành paint property data-driven (binder tự bóc
tiền tố), `aIsRoof` là `normal.y != 0.0`, `aTopZ` chính là `height`, `aId` là một
property `-seed` đọc từ tile, và `aTile` tính trong shader từ `edgedistance` +
`elevation` như `fill_extrusion_pattern` đã làm. Nghĩa là **không đụng
`generate-struct-arrays.ts`**, và xung đột với `centroidVertexBuffer` (slot
`dynamicLayoutBuffer` duy nhất, terrain đang chiếm) biến mất.

Khác biệt phải chấp nhận: `3d-plugins` cộng dồn **số cửa sổ nguyên** quanh ring
nên góc nhà không cắt đôi ô cửa; `edgedistance` là mét thô nên sẽ lệch ở góc.

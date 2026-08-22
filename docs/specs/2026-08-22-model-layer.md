# Layer type `model` — glTF vẽ instanced, và bốn chỗ khác bản gốc

- **Ngày:** 2026-08-22
- **Trạng thái:** đã hiện thực và qua cổng — bốn ca đều chạy trên `demo-3d-parity`
- **Tiếp theo:** `2026-08-21-building-parity.md`

## 1. Quyết định nền

Layer viết bằng **painter và GLSL của chính MapLibre**, như `building-glass` và
`building-atlas`. Nhưng khác hai layer kia ở một điểm quyết định: `model` cần
**instancing**, và fork này trước đó không có instancing ở bất kỳ đâu —
`Program.draw` chỉ có đúng một `gl.drawElements`.

Đó là phần engine thật, và nó được chứng minh **trước** mọi thứ khác, bằng một
test GL giả, trước khi có một layer nào tồn tại.

## 2. Chỗ hơn hẳn bản gốc, và nó đo được

`3d-plugins` gom mỗi GLB vào một `THREE.InstancedMesh` rồi **tắt hẳn frustum
culling** (`ModelBatchGroup.ts:361`) — có lý do của nó: một bounding sphere trùm
cả khu công nghiệp thì cull sai còn tệ hơn không cull. Hệ quả: không LOD, không
streaming, không worker, không tiling.

MapLibre có sẵn đúng thứ bản gốc phải bỏ. Đưa instance vào vector tile lấy lại
culling ở đúng độ mịn, cộng streaming, LOD theo zoom, và mọi expression đánh giá
trong worker.

Đo trên máy này (SwiftShader, 1280×800, khung nhìn phủ khu công nghiệp):

| | draw call | bản sao vẽ ra |
|---|---|---|
| Nhìn vào khu có model | **52** (16 instanced) | **3.535** |
| Kéo bản đồ ra khỏi khu | 15 | **0** |

**Kéo ra khỏi khu thì số bản sao về 0.** Bản gốc không làm được điều đó, về mặt
kiến trúc chứ không phải về mặt tinh chỉnh. Và không có `createVertexArray` nào
ở trạng thái ổn định — VAO nằm trên từng run nên frame thứ hai trở đi không dựng
lại gì.

**Một điều phải nói thẳng về thời gian frame.** Con số dưới SwiftShader không đo
được GPU. Nhưng phân tách theo layer thì nói được điều có ích:

| | bản sao | draw call | ms/frame (SwiftShader) |
|---|---|---|---|
| Không model | 0 | 36 | 19,5 |
| Chỉ cây | 2.747 | 39 | 147 |
| Chỉ hạ tầng | 626 | 45 | **1.368** |
| Chỉ xe và người | 162 | 40 | 279 |

626 cột đèn đắt gấp chín lần 2.747 cái cây. Nguyên nhân không nằm ở renderer mà
ở **asset**: `street_light.glb` 18.393 đỉnh, `fire_hydrant.glb` 18.452,
`power_pole.glb` 17.373 — mỗi cái ~9.500 tam giác, trong khi `docs/model-rules.md`
của chính bản gốc đặt trần **1.500 tam giác** cho một prop được instance 100–5.000
lần. Sáu lần trần. Bản gốc dùng đúng những asset ấy và vẽ **cả 651 cái mọi frame**,
nên nó chịu đúng chi phí này cộng thêm phần đã ra khỏi màn hình.

Nói cách khác: khoản đắt còn lại là một bài toán asset, và nó nằm nguyên vẹn ở cả
hai bên. Chỗ ta hơn là số bản sao thực sự phải vẽ.

## 3. Bốn dữ kiện bẻ lái thiết kế

**D-1. `layoutType()` chỉ biết `'color'` và `'number'`**
(`src/data/program_configuration.ts:855-869`). Một property kiểu `array` đi qua
`ProgramConfiguration` chạm `defaultLayouts['array']` → `TypeError`.

**D-2. Binder tự tạo vertex buffer, và không chỗ nào truyền divisor vào được.**
Muốn paint data-driven chạy theo instance thì phải luồn một cờ qua bốn lớp binder.
**Không làm.** Layer để `ProgramConfiguration` sinh ra rỗng và tự nắm một mảng
instance viết tay — cả ngân sách 16 ô attribute thuộc về nó (dùng 7).

**D-3. Expression không dựng được mảng từ expression khác.** Đây là chỗ một fixture
phát hiện ra lỗi thiết kế: `model-rotation` kiểu mảng ba phần tử chỉ lái được bằng
`match` trên literal, mà dữ liệu thật mang một góc **liên tục** cho từng feature.
Đổi thành ba số `model-bearing` / `-pitch` / `-roll`.

**D-4. `prepare()` bắt attribute bằng `/in ([\w]+) ([\w]+)/`** — một qualifier độ
chính xác làm câu khai thành ba từ và `bindAttribLocation` không được gọi. Mọi
attribute tĩnh khai `in vec4 a_x;`, không bao giờ `in highp vec4 a_x;`.

## 4. Bốn chỗ khác bản gốc, đều là sửa lỗi

**M-1. Gió chạy xuôi chiều.** Bản gốc dùng `sin(t + phase)`, nên mặt sóng gust
chạy **ngược** chiều gió. Nhìn một rặng cây lớn là thấy.

**M-2. Bước sóng buộc vào hướng gió.** Bản gốc lấy pha từ
`dot(worldXY, vec2(0.06, 0.045))` — một vector cứng **độc lập** với `uWindDir`,
nên đổi hướng gió không đổi hướng sóng chạy.

**M-3. Gió và animation chồng được lên nhau.** `if (this.vat) return;` của bản gốc
là tai nạn của hai bản vá `onBeforeCompile` trên cùng một material Three, không
phải ràng buộc thiết kế. Ở đây một người đang đi vẫn đung đưa được.

**M-4. Bố cục texture VAT khả chuyển.** Bản gốc đặt `width = vertexCount = 5832`,
trong khi `MAX_TEXTURE_SIZE` bảo đảm của WebGL2 là **2048**. Đó là một lỗi thật.
Ở đây texture xếp hàng ở bề rộng cố định 2048.

Cộng thêm hai thứ bản gốc **không có**:

- **Clip nằm trong GLB chạy được.** `loadRig` của bản gốc là code chết và không có
  `AnimationMixer` nào trong cả repo; nó chỉ chạy `.vat.bin` bake sẵn bằng Blender.
  Ở đây một đường animation duy nhất, hai nguồn: worker lấy lại mẫu clip trong
  chính file glTF. Đối chiếu với bản bake Blender của `patrol.glb`: **bbox trùng
  tới bốn chữ số thập phân trên cả sáu biên**, frame đầu lệch **0,21 mm**.
- **Tuyến tính trên GPU.** Bản gốc cập nhật ma trận **mọi** instance trong nhóm mỗi
  khi **bất kỳ** actor nào di chuyển, và tra đoạn bằng quét tuyến tính từ chỉ số 1.
  Ở đây tuyến được lấy mẫu theo **bước quãng đường đều** lúc parse tile, nên tra
  cứu là một phép chia và **hai lần đọc texture mỗi đỉnh** — không có một dòng CPU
  nào mỗi frame.

## 5. Hai chỗ bắt được bằng fixture, không bằng suy luận

**Chiều cull.** Đếm phép phản chiếu cho ra `frontCCW`. Sai. Không gian model thuận
tay phải, không gian tile thuận tay trái, nên phép đảo trục bắc *có vẻ* đảo chiều
cuốn — nhưng ma trận chiếu mang sẵn một phép lật nữa và đưa nó về chỗ cũ. Cái sai
ấy **vẫn render**: mọi mặt sáng từ bên trong, đọc như một lựa chọn ánh sáng.
`model-cube/instanced` quyết.

**Dấu bearing.** `model-bearing/compass` dựng bốn bản ở 0/90/180/270 nhìn thẳng từ
trên xuống. Sai dấu cho ra một cảnh hợp lý với mọi chiếc xe quay đít về phía trước.

## 6. Một lỗi tất định bắt được nhờ chạy fixture hai lần

`model-animation/frozen` lần đầu ra hai kết quả khác nhau. Nguyên nhân: bake xong
**sau** khi bản đồ đã báo idle, nên ảnh chụp bắt đúng khoảnh khắc trước đó.
`Style.isLoaded()` nay chờ cả model và bake — cùng chỗ nó đã chờ `imageManager`.
Không có nó, `map.on('idle')` nói dối với bất kỳ ai chụp ảnh, không chỉ với harness.

## 7. Rủi ro còn lại

| # | Rủi ro | Trạng thái |
|---|---|---|
| MD-1 | Actor bị cull cùng tile đã sinh ra nó | **Chấp nhận, có biên** — source model đặt `maxzoom 14`, tile ~2,4 km ở vĩ độ này, tuyến 0,9–2,2 km, nên actor cách tile nhà nhiều nhất một tile |
| MD-2 | Sentinel `scale` âm mang `model-height` | **Chấp nhận, ghi rõ** — đường thay thế bắt parse tile xếp hàng sau nạp asset |
| MD-3 | Đổi `model-color`/`model-scale` phải parse lại tile | **Chấp nhận** — `symbol` có đúng tính chất này với `icon-image` |
| MD-4 | Mỗi mover mang một bản sao hình học tuyến của nó | **Chấp nhận** — 100 tuyến ngắn là vài chục KB; gom chung cần một bảng dùng chung mà tile không có chỗ để |
| MD-5 | Picking trúng điểm neo, không trúng bóng model | **Chấp nhận, ghi rõ** — bóng đúng cần chiếu từng tam giác, hoặc một lượt pick theo depth |
| MD-6 | Asset gấp sáu lần trần tam giác của chính bản gốc | **Mới** — không phải lỗi renderer, và bản gốc chịu nặng hơn. Đường sửa là decimate asset |
| MD-7 | Globe: tuyến gần rìa cầu clip sai | **Chấp nhận** — hình học và pha gió vẫn đúng |
| MD-8 | WebGL1 không thấy gì | **Chấp nhận** — `building-glass` đã lập tiền lệ |
| MD-9 | `map.on('idle')` không nổ khi có model đang động | **Chấp nhận, ghi rõ** — đặt tốc độ animation và biên độ gió về 0 là lối thoát |

# Đưa `building-atlas` và `building-glass` về 1:1 với 3D-plugins

- **Ngày:** 2026-08-21
- **Trạng thái:** đã hiện thực và qua cổng
- **Tiếp nối:** `2026-08-20-building-glass-native.md`
- **Viewport đối soát:** `18.15/10.59153/107.169352/-36.5/64`

## 1. Sáu lệch, và nguyên nhân thật của từng cái

Điều đáng ghi trước hết: **không lệch nào là do hiểu sai bài toán**. Năm trong
sáu quy về một ràng buộc thiết kế cũ nới được bằng hai dòng, và một nằm hoàn toàn
ở demo.

| | Hiện tượng | Nguyên nhân |
|---|---|---|
| A-1 | mái không có vật liệu | `feature.patterns` khoá theo layer id → mỗi layer một ảnh data-driven, và ảnh đó phải dành cho mặt tiền |
| A-2 | chiều cao gần bằng nhau | **không bên nào tính sai**: `3d-plugins` nhân 2.4 ở config của app, demo ta thì không |
| A-3 | cửa sổ lệch ở các mặt | ba nguyên nhân chồng lên nhau, xem §2 |
| A-4 | material không mịn | sprite demo 128² trong khi bản gốc upload 256², và ở z18.15 mặt tiền đang bị **phóng to** |
| G-1 | kính chưa trong suốt | bản gốc **luôn** `depthTest:false` — chế độ ta gọi là X-quang **chính là** kính của bản gốc |
| G-2 | mỗi toà như hai geometry | chỉ suy được đường ngang; thiếu cạnh dọc nối chúng lại |
| G-3 | X-quang, viền khuất | bản gốc: fill `FrontSide`, viền `LineSegments` không cull |

## 2. A-3 có **ba** nguyên nhân, và cái thứ ba không ai ngờ

1. `edgedistance` là độ dài thô; bản gốc cộng dồn **số ô nguyên**.
2. Demo dùng một mặt nạ cho cả năm vật liệu mặt tiền.
3. **`edgedistance` của thượng nguồn đứt quãng ở *mọi* đỉnh ring.** Vòng lặp ghi
   đầu **thấp** của khoảng ở `p1 = geometry[p]` và đầu **cao** ở
   `p2 = geometry[p-1]`, nên đỉnh mà hai cạnh dùng chung nhận `D_p` từ cạnh này
   và `D_p + dist_p + dist_{p+1}` từ cạnh kia. `fill-extrusion-pattern` sống được
   vì nó neo vào screen space nên không ai để ý; với mặt tiền đó là một bước nhảy
   pha ở từng góc nhà. Sửa bằng cách đảo đầu gán — không tốn gì.

## 3. Một bảng mã **chứng minh được** là không hiện thực nổi

Kế hoạch ban đầu định mã hoá góc bằng `0/−1` ở một đầu và `1/2` ở đầu kia, kiểm
bằng `min(s, 1 − s)`. Nó không chạy được, và đây không phải phỏng đoán:

| p1 sắc | p2 sắc | miền `s` | `min(s, 1−s)` bằng 0 tại |
|---|---|---|---|
| có | không | [0, 1] | 0 ✓ **và 1 — giữa tường ✗** |
| không | không | [−1, 2] | **0 và 1 — hai dải giả ✗** |

Ca "có/không" *cần* một dải ở `s = 1`; ca "không/không" *cấm* nó. Cùng một đầu
vào, hai đầu ra bắt buộc khác nhau ⇒ không hàm điểm nào của `s` thoả cả hai.

Bảng đúng là `{0, 1, 2}` với `min(s, 2 − s)`, và nó còn được thêm ba thứ: mọi giá
trị là số nguyên không âm nên `Math.round` là phép đồng nhất; biểu thức đối xứng
quanh `s = 1` nên chiều duyệt p1/p2 không còn quan trọng; và bề rộng dải tính
bằng pixel giữ nguyên ở mọi ca vì `fwidth` co giãn cùng nhịp với `d`.

## 4. Ngân sách vertex attribute là ràng buộc cứng

`building-atlas` **đã tốn 14 ô** khi mọi paint đều data-driven — cao nhất
codebase. Thêm hai property pattern nữa và `-roof-scale` là **23**, trên trần bảo
đảm **16** mà ANGLE báo đúng.

Cách xử không phải mẹo: chỉ phơi **hai** ô rect và bỏ `pixel_ratio_from/to`.
`pixelRatio` chỉ có nghĩa khi ảnh neo vào screen space, mà layer này cố ý không
neo — hai `#pragma` đó đang khai mà không dùng dòng nào. Kèm hạ
`building-atlas-roof-color` xuống data-constant và chuyển `bay-width` sang
layout, ngân sách về **15**, còn một ô dư.

Kèm một cửa chặn ở `program.ts` đọc `MAX_VERTEX_ATTRIBS` và ném lỗi nêu con số.
Trước đó vượt trần là `INVALID_VALUE` im lặng rồi hỏng ở chỗ khác.

## 5. Ba lỗi tiềm ẩn, chỉ phát tác khi có hơn một property pattern

Cả ba đọc mã là thấy, cả ba hỏng im lặng:

- `CrossFadedConstantBinder.setUniform` so `=== 'u_pattern_to'` → uniform của mái
  **không bao giờ được đặt**, mái lấy mẫu texel (0,0).
- `getBinding` kiểm `startsWith('u_pattern')` → cấp `Uniform1f` cho một `vec4`.
- `setConstantPatternPositions` phát cùng một cặp rect cho **mọi** binder hằng số.

## 6. Cổng

| | |
|---|---|
| style-spec | **2337/2337** |
| gl-js unit | **2881/2881** |
| gl-js render | **1575/1577** — hai fixture `text-local-*` đỏ từ đường cơ sở |
| typecheck / lint | sạch, và `npm run typecheck` **chạy được lần đầu** trong fork này |

Mọi fixture `building-*` đã sinh lại và **nhìn từng ảnh**, không duyệt hàng loạt.
Ba cặp mang tính đối chứng: `xray/hidden-edges` ± (lượt mặt sau),
`bay-width/wide` so `default` (đúng một nửa số ô), và `edge/none` so `edge/wide`.

## 7. Hai công cụ của fork vốn hỏng sẵn, tìm ra theo cùng một cách

`tsconfig.dist.json` kiểm `dist/maplibre-gl.d.ts` — tên artifact fork đã đổi từ
lâu — nên nửa sau của `npm run typecheck` **chưa từng chạy**, dừng ở TS18003 "no
inputs were found", một thông báo không nhắc gì tới việc đổi tên. Đúng kiểu hỏng
của `run_render_tests.ts` đợt trước, và tìm ra theo đúng cách đó: chạy cổng rồi
đọc lỗi thật thay vì tin rằng nó xanh.

## 8. Rủi ro

| # | Rủi ro | Trạng thái |
|---|---|---|
| R-1 | Globe — fresnel tắt dần | không đổi |
| R-2 | Terrain — **vẫn chưa có fixture riêng** | không đổi |
| R-3 | Picking khi X-quang không biết depth | **X-quang giờ là mặc định**, nên nó chuyển từ trường hợp hiếm thành trường hợp thường |
| R-4 | cạnh dọc ở góc | **đóng** |
| R-5 | `edgeDistance` tràn ở 32768 | **đóng** cho atlas |
| R-6 | mái không có OMBB và không có `stretch`; **209/372 toà (56%)** dùng texture có thiết bị vẽ sẵn nên sẽ thấy lặp | **mới**, đã chốt không làm; demo giảm nhẹ bằng bước lát ~24 m |
| R-7 | không mipmap trên atlas theo tile | **mới**, không nhìn ra ở z18.15 |
| R-8 | toà nhà vắt qua hai tile lệch pha ô cửa ở mối nối | **mới**, không sửa được trong phạm vi một tile |
| R-9 | `bays = max(1, round(...))` không cộng được: tường đã dày đỉnh cho ô hẹp hơn | **mới**; mercator không chèn đỉnh nên chỉ chạm globe. Đường lui: cộng dồn theo nhịp góc-đến-góc, ~20 dòng trong cùng hook |
| R-10 | ngân sách attribute còn **một ô** | **mới**, có cửa chặn và test |

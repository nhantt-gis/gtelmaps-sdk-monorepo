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
| R-7 | không mipmap trên atlas theo tile | **Sai ở bản ghi đầu.** Nó nhìn ra rất rõ ở z18.15 — chỉ là ở vùng **xa**, chỗ tôi không soi. Xem §9. |
| R-8 | toà nhà vắt qua hai tile lệch pha ô cửa ở mối nối | **mới**, không sửa được trong phạm vi một tile |
| R-9 | `bays = max(1, round(...))` không cộng được: tường đã dày đỉnh cho ô hẹp hơn | **mới**; mercator không chèn đỉnh nên chỉ chạm globe. Đường lui: cộng dồn theo nhịp góc-đến-góc, ~20 dòng trong cùng hook |
| R-10 | ngân sách attribute còn **một ô** | **mới**, có cửa chặn và test |

---

## 9. Đợt thứ hai: bốn báo cáo, ba nguyên nhân

Người dùng báo bốn thứ về `building-atlas`: texture không mịn; mái lặp hoa văn;
hoa văn mái như chuyển động khi kéo chuột; và cửa sổ ban đêm chớp tắt khi kéo
chuột. Chúng **không** cùng một nguyên nhân, dù ba trong bốn nghe giống nhau.

### 9.1 Chỗ tôi ghi sai lần trước

R-7 ghi "không nhìn ra ở z18.15". Sai. Nó rất rõ — nhưng ở **vùng xa** của cùng
khung hình, chỗ tôi đã không phóng to để soi. Cắt vùng xa ra và phóng 4× thì mái
lấm tấm như muối tiêu và mặt tiền tan thành nhiễu. Đo ra con số: một toà nhà ở xa
phủ **~21 texel trong một pixel**; ngay vùng gần cũng đã 5 texel. Kết luận "không
nhìn ra" đến từ việc chỉ soi vùng gần.

### 9.2 Ba nguyên nhân

**Mái (báo cáo 2 và 3).** Tám ảnh mái của bản gốc là **bản vẽ mái**, không phải
vật liệu: lan can chạy quanh bốn cạnh, ống nối hai đầu, giàn thiết bị ở chỗ cố
định. Lát lặp một bản vẽ như thế thì lan can chạy xuyên giữa mái. Nay map một lần
lên mỗi toà, theo **hình chữ nhật nhỏ nhất bao quanh footprint**. Hộp song song
trục không đủ: nhà xưởng xoay 30° thì hộp ấy rộng gấp **2,4 lần** footprint.

Còn "hoa văn mái chuyển động" thì không phải hoa văn chuyển động: đó là vân
moiré của phép lấy mẫu dưới ngưỡng Nyquist, đổi theo từng bước lưới mẫu dịch đi.
Không có đại lượng nào trong đường vẽ đổi giữa hai khung hình — đã kiểm bằng số:
hai khung liên tiếp với camera đứng yên khác nhau **0,00%**.

**Cửa sổ chớp tắt (báo cáo 4).** Không phải răng cưa. `v_seed` là số nguyên chính
xác, hằng số theo feature, nhưng nội suy phối cảnh trả `V·(1±ε)`, nên `floor` nằm
đúng trên lưỡi dao của chính nó. Một bước `floor` đẩy đối số hash đi **45,26 rad**
— đảo hẳn kết quả. Bản gốc khai `flat` cho đúng biến này; bản port bỏ mất. Cộng
thêm: prelude đặt `mediump` trong khi đối số `sin` lên tới **5,2·10⁴**, ngoài
khoảng ±2¹⁴ mà `mediump` bảo đảm — `fill_pattern` và `line_pattern` đều đã tự
nâng lên `highp`, layer này thì chưa.

**Độ mịn (báo cáo 1).** Ảnh gộp chung một atlas **không mang được mipmap**: viền
chỉ rộng một pixel, nên ngay mức thu nhỏ đầu tiên đã trộn sang ảnh bên cạnh, và
`IMAGE_PADDING` là hằng số dùng chung với icon nên không nới riêng được. Bản gốc
tránh được vì nó dùng `sampler2DArray` — mỗi vật liệu một lớp, mipmap và
anisotropy an toàn theo cấu trúc.

### 9.3 Chỗ đã làm, và chỗ còn lại

Bốn tap trên lưới xoay theo đạo hàm **không phải** mipmap; nó xử lý được khoảng
2× thu nhỏ, còn vùng xa cần tới mức 4,4. Đo lại vùng xa sau khi sửa: mái đã sạch
hẳn, mặt tiền đọc ra ô cửa thay vì nhiễu, nhưng tường ở góc rất nghiêng vẫn còn
răng cưa. Muốn hết hẳn thì layer phải sở hữu texture của chính nó dưới dạng
`sampler2DArray` như bản gốc — đổi lại còn **rẻ hơn** về vertex attribute (một
chỉ số lớp thay cho hai ô rect), nhưng là một hệ thống con mới.

**R-11 (mới):** không có anisotropy, nên tường nhìn ở góc rất nghiêng vẫn răng
cưa. Cùng một nguyên nhân với R-7 và cùng một đường sửa.

---

## 10. Đợt thứ ba: mái vẫn giật, và nguyên nhân không nằm trong shader

Báo cáo: mái vẫn giật material khi rê chuột, và có cảm giác z-index.

### 10.1 Loại trừ trước, kết luận sau

Ba phép đo, mỗi phép loại một khả năng:

- **Hai khung liên tiếp, camera đứng yên: khác nhau 0,00%.** Không có gì trong
  đường vẽ thay đổi theo thời gian.
- **Hai lần nạp trang độc lập cùng camera: khác nhau 0,00%.** Không có bất định
  trong bucket (thứ tự earcut, v.v.).
- **Kéo đi rồi `jumpTo` về đúng camera cũ: khác nhau 0,000%, sai lệch kênh lớn
  nhất 0.** Ảnh trùng khít từng bit.

Chú ý phép thứ ba: làm bằng `panBy` ngược lại thì ra 14% khác nhau — nhưng đó là
vì `panBy` **không phải phép nghịch của chính nó khi có pitch**, camera về lệch
0,25 m, tức nửa pixel. Đo sai suýt dẫn tới kết luận sai.

Cũng đã loại: bốn tap lấy mẫu (tắt đi, mái vẫn y như cũ), và ánh xạ UV mái (đo
tại điểm địa lý cố định, lệch 2–12/255 — đúng bằng sai số của việc chiếu điểm mặt
đất dưới một cái mái nằm trên cao).

### 10.2 Nguyên nhân

**Dữ liệu vào, không phải shader.** tippecanoe cắt feature theo biên tile. Ba toà
nhà trong khung nằm vắt qua biên tile z16, nên mỗi tile chỉ nhận **một nửa**
footprint. `building-atlas` trải ảnh mái một lần lên cái footprint nó được đưa
cho — nên hai nửa được đo riêng và nhận hai ánh xạ khác nhau.

Và tile thì vào ra liên tục khi kéo bản đồ. Đo trong lúc kéo: giữa cú kéo có lúc
chỉ còn **một** tile được vẽ, rồi tile mới xuất hiện. Nửa nào đang hiện cũng đổi
theo, nên mái nhảy — đúng cái "giật material", và hai nửa chồng nhau ở dải buffer
cho ra đúng cái "cảm giác z-index".

`--no-clipping` khiến mọi tile mang trọn footprint. Đã kiểm: hai bản sao của cùng
một toà nay trùng khít từng điểm, nên cùng ánh xạ, và việc vẽ chồng trở thành vô
hình.

### 10.3 Điều kiện phải nói ra

Layer **không có cách nào tự biết** footprint nó nhận đã bị cắt hay chưa. Nên đây
là điều kiện của dữ liệu, ghi vào doc của `building-atlas-roof-pattern` và vào
README của app demo, chứ không phải thứ sửa được trong shader.

**R-12 (mới):** `building-atlas-roof-pattern` đòi feature vào tile nguyên vẹn.

---

## 11. Đợt thứ tư: mái vẫn biến dạng, và thủ phạm là bản vá của đợt trước

Báo cáo kèm ba ảnh cùng một khu vực ở các mức zoom khác nhau: mái của vài toà bị
bôi thành vệt, bản vẽ mái tan ra thành gạch ngang.

### 11.1 Tái hiện được, và chỗ trước đó tìm sai

Ba đợt trước đều đo ở z18.2 trở lên và không thấy gì. Tái hiện được ở **z17.9**
trên khung rộng hơn — báo cáo nói "dưới 18.5" và đúng là như vậy. Bài học: khung
hình dùng để đo phải là khung hình của người báo, không phải khung tiện tay.

Trước đó đã loại trừ, và các phép đo ấy vẫn đúng: hộp định hướng chính xác cho
**cả 372** footprint (mọi đỉnh nằm trong hộp của chính nó, biên chuẩn hoá lớn
nhất đúng bằng 1.0000); UV mái không tràn khỏi [0,1] ở bất kỳ zoom nào; hai bản
sao của một toà qua hai tile trùng khít từng điểm sau `--no-clipping`.

### 11.2 Nguyên nhân

**Chính chùm tám tap thêm vào ở đợt ba.** Phép thử có đối chứng tách được ngay:
hạ xuống **một** tap thì mái sạch hẳn còn mặt tiền ở xa lại lấm tấm; tám tap thì
ngược lại.

Hai bề mặt cần hai cách, và lý do là cấu trúc:

- Ảnh **tường** lặp mỗi ô cửa, nên một chùm tap nằm gọn trong một lần lặp.
- Ảnh **mái** trải **một bản** suốt toà nhà, nên cùng chùm tap ấy quét qua một
  phần lớn bản vẽ mái.

Cộng thêm một chỗ ước lượng thô: trục dài của vệt phủ lấy bằng "cái dài hơn trong
hai đạo hàm theo trục màn hình", chỉ đúng khi hai đạo hàm gần vuông góc trong
không gian ảnh. Một toà nhà dài nhìn ở phương vị xiên thì không, và chùm tap dài
gấp mấy lần vệt thật.

Mái cũng không phải trường hợp thu nhỏ: một ảnh trải trọn một mái là xấp xỉ một
texel mỗi pixel. Nó không cần chùm tap ngay từ đầu.

### 11.3 Điều đáng giữ lại

Ba đợt liên tiếp tôi kết luận "vẫn là răng cưa" và mỗi lần lại thêm một lớp lọc.
Lớp thứ ba chính là lỗi. Phép thử có đối chứng — tắt hẳn thứ mình vừa thêm — cho
câu trả lời trong một lần chụp, và lẽ ra phải là bước **đầu tiên** chứ không phải
bước cuối.

**R-13 (mới):** mặt tiền và mái lấy mẫu khác nhau, và sự khác nhau ấy có lý do
cấu trúc. Ai gộp chúng lại làm một sẽ làm hỏng một trong hai.

---

## 11. Đợt thứ tư: vẫn giật, và lần này là hai mức zoom tile chồng nhau

Đợt ba kết luận nguyên nhân là tile bị cắt, sửa bằng `--no-clipping`. Đúng, nhưng
**chưa đủ** — vẫn còn một nguồn thứ hai cho cùng một triệu chứng, và nó lớn hơn.

### 11.1 Cách tìm ra

Chụp ở pitch 50 thì tái hiện được ngay; ở pitch 41 thì không. Dựng `v_roof_uv`
thành màu cho thấy nhiều mái bị **rách răng cưa** — chữ ký của hai mặt đồng phẳng
tranh nhau, không phải lỗi ánh xạ. Đếm tile ở `17.6/pitch 50`: **ba** tile được vẽ
cùng lúc, một **z15** và hai **z16**.

Hai phép đo trước đó suýt dẫn tôi đi sai:
- Đo `footprintSize` ra dưới **một texel mỗi pixel** — tức mái gần như không bị
  thu nhỏ, nên mọi giả thuyết về răng cưa lấy mẫu đều sai.
- Đặt số tap từ 8 xuống 1 thì ảnh **không đổi** — xác nhận điều trên.

### 11.2 Nguyên nhân

MapLibre cho tile thô đứng thay khi tile mịn còn đang tải. Cùng một toà nhà vì
thế đến layer **hai lần**, và tile thô mang ít độ phân giải hơn nên footprint
không cùng hình. Layer trải một bản ảnh mái lên cái footprint nó được đưa cho,
nên hai bản nhận hai ánh xạ, hai mái đồng phẳng xé nhau từng pixel, và bên nào
thắng thì đổi theo camera.

Điều đó giải thích cả hai điều kiện người dùng nêu:
- **chỉ dưới z18.5** — trên đó khung nhìn nằm gọn trong các tile mịn;
- **pitch quanh 50** — pitch cao kéo vùng xa vào khung, nơi tile thô còn đứng thay.

### 11.3 Sửa

`getStencilConfigForOverlapAndUpdateStencilID` — đúng cái raster và hillshade đã
dùng cho cảnh này. Tile mịn vẽ trước và đóng dấu stencil; tile thô bị từ chối ở
chỗ nó định vẽ đè. `fill-extrusion` không cần tới nó chỉ vì hai bản của nó trông
giống hệt nhau.

**Chỉ áp cho đường một lượt.** Ở đường hai lượt stencil đã có chủ — nó giữ hai mặt
đồng phẳng trùng nhau khỏi blend hai lần — và một bộ đệm không làm được cả hai
việc. Lần đầu tôi thay luôn cả hai và làm hỏng fixture `translucent`; fixture đó
bắt được.

**R-13 (mới):** `building-atlas` mờ một phần (`opacity < 1`) vẫn còn chồng lấn
giữa hai mức zoom tile.

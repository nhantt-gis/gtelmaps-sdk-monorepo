/**
 * Chỗ trám cho một nhánh mã chết.
 *
 * `<Map>` của react-map-gl chỉ `import('@gis/gtelmaps-sdk-js')` khi KHÔNG được
 * truyền `mapLib`. Trang này luôn truyền (`window.gtelmapsgl`, nạp bằng thẻ
 * `<script>`), nên nhánh ấy không bao giờ chạy — nhưng rollup vẫn phải phân giải
 * nó lúc build, rồi chết ở `import "maplibre-gl"` bên trong: `package.json` của
 * fork trỏ `main` vào `dist/maplibre-gl.js`, tên artefact của bản thượng nguồn mà
 * fork không sinh ra.
 *
 * Trám bằng một module ném lỗi thay vì một object rỗng, vì hai lý do: nó chỉ ném
 * khi chunk ấy thật sự được nạp — tức khi giả định "luôn có `mapLib`" đã sai — và
 * lúc ấy thông điệp nói thẳng chuyện gì xảy ra thay vì để lỗi nổ ở một chỗ khác.
 *
 * Cách sửa tận gốc là chữa entry point của `@gis/gtelmaps-gl-js`; xem
 * `docs/specs/2026-09-03-react-3d-layers.md` §6.
 */

throw new Error(
  'Không có `mapLib`: trang này nạp bundle bằng thẻ <script> và truyền ' +
    '`window.gtelmapsgl` vào <Map>. Nhánh nạp SDK qua import không dùng được ở đây.',
);

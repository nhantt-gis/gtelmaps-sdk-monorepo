import {defineConfig} from 'vite';
import react from '@vitejs/plugin-react';
import {existsSync} from 'node:fs';
import {resolve} from 'node:path';

const root = resolve(__dirname, '../..');
const glJs = resolve(root, 'packages/gtelmaps-gl-js');

/**
 * Cây dữ liệu của app, sinh ra bằng `scripts/build-tiles.mjs`.
 *
 * Trong đó có symlink `gl` trỏ vào `dist/` của fork, nên `server.fs.allow` phải
 * mở tới đó — Vite từ chối phục vụ file nằm ngoài gốc project, và một symlink
 * không làm nó đổi ý.
 */
const publicDir = resolve(__dirname, 'public');

/**
 * Trả 404 cho tile chưa từng được sinh ra.
 *
 * tippecanoe không ghi tile ở chỗ không có gì để vẽ, còn SPA fallback của Vite
 * thì trả `index.html` kèm 200 cho mọi thứ nó không tìm thấy — nên bộ giải mã
 * gặp HTML ở chỗ nó chờ protobuf và báo "Unimplemented type", một câu không nói
 * gì về nguyên nhân thật. Tệ hơn: tile ấy bị tính là **hỏng** chứ không phải
 * **rỗng**, và MapLibre giữ lại một tile thô hơn để lấp chỗ trống — cùng một dãy
 * nhà đến từ nhiều mức zoom một lúc, và ở lại vĩnh viễn.
 *
 * Gắn vào **cả hai** server. `configureServer` là `vite dev`; thiếu
 * `configurePreviewServer` thì `vite preview` phục vụ bản build với đúng cái lỗi
 * ấy — đo được trên bản build đầu tiên sau khi bỏ symlink:
 * `Unable to parse the tile … got error: Unimplemented type: 4`.
 *
 * Điều này cũng có nghĩa: bất kỳ server nào phục vụ `dist/` đều phải trả 404 cho
 * tile không có. Một static server bình thường làm đúng; chỉ SPA fallback mới sai.
 */
const missingTilesAre404 = {
  name: 'missing-tiles-are-404',
  configureServer: (server) => use(server),
  configurePreviewServer: (server) => use(server),
};

function use(server: {middlewares: {use: (fn: Handler) => void}}) {
  server.middlewares.use((req, res, next) => {
    const path = (req.url ?? '').split('?')[0];
    const isTile = path.startsWith('/tiles/');
    if (isTile && path.endsWith('.pbf') && !existsSync(resolve(publicDir, `.${path}`))) {
      res.statusCode = 404;
      res.end();
      return;
    }
    next();
  });
}

type Handler = (
  req: {url?: string},
  res: {statusCode: number; end: () => void},
  next: () => void,
) => void;

export default defineConfig({
  plugins: [react(), missingTilesAre404],
  publicDir,
  server: {
    port: 5180,
    fs: {allow: [root, glJs]},
  },
  resolve: {
    alias: {
      // Xem `src/sdk-fallback.ts`: nhánh nạp SDK trong `<Map>` là mã chết ở trang
      // này, nhưng rollup vẫn phải phân giải được nó thì `vite build` mới chạy.
      '@gis/gtelmaps-sdk-js': resolve(__dirname, 'src/sdk-fallback.ts'),
    },
  },
  build: {
    /**
     * Bundle của renderer là UMD, và Rollup không tự nhận ra nó.
     *
     * Lúc `dev` thì esbuild gói lại nên `import` chạy được; lúc `build` thì
     * Rollup đọc thẳng file và báo `"default" is not exported`. Plugin CommonJS
     * mặc định chỉ ngó `node_modules/`, mà đường tới file này đi qua symlink
     * workspace nên nó nằm ngoài. Khai thêm chính file ấy — và giữ
     * `/node_modules/`, vì `include` là thay thế chứ không phải bổ sung.
     */
    commonjsOptions: {include: [/gtelmaps-gl-dev\.js$/, /node_modules/]},
  },
  optimizeDeps: {
    // `<Map>` chỉ `import('@gis/gtelmaps-sdk-js')` khi KHÔNG được truyền `mapLib`,
    // mà ở đây luôn có — nhánh ấy là mã chết. Nhưng bộ quét phụ thuộc của Vite
    // vẫn đi vào nó, rồi chết ở `import "maplibre-gl"` bên trong: `package.json`
    // của fork trỏ `main` vào `dist/maplibre-gl.js`, thứ bản build này không sinh
    // ra. Loại nó khỏi lượt gom là bộ quét không còn đi qua đó nữa.
    exclude: ['@gis/gtelmaps-sdk-js'],
    // Bundle của renderer là UMD, và một module UMD phải được gói lại trước khi
    // trình duyệt nạp được — không thì nó gặp `module.exports` và dừng. Khai rõ
    // đường dẫn con vì đó đúng là thứ `src/gl.ts` nhập.
    include: ['@gis/gtelmaps-gl-js/dist/gtelmaps-gl-dev.js'],
  },
});

/*
 * Không alias `@gis/gtelmaps-sdk-react` sang nguồn TS.
 *
 * Nó từng phải thế vì gói ấy chưa bao giờ build được — hai cái tên type không
 * tồn tại trong `types/style-spec.ts` chặn ngay bước biên dịch. Sửa xong thì
 * `ocular-build` chạy và `dist/` có thật, nên app này dùng gói **như một người
 * dùng ngoài dùng nó**, qua liên kết workspace ở `node_modules`. Đó là khẳng
 * định mạnh hơn: nếu gói hỏng, trang này hỏng theo.
 *
 * Đổi mã SDK thì phải `pnpm --filter react-map-gl-monorepo build` lại.
 */

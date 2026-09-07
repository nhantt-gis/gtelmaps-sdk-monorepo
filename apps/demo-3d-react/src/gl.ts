/**
 * Renderer, nạp thẳng từ file dist.
 *
 * Trỏ vào **đường dẫn con** chứ không phải tên package: `package.json` của fork
 * khai `main: "dist/maplibre-gl.js"` — tên artefact của bản thượng nguồn, thứ
 * bản build này không sinh ra — nên `import '@gis/gtelmaps-gl-js'` hỏng ngay ở
 * bước phân giải. Đường dẫn con thì bỏ qua `main` và trỏ vào file có thật.
 *
 * Và phải là bản `-dev`: `dist/gtelmaps-gl.js` là bản 26/08, có trước vài layer
 * 3D trong cảnh này.
 *
 * Bundle là UMD nên Vite phải gói lại trước (`optimizeDeps.include`); không có
 * bước ấy thì trình duyệt nhận CommonJS trần và chết ở `module is not defined`.
 */
// @ts-expect-error — không có .d.ts cho đường dẫn con; kiểu lấy từ tên package.
import bundle from '@gis/gtelmaps-gl-js/dist/gtelmaps-gl-dev.js';

export const gl = bundle as typeof import('@gis/gtelmaps-gl-js');

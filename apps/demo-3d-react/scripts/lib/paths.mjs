import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

/**
 * Bố cục của `public/`, khai một chỗ.
 *
 * Ba script trong `scripts/` ghi vào cây này và `src/style.ts` đọc ra từ nó, nên
 * mỗi đường dẫn ở đây là một chỗ hai bên phải đồng ý với nhau. Đường dẫn URL
 * tương ứng nằm trong `public/styles/<SET>/style.json` — tài liệu ấy là hợp đồng,
 * còn file này chỉ nói tài liệu ấy được **ghi ra** ở đâu.
 *
 * ```
 * public/
 *   tiles/<tên>/{z}/{x}/{y}.pbf     thư mục tile, thứ dev server phục vụ
 *   tiles/<tên>.mbtiles             cùng bộ tile, đóng gói cho tile server
 *   styles/<SET>/style.json         22 layer tĩnh
 *   sprites/<SET>/sprite.{json,png} atlas mặt tiền và mái
 *   models/ textures/ api/          tài sản và feed
 * ```
 */

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Tên bộ style và bộ sprite. Một tài liệu style và một atlas đi cùng nhau, nên
 * chúng dùng chung một cái tên — đổi ở đây là đổi cả hai, và `build-style.mjs`
 * đọc lại `sprite` từ style đang chạy nên nó tự theo.
 */
const SET = 'gtelmaps-3d-poc';

export const PUBLIC_DIR = resolve(here, '../../public');
export const TILES_DIR = resolve(PUBLIC_DIR, 'tiles');
export const STYLE_DIR = resolve(PUBLIC_DIR, 'styles', SET);
export const SPRITE_DIR = resolve(PUBLIC_DIR, 'sprites', SET);

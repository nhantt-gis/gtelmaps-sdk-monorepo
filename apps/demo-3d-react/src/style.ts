/**
 * Nạp `style.json` và gắn nó vào origin đang chạy.
 *
 * Phần tĩnh của style không còn nằm trong mã: `style.json` giữ 24 layer trên hai
 * source tile, còn `scene/` khai những gì công tắc cầm — cộng sáu layer đọc feed
 * từ API, thứ không thuộc về một tài liệu style. Xem `scripts/build-style.mjs`.
 *
 * File ấy viết URL dạng `/tiles/basemap/...`, bám gốc chứ không bám cổng: một tài liệu
 * style buộc vào `localhost:5181` chỉ dùng được ở đúng chỗ nó sinh ra. Nhưng
 * MapLibre không nhận dạng ấy ở hai chỗ, và cả hai đều đo được:
 *
 * - `load_sprite.ts:25` ném thẳng `Invalid sprite URL "/sprites/…", must be
 *   absolute` — validator chạy trước `transformRequest`, nên không vá sau được.
 * - Tile được `fetch` trong **worker**, nơi `self.location` là một blob URL:
 *   `Failed to construct 'Request': Failed to parse URL from /tiles/basemap/...`.
 *
 * Nên tài liệu giữ dạng portable, và đúng một hàm ở đây gắn nó vào `origin`.
 * Chạy trước `createRoot` (xem `main.tsx`) nên `<Map>` nhận style ngay ở lần
 * mount đầu, không có khoảnh khắc bản đồ trống — và object này dựng đúng một
 * lần ngoài React, nên tham chiếu `mapStyle` không bao giờ đổi.
 */

import type {StyleSpecification} from '@gis/gtelmaps-gl-js';

export const STYLE_URL = '/styles/gtelmaps-3d-poc/style.json';

/**
 * Chỉ đường dẫn bám gốc mới cần gắn; URL đầy đủ và `data:` để nguyên.
 *
 * Nối chuỗi chứ **không** dùng `new URL`: mẫu tile chứa `{z}/{x}/{y}`, và `URL`
 * mã hoá dấu ngoặc thành `%7Bz%7D` — MapLibre thôi nhận ra chỗ để thay số, rồi
 * hỏi server đúng chuỗi ấy và nhận 404 cho mọi tile. Đường dẫn ở đây luôn bắt
 * đầu bằng `/` nên phép nối là đủ, và nó giữ nguyên từng ký tự.
 */
const absolute = (url: string): string => (url.startsWith('/') ? location.origin + url : url);

const mapValues = (table: Record<string, string>): Record<string, string> =>
  Object.fromEntries(Object.entries(table).map(([key, url]) => [key, absolute(url)]));

/**
 * Mọi trường mang URL trong tài liệu. Liệt kê từng cái thay vì quét đệ quy: một
 * phép quét "chuỗi nào bắt đầu bằng `/`" sẽ đụng cả giá trị trong biểu thức
 * paint, mà ở đó dấu gạch chéo là ký tự dữ liệu chứ không phải đường dẫn.
 */
function bindToOrigin(style: StyleSpecification): StyleSpecification {
  const raw = style as unknown as {
    sprite?: string;
    models?: Record<string, string>;
    textures?: Record<string, string>;
    sources: Record<string, {tiles?: string[]; url?: string; data?: unknown}>;
  };

  const sources = Object.fromEntries(
    Object.entries(raw.sources).map(([id, source]) => [
      id,
      {
        ...source,
        ...(source.tiles ? {tiles: source.tiles.map(absolute)} : {}),
        ...(source.url ? {url: absolute(source.url)} : {}),
        // `data` là URL hoặc GeoJSON nội tuyến; chỉ dạng chuỗi mới là đường dẫn.
        ...(typeof source.data === 'string' ? {data: absolute(source.data)} : {}),
      },
    ]),
  );

  return {
    ...style,
    ...(raw.sprite ? {sprite: absolute(raw.sprite)} : {}),
    ...(raw.models ? {models: mapValues(raw.models)} : {}),
    ...(raw.textures ? {textures: mapValues(raw.textures)} : {}),
    sources,
  } as StyleSpecification;
}

export async function loadStyle(url: string = STYLE_URL): Promise<StyleSpecification> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: ${response.status} ${response.statusText}`);
  return bindToOrigin((await response.json()) as StyleSpecification);
}

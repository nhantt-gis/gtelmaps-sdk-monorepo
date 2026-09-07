/**
 * Phần không dính React của nhãn hover: hỏi cái gì, và lấy chữ ở đâu.
 *
 * Tách ra vì hai thứ này là **dữ liệu**, không phải giao diện — và vì cái danh
 * sách dưới đây là chỗ bản gốc đang có một lỗi lặng.
 */

import type {MapGeoJSONFeature} from '@gis/gtelmaps-gl-js';

/**
 * Các layer đối tượng mà `mousemove` hỏi tên. Thứ tự là thứ tự ưu tiên.
 *
 * `demo-3d-parity` liệt kê `'infra'` ở đây, nhưng layer ấy **không tồn tại** —
 * `layers/models.ts` đặt tên nó là `'poi'`. `queryRenderedFeatures` bỏ qua id lạ
 * mà không kêu ca, nên bên ấy 651 thiết bị hạ tầng lặng lẽ không hover được, và
 * không có gì trên màn hình nói ra điều đó. Ở đây dùng đúng tên thật.
 */
export const HOVER_QUERY_LAYERS = [
  'camera_cone',
  'glass',
  'atlas',
  'poi',
  'tree',
  'vehicle',
  'employee',
  'network',
  'network_buried',
] as const;

/**
 * Chữ để hiện cho một feature, hoặc `null` nếu nó không có gì để nói.
 *
 * `name` trước, `code` sau: thiết bị hạ tầng có mã mà thường không có tên, còn
 * toà nhà thì có cả hai và tên mới là thứ đáng đọc.
 */
export function labelTextOf(feature: MapGeoJSONFeature | undefined): string | null {
  const value = feature?.properties?.name ?? feature?.properties?.code;
  return value === undefined || value === null || value === '' ? null : String(value);
}

/**
 * Khoá nhận dạng thứ đang được hover.
 *
 * Chỉ đổi khoá mới phải vẽ lại chữ, mà vẽ lại chữ là vẽ lại cả canvas — trong khi
 * con trỏ bắn sự kiện hàng chục lần mỗi giây. Gộp cả layer vào khoá vì hai layer
 * có thể mang cùng một tên (`atlas` và `glass` vẽ cùng bộ toà nhà).
 */
export function hoverKeyOf(feature: MapGeoJSONFeature, text: string): string {
  return `${feature.layer.id}:${text}`;
}

/**
 * Nhịp tiết lưu cho việc **hỏi** "dưới con trỏ là cái gì", mili giây.
 *
 * Chỉ chặn câu hỏi, không chặn việc dời nhãn — xem `HoverLabel.tsx`. Bản gốc
 * chặn ở lượt raycast (`opts.hoverThrottleMs ?? 50`) và ở bên ấy hai thứ dính
 * làm một vì vị trí chip chính là điểm va chạm; ở đây vị trí có sẵn trong sự
 * kiện nên tách được, và phải tách.
 *
 * Đáng chép con số này lại vì `queryRenderedFeatures` không rẻ và con trỏ bắn
 * sự kiện dày hơn nhiều so với tốc độ đổi vật mà mắt theo kịp.
 * `demo-3d-parity` không tiết lưu gì — nó hỏi mỗi sự kiện.
 *
 * Giá phải trả, nói trước: rời khỏi một vật thì nhãn còn nán lại nhiều nhất
 * 50 ms trước khi tắt, vì chỉ câu hỏi mới biết là đã rời. Bản gốc cũng vậy.
 */
export const HOVER_THROTTLE_MS = 50;

/**
 * Màu nhấn của nhãn theo loại đối tượng — viền, quầng, đường dẫn và vòng neo.
 *
 * Bản gốc đổi màu chip theo loại (`LABEL_COLORS` trong `config.ts` của plugin);
 * `demo-3d-parity` thì để trắng tất. Lấy theo bản gốc, và dùng đúng bộ màu mà
 * `layers/labels.ts` đã dùng cho nhãn cố định — hai loại nhãn cùng chỉ vào một
 * vật thì không nên khác màu nhau.
 */
const ACCENT_BY_SUBCLASS: Record<string, string> = {
  camera: '#22d3ee',
  fire_hydrant: '#ef4444',
  street_light: '#f59e0b',
  power_pole: '#f59e0b',
};

const ACCENT_BY_LAYER: Record<string, string> = {
  tree: '#22c55e',
  atlas: '#7fd4ff',
  glass: '#7fd4ff',
};

/** Màu mặc định của `Label`, và cũng là màu mặc định của bản gốc. */
const ACCENT_DEFAULT = '#22d3ee';

export function accentOf(feature: MapGeoJSONFeature): string {
  const subclass = feature.properties?.subclass_code;
  if (typeof subclass === 'string' && ACCENT_BY_SUBCLASS[subclass]) {
    return ACCENT_BY_SUBCLASS[subclass];
  }
  return ACCENT_BY_LAYER[feature.layer.id] ?? ACCENT_DEFAULT;
}

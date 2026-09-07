/**
 * Kiểu dữ liệu và các hằng số của tầng truy vết một phương tiện.
 *
 * Tách khỏi component vẽ layer vì hai nửa dùng chung: `scene/Trace.tsx` khai báo
 * source và hai layer, còn `tracing/` điều khiển chúng. Cả hai phải nói cùng một
 * `TRACE_ACTOR_LAYER` và cùng một `TRACE_SOURCE_MAXZOOM`, nếu không CPU đo một
 * đường và GPU chạy đường khác.
 *
 * Đừng lẫn với tuyến nền của cả 200 xe và người: chỗ đó chạy theo đồng hồ bản đồ
 * và không ai điều khiển. File này lo **một** chiếc, do người dùng cầm.
 */

/** Một chặng: một lần camera ghi nhận được chiếc xe trên đường đi của nó. */
export type TraceLeg = {
  sequence: number;
  name: string;
  camera_code: string;
  /**
   * Quãng đường cộng dồn từ điểm xuất phát, mét — **theo thước của bộ sinh dữ
   * liệu**, không phải thước của layer. Đừng dùng nó làm mốc tua; xem `route.ts`.
   */
  distance_m: number;
  capture_time: string;
  direction: string;
  speed_kmh: number;
  ai_confidence: number;
  lng: number;
  lat: number;
};

export type Trace = {
  license_plate: string;
  route: string;
  total_distance_m: number;
  /** Toạ độ tuyến đã ghép, dùng cho bộ lấy mẫu ở `route.ts`. */
  coordinates: ReadonlyArray<[number, number]>;
  legs: ReadonlyArray<TraceLeg>;
};

export const TRACE_SOURCE = 'traces';
export const TRACE_ROUTE_LAYER = 'trace_route';
export const TRACE_ACTOR_LAYER = 'trace_actor';

/**
 * `maxzoom` của source.
 *
 * Không phải để tránh geojson-vt cắt tuyến — nó chặt hơn thế. **Chỉ một tile vẽ
 * cái xe**: tile chứa đỉnh đầu, vì `model_3d_bucket.ts` bỏ mọi bản sao có anchor
 * ngoài `[0, EXTENT)`. Tuyến thò sang tile khác là cái xe biến mất khi camera đi
 * theo nó sang bên ấy — dải sáng vẫn nguyên, chỉ mất cái xe. Đo ở z13:
 * `51C-902.13` thò 0,559 tile và truy vấn tại đích trả về 0 hit. Ở z12 cả bốn
 * tuyến nằm trọn, dư 0,13–0,22 tile.
 *
 * Xuất ra vì bộ lấy mẫu ở `route.ts` phải kéo toạ độ về đúng lưới của zoom này.
 */
export const TRACE_SOURCE_MAXZOOM = 12;

/**
 * Vận tốc phát lại, mét mỗi giây — bản gốc để `speedMps: 16` cho `trace_actor`,
 * nhanh hơn hẳn đội xe nền vì đây là xem lại hành trình chứ không phải xem giao
 * thông.
 */
export const TRACE_PLAYBACK_MPS = 16;

/** Bản gốc kẹp hệ số tốc độ trong khoảng này (`ActorModelGroup.setSpeedMultiplier`). */
export const TRACE_SPEED_RANGE = {min: 0.25, max: 8} as const;

/** Các nấc tốc độ bày ra cho người dùng, đúng bộ của bản gốc. */
export const TRACE_SPEED_CHOICES = [0.25, 0.5, 1, 2, 4, 8] as const;

/**
 * Bước lấy mẫu bảng route, mét.
 *
 * Phải khớp `model-3d-route-step` của layer `trace_actor`: `Route` dựng lại đúng
 * bảng mẫu ấy ở CPU, lệch bước là lệch cả vị trí lẫn mốc chặng.
 */
export const TRACE_ROUTE_STEP_METRES = 2;

type RouteFeature = {
  geometry?: {type?: string; coordinates?: unknown};
  properties?: Record<string, unknown>;
};

/**
 * Một cặp toạ độ hợp lệ, hay không.
 *
 * Kiểm ở đây vì đây là **biên hệ thống**: sau dòng này toạ độ đi thẳng vào
 * `Route`, mà hàm dựng của `Route` không có lưới an toàn nào cho `NaN` — một
 * `null` hay một chuỗi lọt vào sẽ làm `length`, `span` và mọi lần `sample()` trả
 * `NaN`, và biểu hiện là cái xe đứng im ở một chỗ không ai chỉ được, **không**
 * một lỗi nào được ném. Đúng kiểu hỏng mà cả bộ này cố tránh.
 */
function isLngLat(value: unknown): value is [number, number] {
  return (
    Array.isArray(value) &&
    value.length >= 2 &&
    Number.isFinite(value[0]) &&
    Number.isFinite(value[1])
  );
}

/**
 * Dựng bảng hành trình theo biển số từ hai feed đã tải.
 *
 * Hàm thuần, không đụng bản đồ: chỗ gọi quyết định khi nào tải và làm gì khi
 * hỏng. Bỏ qua feature không có biển số hoặc không phải LineString thay vì ném —
 * một dòng hỏng trong feed không được kéo theo ba hành trình còn lại.
 */
export function parseTraces(
  routes: {features?: ReadonlyArray<RouteFeature>} | null,
  legs: Record<string, ReadonlyArray<TraceLeg>> | null,
): ReadonlyMap<string, Trace> {
  const parsed = new Map<string, Trace>();
  for (const feature of routes?.features ?? []) {
    const plate = String(feature.properties?.license_plate ?? '');
    if (!plate || feature.geometry?.type !== 'LineString') continue;

    const raw = feature.geometry.coordinates;
    const coordinates = Array.isArray(raw) ? raw.filter(isLngLat) : [];
    // Bỏ cả hành trình chứ không giữ phần lành: một tuyến khuyết vài đỉnh vẫn
    // vẽ ra được, và nó sẽ nói dối — quãng đường ngắn đi, mốc chặng trượt theo,
    // mà không có gì trên màn hình cho thấy điều đó.
    if (!Array.isArray(raw) || coordinates.length !== raw.length || coordinates.length < 2) {
      console.error(
        `hành trình ${plate}: toạ độ không hợp lệ, bỏ qua ` +
          `(${coordinates.length}/${Array.isArray(raw) ? raw.length : 0} đỉnh dùng được)`,
      );
      continue;
    }

    // Chặng cũng tới từ cùng một "API", và toạ độ của nó cũng đi thẳng vào
    // `Route.distanceAt`. Một chặng NaN không làm hỏng tuyến, nhưng nó chiếm một
    // dòng trong danh sách mà bấm vào thì tua đi đâu không biết — nên bỏ chặng
    // hỏng và giữ phần còn lại.
    const rawLegs = legs?.[plate] ?? [];
    const usableLegs = rawLegs.filter(leg => Number.isFinite(leg?.lng) && Number.isFinite(leg?.lat));
    if (usableLegs.length !== rawLegs.length) {
      console.error(
        `hành trình ${plate}: bỏ ${rawLegs.length - usableLegs.length}/${rawLegs.length} chặng vì toạ độ không hợp lệ`,
      );
    }

    parsed.set(plate, {
      license_plate: plate,
      route: String(feature.properties?.route ?? ''),
      total_distance_m: Number(feature.properties?.total_distance_m) || 0,
      coordinates,
      legs: usableLegs,
    });
  }
  return parsed;
}

/** Hộp bao của tuyến, cho `fitBounds`. */
export function boundsOf(trace: Trace): [[number, number], [number, number]] {
  let west = Infinity;
  let south = Infinity;
  let east = -Infinity;
  let north = -Infinity;
  for (const [lng, lat] of trace.coordinates) {
    if (lng < west) west = lng;
    if (lat < south) south = lat;
    if (lng > east) east = lng;
    if (lat > north) north = lat;
  }
  return [
    [west, south],
    [east, north],
  ];
}

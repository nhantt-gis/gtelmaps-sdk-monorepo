/**
 * Truy vết hành trình **một** phương tiện: tuyến đã đi, và một cái xe chạy lại nó.
 *
 * **Không thuộc `style.json`**, cùng lý do với `movers.tsx`: hành trình là dữ
 * liệu đến từ API, không phải một phần mô tả cảnh. `<Source>` + `<Layer>` ở đây
 * đúng là cặp `addSource`/`addLayer` mà bản đối chiếu gọi.
 *
 * Đừng lẫn với dải sáng ở `movers.tsx`: chỗ kia vẽ tuyến nền của cả 200 xe và
 * người, chạy theo đồng hồ của bản đồ và không ai điều khiển. Ở đây là một chiếc,
 * do người dùng cầm.
 *
 * Chọn biển số là đổi **filter**, không phải đổi `data`: source chở cả bốn hành
 * trình, và đổi filter chỉ parse lại một tile — chuyện chỉ xảy ra lúc đổi lựa
 * chọn chứ không phải mỗi frame. Hai layer nhận cùng một filter trong cùng một
 * lần render, vì để lệch nhau là thấy dải sáng của xe này với cái xe của xe kia.
 */

import {useEffect, useMemo, useState} from 'react';
import {Layer, Source} from '@gis/gtelmaps-sdk-react';
import {useControls} from '../state';
import {
  TRACE_ACTOR_LAYER,
  TRACE_ROUTE_LAYER,
  TRACE_ROUTE_STEP_METRES,
  TRACE_SOURCE,
  TRACE_SOURCE_MAXZOOM,
  parseTraces,
} from '../tracing/trace';
import {TRACE_FLOW_SPEED} from './movers';
import {NO_LAYOUT, withVisibility} from './visibility';

import type {Trace as TraceRecord, TraceLeg} from '../tracing/trace';
import type {FilterSpecification, GeoJSONSourceSpecification} from '@gis/gtelmaps-gl-js';

type GeoJSONData = GeoJSONSourceSpecification['data'];

/** Chèn trước nón camera, đúng chỗ bản đối chiếu đặt hai layer này. */
const BEFORE = 'camera_cone';

/**
 * Filter không khớp gì cả.
 *
 * Layer luôn tồn tại kể cả khi chưa chọn biển số nào — dựng sẵn rồi lọc rẻ hơn và
 * ít trạng thái hơn là thêm/bớt layer, và nó giữ đúng chỗ trong thứ tự chồng.
 */
const NO_PLATE: FilterSpecification = ['==', ['get', 'license_plate'], ''];

/**
 * Cùng bộ số với dải sáng nền: 26 m/s, vạch 14 m. Dải kể *hành trình*, không kể
 * vận tốc — nên nó không đọc tốc độ phát lại.
 */
const ROUTE_PAINT_BASE = {
  'line-3d-color': '#ffffff',
  'line-3d-flow-color': '#ff3860',
  'line-3d-flow-length': 14,
  'line-3d-width': 4,
  'line-3d-opacity': 0.95,
  // Cùng van với dải sáng nền: có property này là layer vào dải depth 3D, nên dải
  // vẽ đè lên thảm mặt đất thay vì tranh chấp với nó.
  'line-3d-altitude': 0.05,
} as const;

const ACTOR_LAYOUT = {
  'model-3d-id': 'truck',
  // `scale: 1` là đúng bản gốc — kích thước nguyên của GLB. Không dùng
  // `model-3d-height` như đội xe nền: feed truy vết không mang chiều cao, và bản
  // gốc cũng không cho cái xe này một chiều cao nào.
  'model-3d-scale': 1,
  // Tốc độ 1 m/s làm cho `model-3d-route-time` tính bằng giây **bằng đúng số mét
  // đã đi**, nên mốc quãng đường ánh xạ thẳng sang property này, không có phép quy
  // đổi nào để sai. Tốc độ phát lại thật nằm ở bộ điều khiển.
  'model-3d-route-speed': 1,
  'model-3d-route-offset': 0,
  // Mịn hơn mức 3 m của đội xe nền: bảng route nối các mẫu bằng dây cung, bước
  // ngắn thì dây cung bám sát cua hơn. Phải khớp `TRACE_ROUTE_STEP_METRES` vì
  // `tracing/route.ts` dựng lại đúng bảng ấy ở CPU — và vì cả hai đọc **cùng một**
  // hằng số ở `tracing/trace.ts`, không có chỗ nào để chúng lệch nhau.
  'model-3d-route-step': TRACE_ROUTE_STEP_METRES,
} as const;

const ACTOR_PAINT = {
  'model-3d-route-align': true,
  // Đội xe nền không đổ bóng, và cái xe này cũng vậy — để hai bên trông giống
  // nhau khi chạy cạnh nhau.
  'model-3d-cast-shadows': false,
} as const;

/**
 * `maxzoom 12` không phải để tránh geojson-vt cắt tuyến — nó chặt hơn thế. **Chỉ
 * một tile vẽ cái xe**: tile chứa đỉnh đầu, vì bucket bỏ mọi bản sao có anchor
 * ngoài `[0, EXTENT)`. Tuyến thò sang tile khác là cái xe **biến mất** khi camera
 * đi theo nó sang bên ấy — hình học vẫn còn nguyên, dải sáng vẫn vẽ đủ, chỉ mất
 * cái xe. Đo được: ở z13 một tuyến thò 0,559 tile và truy vấn tại đích trả về 0
 * hit; ở z12 cả bốn nằm trọn, dư 0,13–0,22 tile.
 *
 * Nới `buffer` không cứu được, dù nghe có vẻ đúng: style-spec chặn ở 512, và vượt
 * trần thì MapLibre bỏ cả source lẫn hai layer **im lặng** qua một sự kiện
 * `error`. Giá của z12 là độ mịn: 1,17 m mỗi đơn vị toạ độ tile thay vì 0,29 m ở
 * z14. Một cái xe lệch vài mét vẫn tốt hơn một cái xe biến mất.
 */
const SOURCE_OPTIONS = {
  maxzoom: TRACE_SOURCE_MAXZOOM,
  buffer: 512,
  tolerance: 0,
  lineMetrics: true,
} as const;

type TraceProps = {
  /** Biển số đang xem, hoặc `null` để thôi xem. */
  plate: string | null;
  /** Gọi đúng một lần, sau khi cả hai feed về — bảng biển số và danh sách chặng. */
  onLoad?: (traces: ReadonlyMap<string, TraceRecord>) => void;
};

async function fetchJson(url: string): Promise<unknown> {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`${url}: ${response.status} ${response.statusText}`);
  return response.json();
}

export function Trace({plate, onLoad}: TraceProps) {
  const {controls} = useControls();
  const [routes, setRoutes] = useState<GeoJSONData | null>(null);

  // Bảng chỉ được giao ra khi **cả hai** feed đã về. Giao trước rồi hỏng giữa
  // chừng là một danh sách bốn biển số bấm vào không ra gì — bản đồ bay tới nơi và
  // không có gì ở đó.
  useEffect(() => {
    let alive = true;
    void Promise.all([
      fetchJson(`${location.origin}/api/traces.geojson`),
      fetchJson(`${location.origin}/api/trace-legs.json`),
    ])
      .then(([routeData, legData]) => {
        if (!alive) return;
        setRoutes(routeData as GeoJSONData);
        onLoad?.(
          parseTraces(
            routeData as {features?: never[]},
            legData as Record<string, ReadonlyArray<TraceLeg>>,
          ),
        );
      })
      .catch((error) => {
        // Một feed hỏng không được kéo theo cả bản đồ.
        console.error('không nạp được hành trình truy vết:', error);
      });
    return () => {
      alive = false;
    };
    // Chạy đúng một lần: `onLoad` chỉ là chỗ giao bảng, đổi hàm ấy không phải lý
    // do để tải lại hai feed.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const filter = useMemo<FilterSpecification>(
    () => (plate ? ['==', ['get', 'license_plate'], plate] : NO_PLATE),
    [plate],
  );

  // Cùng ô công tắc với dải sáng nền, dù ở hai file: cùng một hiệu ứng trên cùng
  // một loại layer thì phải cùng một cái van, không thì đóng băng trang mà vẫn còn
  // một dải chạy.
  const routePaint = useMemo(
    () => ({
      ...ROUTE_PAINT_BASE,
      'line-3d-flow-speed': controls.traceFlow ? TRACE_FLOW_SPEED : 0,
    }),
    [controls.traceFlow],
  );

  if (!routes) return null;

  const visible = plate !== null;

  return (
    <Source id={TRACE_SOURCE} type="geojson" data={routes} {...SOURCE_OPTIONS}>
      <Layer
        id={TRACE_ROUTE_LAYER}
        type="line-3d"
        beforeId={BEFORE}
        filter={filter}
        layout={withVisibility(NO_LAYOUT, visible)}
        paint={routePaint}
      />
      <Layer
        id={TRACE_ACTOR_LAYER}
        type="model-3d"
        beforeId={BEFORE}
        filter={filter}
        layout={withVisibility(ACTOR_LAYOUT, visible)}
        paint={ACTOR_PAINT}
      />
    </Source>
  );
}

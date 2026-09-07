/**
 * Xe và người nền: mô hình chạy, và dải sáng chạy dọc tuyến của chúng.
 *
 * **Không thuộc `style.json`.** Vị trí của chúng đến từ API, nên source chỉ dựng
 * được sau một lượt `fetch` — một tài liệu style là thứ tĩnh, mô tả cảnh trông
 * như thế nào, chứ không phải chỗ chở dữ liệu sống. Ở đây là `<Source>` +
 * `<Layer>`, đúng cặp `addSource`/`addLayer` mà bản đối chiếu gọi.
 *
 * Hình học của mô hình và dải sáng là **một**: một feature của mover chính là
 * tuyến nó đi, nên hai layer đọc cùng một hình, và không có một byte dữ liệu nào
 * được thêm vào cho dải sáng.
 *
 * Hai ô công tắc khác nhau: mô hình thuộc ô "Model 3D", dải sáng có ô riêng.
 */

import {useEffect, useMemo, useState} from 'react';
import {Layer, Source} from '@gis/gtelmaps-sdk-react';
import {useControls} from '../state';
import {NO_LAYOUT, withVisibility} from './visibility';

import type {ExpressionSpecification, GeoJSONSourceSpecification} from '@gis/gtelmaps-gl-js';

type GeoJSONData = GeoJSONSourceSpecification['data'];

/**
 * Layer chèn trước nón camera để giữ đúng thứ tự chồng chúng vốn có.
 *
 * Bắt buộc, và bắt buộc vì source đến muộn: `<Source>` chỉ render con của nó sau
 * khi `fetch` xong, tức sau khi style đã nạp, nên `createLayer` gọi `addLayer`
 * lúc ấy sẽ nối vào **cuối** chồng — sau cả nhãn và cảnh báo. Đây là cái giá của
 * việc dữ liệu sống không nằm trong tài liệu, và nó rẻ hơn cái giá kia.
 */
const BEFORE = 'camera_cone';

/** Tốc độ dòng chảy lúc bật; công tắc đặt về 0 để đứng yên mà vẫn giữ vạch. */
export const TRACE_FLOW_SPEED = 26;

/**
 * Feed đứng thay cho một endpoint thật; đổi sang API là đổi mỗi bảng này.
 *
 * `buffer: 512` không phải cho đẹp mà là điều kiện để mover chạy đúng. geojson-vt
 * **luôn cắt** theo tile, mà hình học của một mover chính là tuyến nó đi — nửa
 * tuyến là một cái xe chạy hết đường của chính nó rồi dừng. Đệm 512 px là một
 * tile trọn vẹn mỗi phía. Đo trên 22 tuyến: đệm mặc định 128 px giữ 20/22, đệm
 * 512 px giữ **22/22**. Trần của style-spec cũng đúng là 512, và vượt trần thì
 * MapLibre bỏ cả source lẫn layer **im lặng** qua một sự kiện `error`.
 *
 * `lineMetrics: true` là van cho **dải sáng**, không phải cho mover. Đệm 512 px
 * giữ được phần lớn tuyến nguyên vẹn nhưng không phải tất cả: đo ở z14 trên chính
 * feed này, **10 trong 100** tuyến xe vẫn tới các tile khác nhau dưới dạng những
 * mảnh khác nhau. `a_linesofar` đếm từ đầu feature, nên một mảnh bị cắt đếm lại
 * từ 0 và vạch flow nhảy pha đúng ở biên tile. Bật `lineMetrics` thì geojson-vt
 * ghi kèm `geojsonvt_clip_start`/`_end` và phần quãng đường trước mảnh được cộng
 * lại.
 *
 * `tolerance: 0` tắt giản lược, và nó cần cho **zoom nhỏ hơn `maxzoom`** chứ
 * không phải ở chính maxzoom. Đo trên 22 tuyến này: ở z14 dung sai không đổi gì
 * (396/396 đỉnh), nhưng ở z12 dung sai mặc định 0,375 px cắt còn **96/396** và ở
 * z10 còn 74. Vị trí của mover là hàm của **độ dài cung** dọc tuyến, nên bỏ bớt
 * đỉnh là đổi tham số hoá của cả tuyến — cái xe nhảy sang chỗ khác đúng lúc người
 * dùng zoom ra.
 */
const SOURCE_OPTIONS = {
  maxzoom: 14,
  buffer: 512,
  tolerance: 0,
  lineMetrics: true,
} as const;

/**
 * Năm thuộc tính đặt một mô hình vào chỗ của nó, đọc theo từng feature.
 *
 * Chỉ dùng ở đây. Cây và hạ tầng POI đọc cùng bộ ấy nhưng chúng nằm trong
 * `style.json` — cùng một ý, hai chỗ khai, vì hai loại dữ liệu khác nhau.
 */
const PLACEMENT = {
  'model-3d-scale': ['coalesce', ['get', 'scale'], 1] as ExpressionSpecification,
  'model-3d-altitude': ['coalesce', ['get', 'altitude'], 0] as ExpressionSpecification,
  'model-3d-bearing': ['coalesce', ['get', 'bearing'], 0] as ExpressionSpecification,
  'model-3d-pitch': ['coalesce', ['get', 'pitch'], 0] as ExpressionSpecification,
  'model-3d-roll': ['coalesce', ['get', 'roll'], 0] as ExpressionSpecification,
} as const;

const VEHICLE_LAYOUT = {
  'model-3d-id': 'truck',
  ...PLACEMENT,
  // Feed là JSON nên chiều cao là số thật, không phải xentimét nguyên như trong
  // tile: `JSON.parse` mang được một double nguyên vẹn.
  'model-3d-height': ['coalesce', ['get', 'height'], 0] as ExpressionSpecification,
  // Feature CHÍNH LÀ tuyến: một đường, lấy mẫu lại lúc parse tile, vị trí tính
  // trên GPU từ đồng hồ. Không có một phép tính CPU nào mỗi frame, chỗ mà bản gốc
  // phải viết lại ma trận của mọi instance trong nhóm mỗi khi một diễn viên nhúc
  // nhích.
  'model-3d-route-speed': ['coalesce', ['get', 'route_speed'], 0] as ExpressionSpecification,
  'model-3d-route-offset': ['coalesce', ['get', 'route_offset'], 0] as ExpressionSpecification,
  'model-3d-route-step': 3,
} as const;

const EMPLOYEE_LAYOUT = {
  'model-3d-id': 'patrol',
  ...PLACEMENT,
  'model-3d-height': ['coalesce', ['get', 'height'], 0] as ExpressionSpecification,
  // Asset được author quay ngược: ở bearing 0 model này nhìn về nam trong khi
  // `truck.glb` nhìn về bắc. Chỗ sửa là style, không phải layer — bản gốc cũng
  // làm đúng thế với `headingOffset: Math.PI`, và chỉ cho riêng model này.
  'model-3d-bearing': ['+', 180, ['coalesce', ['get', 'bearing'], 0]] as ExpressionSpecification,
  'model-3d-route-speed': ['coalesce', ['get', 'route_speed'], 0] as ExpressionSpecification,
  'model-3d-route-offset': ['coalesce', ['get', 'route_offset'], 0] as ExpressionSpecification,
  'model-3d-route-step': 2,
} as const;

const VEHICLE_PAINT = {'model-3d-cast-shadows': false} as const;

const EMPLOYEE_PAINT = {
  // `Di_Bo` là chu kỳ đi bộ. Tại chỗ, vì layer mới là thứ quyết định người đứng ở
  // đâu; không có nó thì clip sải bước rời khỏi mỏ neo của mình và không quay lại.
  'model-3d-animation': 'Di_Bo',
  'model-3d-animation-in-place': true,
  'model-3d-animation-frame-rate': 24,
  'model-3d-cast-shadows': false,
} as const;

/**
 * Tốc độ và bề dài vạch lấy đúng mặc định của bản gốc: 26 m/s, vạch 14 m, nên chu
 * kỳ một cặp màu là 28 m. Bản gốc dùng đúng bộ số ấy cho cả tuyến xe lẫn tuyến
 * người, kể cả khi người chỉ đi 1,4 m/s — dải sáng kể *hành trình*, không kể vận
 * tốc, và đó là lý do nó không đọc `route_speed`.
 *
 * `line-3d-altitude` nâng dải lên 5 cm, và con số ấy không phải để tránh
 * z-fighting: có mặt property này là layer vào dải depth 3D, mà dải ấy nằm trọn
 * phía trước các lát depth của chồng 2D — nên dải sáng vẽ đè lên thảm mặt đất và
 * vạch kẻ đường thay vì tranh chấp với chúng.
 */
const FLOW_BASE = {
  'line-3d-flow-length': 14,
  // Bản gốc để `opacity: 0.95` cho vật liệu flow; `line-3d-opacity` mặc định 1.
  'line-3d-opacity': 0.95,
  'line-3d-altitude': 0.05,
  'line-3d-width': 2,
} as const;

const VEHICLE_TRACE_COLORS = {'line-3d-color': '#ffffff', 'line-3d-flow-color': '#ff3860'} as const;
const EMPLOYEE_TRACE_COLORS = {'line-3d-color': '#22d3ee', 'line-3d-flow-color': '#a3e635'} as const;

type Feeds = {vehicles: GeoJSONData | null; employees: GeoJSONData | null};

const NO_FEEDS: Feeds = {vehicles: null, employees: null};

async function fetchFeed(url: string): Promise<GeoJSONData | null> {
  try {
    const response = await fetch(url);
    if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
    return (await response.json()) as GeoJSONData;
  } catch (error) {
    // Một feed hỏng không được kéo theo cả bản đồ: nền vẫn vẽ, chỉ thiếu đúng đội
    // xe hoặc đội người ấy.
    console.error(`không nạp được ${url}:`, error);
    return null;
  }
}

export function Movers() {
  const {controls} = useControls();
  const [feeds, setFeeds] = useState<Feeds>(NO_FEEDS);

  // Hai feed chờ nhau rồi mới vào cảnh một lượt: chèn theo thứ tự tới là thứ tự
  // chồng đổi theo tốc độ mạng — cùng một trang, hai lần tải, hai chồng layer
  // khác nhau. Một thứ tự phụ thuộc mạng là một thứ tự không gỡ lỗi được.
  useEffect(() => {
    let alive = true;
    void Promise.all([
      fetchFeed(`${location.origin}/api/vehicles.geojson`),
      fetchFeed(`${location.origin}/api/employees.geojson`),
    ]).then(([vehicles, employees]) => {
      if (alive) setFeeds({vehicles, employees});
    });
    return () => {
      alive = false;
    };
  }, []);

  // Đặt tốc độ về 0 **không** tắt flow: vạch vẫn còn nguyên, chỉ đứng yên. Tắt
  // hẳn hiệu ứng là `line-3d-flow-length: 0`, và chỉ khi ấy biến thể shader mới
  // không được biên dịch.
  const flowSpeed = controls.traceFlow ? TRACE_FLOW_SPEED : 0;
  const vehicleTracePaint = useMemo(
    () => ({...FLOW_BASE, ...VEHICLE_TRACE_COLORS, 'line-3d-flow-speed': flowSpeed}),
    [flowSpeed],
  );
  const employeeTracePaint = useMemo(
    () => ({...FLOW_BASE, ...EMPLOYEE_TRACE_COLORS, 'line-3d-flow-speed': flowSpeed}),
    [flowSpeed],
  );

  const modelLayout = (layout: object) => withVisibility(layout, controls.models);
  const traceLayout = withVisibility(NO_LAYOUT, controls.traces);

  return (
    <>
      {feeds.vehicles && (
        <Source id="vehicles" type="geojson" data={feeds.vehicles} {...SOURCE_OPTIONS}>
          {/* Dải sáng trước, mô hình sau: cả hai chèn trước `camera_cone`, nên
              cái vào trước nằm dưới. Depth test cũng đủ để sắp chúng, nhưng thứ
              tự đúng thì không phải dựa vào đó. */}
          <Layer
            id="vehicle_trace"
            type="line-3d"
            beforeId={BEFORE}
            layout={traceLayout}
            paint={vehicleTracePaint}
          />
          <Layer
            id="vehicle"
            type="model-3d"
            beforeId={BEFORE}
            layout={modelLayout(VEHICLE_LAYOUT)}
            paint={VEHICLE_PAINT}
          />
        </Source>
      )}
      {feeds.employees && (
        <Source id="employees" type="geojson" data={feeds.employees} {...SOURCE_OPTIONS}>
          <Layer
            id="employee_trace"
            type="line-3d"
            beforeId={BEFORE}
            layout={traceLayout}
            paint={employeeTracePaint}
          />
          <Layer
            id="employee"
            type="model-3d"
            beforeId={BEFORE}
            layout={modelLayout(EMPLOYEE_LAYOUT)}
            paint={EMPLOYEE_PAINT}
          />
        </Source>
      )}
    </>
  );
}

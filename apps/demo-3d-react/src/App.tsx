/**
 * Bản đồ, cả cảnh, và bảng điều khiển ba tab.
 *
 * Thứ tự lồng nhau ở đây không tuỳ tiện: `<ControlsProvider>` phải bọc ngoài
 * `<Map>` vì cả `scene/` lẫn `ui/` đọc bảng công tắc, còn `<Dashboard>` phải nằm
 * **trong** `<Map>` vì tab truy vết gọi `useMap()`. Bản thân bảng ấy render ra
 * ngoài `<body>` qua cổng, nên vị trí trong cây React không quyết định vị trí
 * trong DOM.
 *
 * Hai mảnh trạng thái ở đây, và cả hai đều đổi hiếm: biển số đang xem, và bảng
 * hành trình lấy về một lần. Quãng đường của cái xe **không** ở đây — nó đổi 60
 * lần mỗi giây và nằm ngoài React hoàn toàn; xem `tracing/hooks.ts`.
 */

import {useCallback, useState} from 'react';
import {Map} from '@gis/gtelmaps-sdk-react';

import {gl} from './gl';
import {Scene} from './scene';
import {ControlsProvider} from './state';
import {Dashboard} from './ui/dashboard/Dashboard';
import {HoverLabel} from './ui/HoverLabel';
import {HudTitle} from './ui/HudTitle';
import {MapControls} from './ui/MapControls';
import {Readout} from './ui/Readout';

import type {StyleSpecification} from '@gis/gtelmaps-gl-js';
import type {ErrorEvent, MapEvent, MapLib} from '@gis/gtelmaps-sdk-react';
import type {Trace} from './tracing/trace';

/**
 * Khung nhìn nghiệm thu, đúng bằng bản đối chiếu. Đủ gần để một mặt tiền còn đọc
 * ra là mặt tiền: kể cả đã phóng thì đây vẫn là những toà nhà 14–43 m, và ở zoom
 * mức huyện các đường tầng thu lại thành nhiễu.
 */
const INITIAL_VIEW = {
  longitude: 107.169352,
  latitude: 10.59153,
  zoom: 18.15,
  pitch: 64,
  bearing: -36.5,
} as const;

// `Map` trong phạm vi này là **component bản đồ**, không phải kiểu dựng sẵn —
// react-map-gl đặt trùng tên, nên phải gọi rõ `globalThis.Map`.
const NO_TRACES: ReadonlyMap<string, Trace> = new globalThis.Map();

type AppProps = {
  /**
   * `style.json` đã nạp và đã gắn origin — xem `style.ts`. Nhận qua prop chứ
   * không tự nạp trong một effect: `<Map>` phải có style ngay ở lần render đầu.
   */
  mapStyle: StyleSpecification;
};

export function App({mapStyle}: AppProps) {
  const [plate, setPlate] = useState<string | null>(null);
  const [traces, setTraces] = useState<ReadonlyMap<string, Trace>>(NO_TRACES);

  // `addSource` và `addLayer` KHÔNG ném khi spec không qua được validator —
  // chúng bắn một sự kiện `error`. Không nghe thì một layer sai một con số sẽ
  // biến mất hoàn toàn im lặng, và đó đúng là cách `buffer` quá trần của layer
  // truy vết đã nuốt cả source lẫn hai layer trong một lượt trước.
  const onError = useCallback((event: ErrorEvent) => {
    console.error('map:', event.error?.message ?? event);
  }, []);

  // Với tay tới được từ console và từ bộ chụp ảnh không đầu: khung này tồn tại để
  // được chất vấn, và một phép so không chọc vào được là một phép so kém.
  const onLoad = useCallback((event: MapEvent) => {
    (window as unknown as {map: unknown}).map = event.target;
  }, []);

  const onTracesLoad = useCallback((loaded: ReadonlyMap<string, Trace>) => {
    setTraces(loaded);
  }, []);

  return (
    <ControlsProvider>
      <Map
        // Cast vì `MapLib` được khai theo lớp của SDK, còn đây là bundle thô của
        // fork — cùng hình dạng, khác nơi khai. Và cố tình KHÔNG truyền `space`,
        // `halo` hay `gtelmapsApiKey`: chúng gọi những method chỉ SDK mới có.
        mapLib={gl as unknown as MapLib}
        mapStyle={mapStyle}
        initialViewState={INITIAL_VIEW}
        maxPitch={85}
        canvasContextAttributes={{antialias: true}}
        hash='m'
        onError={onError}
        onLoad={onLoad}
      >
        <Scene tracePlate={plate} onTracesLoad={onTracesLoad} />
        <HoverLabel />
        <MapControls pitch3D={INITIAL_VIEW.pitch} />
        <Dashboard traces={traces} plate={plate} onPlate={setPlate} />
        <Readout />
      </Map>
      <HudTitle />
    </ControlsProvider>
  );
}

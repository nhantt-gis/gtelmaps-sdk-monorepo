/**
 * Bảng công tắc dùng chung cho toàn app.
 *
 * Đây là **hợp đồng** giữa hai nửa: `scene/` đọc để quyết định layer nào hiện và
 * bơm giá trị nào vào paint, còn `ui/` ghi. Giữ nó ở một chỗ vì hai nửa được
 * viết song song, và vì mỗi trường ở đây là **một ô** trong bảng điều khiển —
 * thêm một công tắc là thêm một dòng ở đây trước, rồi mới tới hai nửa kia.
 *
 * Chỉ chứa thứ đổi theo thao tác người dùng. Trạng thái truy vết (đang chạy,
 * quãng đường, chặng) KHÔNG nằm ở đây: nó đổi 60 lần mỗi giây và phải ở ngoài
 * vòng render của React — xem `tracing/`.
 */

import {createContext, useCallback, useContext, useMemo, useState} from 'react';
import type {ReactNode} from 'react';

export type BuildingMode = 'glass' | 'atlas';

export type Controls = {
  /** Bộ vỏ nhà đang vẽ. Hai layer, luôn đúng một cái hiện. */
  mode: BuildingMode;

  // Thảm nền và mặt nước
  surfaces: boolean;
  water: boolean;
  /** Tắt là sóng đứng yên, không phải mất mặt nước. */
  waves: boolean;
  shadows: boolean;

  // Đường, nhãn, cảnh báo, tường
  roads: boolean;
  labels: boolean;
  alerts: boolean;
  alertPulse: boolean;
  zoneWall: boolean;
  wallPulse: boolean;

  // Mạng kỹ thuật
  networks: boolean;
  /** Ống ngầm xuyên đất. Tắt là chìm dưới đất, đúng bản gốc. */
  buried: boolean;

  // Đội xe và người nền
  models: boolean;
  cones: boolean;
  /**
   * Dải sáng vẽ tuyến của **cả** đội xe và đội người — 200 tuyến chồng lên nhau.
   * Mặc định tắt: ở mật độ này nó phủ kín mặt đường và che mất chính những cái
   * xe nó mô tả. Bật lên khi cần nhìn dòng chảy, không phải để nhìn thường trực.
   */
  traces: boolean;
  traceFlow: boolean;

  // Ba tập thửa, mặc định tắt
  cadastralParcel: boolean;
  plannedLanduse: boolean;
  plannedParcel: boolean;

  // Nhà
  xray: boolean;
  hiddenEdges: boolean;
  edge: number;
  opacity: number;
  night: number;
  /**
   * Bề rộng ô cửa, mét — hoặc `null` là "theo `bay_width` của từng toà nhà".
   *
   * `null` là trạng thái đầu, và nó **là** trạng thái đầu của bản vanilla: style
   * bên ấy khai `['coalesce', ['get','bay_width'], 6]`. Chạm vào thanh trượt là
   * ghi đè cho **mọi** toà, cũng đúng như bên ấy — cả 123 toà trong bộ dữ liệu
   * đều mang `bay_width` riêng, nên một thanh trượt chỉ đổi giá trị dự phòng là
   * một thanh trượt không làm gì cả.
   *
   * Không có đường về `null`, và bản vanilla cũng không có.
   */
  bay: number | null;

  // Khác
  wind: number;
};

export const DEFAULT_CONTROLS: Controls = {
  mode: 'atlas',
  surfaces: true,
  water: true,
  waves: true,
  shadows: true,
  roads: true,
  labels: true,
  alerts: true,
  alertPulse: true,
  zoneWall: true,
  wallPulse: true,
  networks: true,
  buried: false,
  models: true,
  cones: true,
  traces: false,
  traceFlow: true,
  cadastralParcel: false,
  plannedLanduse: false,
  plannedParcel: false,
  xray: true,
  hiddenEdges: true,
  edge: 0.5,
  opacity: 0.05,
  // 1, không phải 0. Bản đối chiếu maplibre trần **vẽ** ở 1 trong khi thanh trượt
  // của nó ghi 0 — hai con số không khớp nhau, và cái được vẽ mới là cái đúng để
  // bám theo. Đặt 1 ở đây cho ra đúng cùng khung hình, và thêm một điều bản kia
  // không có: thanh trượt nói thật.
  night: 1,
  bay: null,
  wind: 0.5
};

type ControlsApi = {
  controls: Controls;
  set: <K extends keyof Controls>(key: K, value: Controls[K]) => void;
};

const ControlsContext = createContext<ControlsApi | null>(null);

export function ControlsProvider({children}: {children: ReactNode}) {
  const [controls, setControls] = useState<Controls>(DEFAULT_CONTROLS);

  // Bản mới, không sửa tại chỗ: `scene/` so sánh từng trường để quyết định có
  // dựng lại object paint hay không, nên sửa tại chỗ là mất luôn phép so ấy.
  const set = useCallback(<K extends keyof Controls>(key: K, value: Controls[K]) => {
    setControls(prev => (prev[key] === value ? prev : {...prev, [key]: value}));
  }, []);

  const api = useMemo(() => ({controls, set}), [controls, set]);
  return <ControlsContext.Provider value={api}>{children}</ControlsContext.Provider>;
}

export function useControls(): ControlsApi {
  const api = useContext(ControlsContext);
  if (!api) throw new Error('useControls phải nằm trong <ControlsProvider>');
  return api;
}

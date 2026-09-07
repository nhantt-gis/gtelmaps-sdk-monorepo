/**
 * Cảnh báo trên thiết bị có trạng thái bất thường.
 *
 * **Không thuộc `style.json`**, và lý do khác với `movers.tsx`: dữ liệu ở đây
 * đọc từ tile như mọi layer tĩnh khác, nhưng *ngưỡng* cảnh báo thì không tĩnh.
 * Bảng ba mức dưới đây là thứ sẽ đổi — thêm một mức, dời một ngưỡng, đổi màu một
 * trạng thái — và đổi thường xuyên hơn hẳn màu mặt nước hay chu kỳ hoa văn nền.
 * Thứ đổi thường xuyên thì để nơi có kiểu và có `git blame` từng dòng, không để
 * trong một tài liệu dữ liệu.
 *
 * Trong 651 thiết bị có 16 cái cảnh báo — 7 `critical`, 7 `warning`, 2
 * `offline`; 635 cái còn lại `active` và bị `filter` loại.
 */

import {useMemo} from 'react';
import {Layer} from '@gis/gtelmaps-sdk-react';
import {useControls} from '../state';
import {NO_LAYOUT, withVisibility} from './visibility';

import type {ExpressionSpecification, FilterSpecification} from '@gis/gtelmaps-gl-js';

/** 635 thiết bị `active` không phải cảnh báo, và chúng bị loại ở đây. */
const ALERT_FILTER: FilterSpecification = ['!=', ['get', 'status'], 'active'];

/**
 * Bảng ba mức, là `SEV_FX` của bản gốc (`config.ts:198`) chuyển sang biểu thức.
 *
 * Đó là chỗ port này khá hơn bản gốc: đổi ngưỡng không phải sửa vòng vẽ, chỉ đổi
 * một biểu thức. `offline` có `beam-height` bằng 0 — nó nhấp nháy dưới đất chứ
 * không dựng cột, đúng như bản gốc.
 */
const SEVERITY_COLOR: ExpressionSpecification = [
  'match',
  ['get', 'status'],
  ['critical', 'error'],
  '#ef4444',
  ['warning', 'maintenance'],
  '#f59e0b',
  ['offline', 'inactive'],
  '#6b7280',
  '#22c55e',
];

const PING_RADIUS: ExpressionSpecification = [
  'match',
  ['get', 'status'],
  ['critical', 'error'],
  22,
  15,
];

const BEAM_HEIGHT: ExpressionSpecification = [
  'match',
  ['get', 'status'],
  ['critical', 'error'],
  75,
  ['warning', 'maintenance'],
  45,
  0,
];

/**
 * Nhịp đập, **theo mức độ** chứ không phải một con số chung: cái nguy kịch đập
 * nhanh gần gấp ba cái ngoại tuyến, và đó là nửa thông tin mà màu không nói.
 */
const ALERT_SPEED: ExpressionSpecification = [
  'match',
  ['get', 'status'],
  ['critical', 'error'],
  0.95,
  ['warning', 'maintenance'],
  0.5,
  0.35,
];

const ALERT_PAINT_BASE = {
  'alert-3d-color': SEVERITY_COLOR,
  'alert-3d-ping-radius': PING_RADIUS,
  'alert-3d-beam-height': BEAM_HEIGHT,
  // 0, đúng bản gốc: `alertItems` bên kia gọi `at.slice(0, -1)` và vứt cao độ
  // đi. Muốn cảnh báo mọc từ chính cái camera trên cột thì cộng `altitude` với
  // `height` như `label_poi` — lựa chọn của style, không phải của layer.
  'alert-3d-altitude': 0,
} as const;

export function Alerts() {
  const {controls} = useControls();
  const {alerts, alertPulse} = controls;

  // Đóng băng nhịp đập, cùng lý do với "Sóng chạy": layer đang động thì hai frame
  // liên tiếp khác nhau, nên một ảnh chụp không lặp lại được. Đặt tốc độ về 0 là
  // lối thoát, và render fixture của layer này giữ tính tất định bằng đúng cách ấy.
  const paint = useMemo(
    () => ({...ALERT_PAINT_BASE, 'alert-3d-speed': alertPulse ? ALERT_SPEED : 0}),
    [alertPulse],
  );

  return (
    // Không `beforeId`: layer này đứng cuối chồng, mà `addLayer` không kèm
    // `beforeId` là nối vào cuối — nên chỗ đúng cũng là chỗ mặc định.
    <Layer
      id="alerts"
      type="alert-3d"
      source="overlay"
      source-layer="poi"
      filter={ALERT_FILTER}
      layout={withVisibility(NO_LAYOUT, alerts)}
      paint={paint}
    />
  );
}

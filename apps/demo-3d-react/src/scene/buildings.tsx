/**
 * Hai vỏ nhà, luôn đúng một cái vẽ mặt tiền: `atlas` hoặc `glass`.
 *
 * Đây là nhóm có nhiều van nhất, và cũng là nhóm duy nhất người dùng chạm được
 * vào một **layout** property — xem `bay` bên dưới.
 */

import {useMemo} from 'react';
import {Layer} from '@gis/gtelmaps-sdk-react';
import {useControls} from '../state';
import {NO_LAYOUT, withVisibility} from './visibility';

import type {ExpressionSpecification} from '@gis/gtelmaps-gl-js';

/**
 * Bề rộng ô cửa dự phòng, mét — dùng cho toà nhà không mang `bay_width` riêng.
 * Đúng con số của bản vanilla, cũng là vị trí thanh trượt lúc chưa ai chạm, và
 * là giá trị dự phòng trong `coalesce` mà `style.json` khai sẵn.
 */
export const DEFAULT_BAY_WIDTH = 6;

export function Buildings() {
  const {controls} = useControls();
  const {mode, night, bay, xray, hiddenEdges, edge, opacity} = controls;

  const atlasPaint = useMemo(() => ({'building-atlas-night': night}), [night]);

  // Layout chứ không phải paint: cả ô cửa sổ được nướng vào hình học của tile,
  // nên chạm vào con số này là parse lại mọi tile đang hiện. Đó là cái giá thật
  // thà của việc nướng ô cửa vào lưới, và đây là chỗ duy nhất người dùng cảm
  // thấy nó.
  //
  // `null` giữ nguyên biểu thức `coalesce` của `style.json` — trạng thái đầu,
  // giống hệt bản vanilla. Một con số thì **thay hẳn**, không phải chỉ đổi giá
  // trị dự phòng: cả 123 toà nhà trong bộ dữ liệu đều mang `bay_width` riêng,
  // nên nếu chỉ đổi dự phòng thì kéo thanh trượt không đổi được một ô cửa nào.
  const atlasLayout = useMemo(
    () => ({
      'building-atlas-bay-width':
        bay === null
          ? (['coalesce', ['get', 'bay_width'], DEFAULT_BAY_WIDTH] as ExpressionSpecification)
          : bay,
    }),
    [bay],
  );

  const glassPaint = useMemo(
    () => ({
      'building-glass-xray': xray,
      'building-glass-xray-hidden-edges': hiddenEdges,
      'building-glass-edge-opacity': edge,
      'building-glass-opacity': opacity,
    }),
    [xray, hiddenEdges, edge, opacity],
  );

  return (
    <>
      <Layer
        id="atlas"
        type="building-atlas"
        layout={withVisibility(atlasLayout, mode === 'atlas')}
        paint={atlasPaint}
      />
      <Layer
        id="glass"
        type="building-glass"
        layout={withVisibility(NO_LAYOUT, mode === 'glass')}
        paint={glassPaint}
      />
    </>
  );
}

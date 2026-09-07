/**
 * Mặt nước, với hai van người dùng cầm: sóng và kiểu phản chiếu.
 *
 * Đóng băng sóng không phải một nút thẩm mỹ. Một layer đang động gọi
 * `triggerRepaint()` mỗi frame, nên hai frame liên tiếp không bao giờ trùng nhau
 * và một ảnh chụp không lặp lại được. Đặt tốc độ về 0 là lối thoát duy nhất, và
 * cũng là cách mọi render fixture của layer này giữ tính tất định.
 *
 * Màu, kiểu phản chiếu, chu kỳ sóng và danh sách layer được soi gương nằm trong
 * `style.json` — không ô điều khiển nào cầm chúng, nên chúng thuộc về tài liệu.
 * Danh sách ấy **bắt buộc** phải liệt kê: mặc định rỗng nghĩa là "mọi layer 3D",
 * mà `zone_mask` là một thảm phẳng ở đúng 0 m — cùng mặt phẳng với nước — nên
 * ảnh gương của nó là một tấm đục phủ kín nửa dưới buffer.
 */

import {useMemo} from 'react';
import {Layer} from '@gis/gtelmaps-sdk-react';
import {useControls} from '../state';
import {NO_LAYOUT, withVisibility} from './visibility';

/** Tốc độ sóng lúc bật; công tắc đặt nó về 0 để đóng băng mà vẫn giữ mặt nước. */
const WAVE_SPEED = 0.03;

export function Water() {
  const {controls} = useControls();
  const {water, waves} = controls;

  const paint = useMemo(() => ({'water-3d-wave-speed': waves ? WAVE_SPEED : 0}), [waves]);

  return (
    <Layer
      id="water"
      type="water-3d"
      layout={withVisibility(NO_LAYOUT, water)}
      paint={paint}
    />
  );
}

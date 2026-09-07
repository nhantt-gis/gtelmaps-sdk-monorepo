/**
 * Thảm nền: ranh khu, bốn vật liệu mặt đất, và cỏ. Tất cả nằm phẳng ở 0 m.
 *
 * Một ô công tắc cầm cả ba, nên một object layout dùng chung.
 *
 * Giá trị của ba layer nằm trong `style.json`. Hai điều ở đó dễ đọc nhầm là vô
 * cớ nên ghi lại đây:
 *
 * - `zone_mask` khai `fill-3d-altitude: 0`, và con số ấy **không** nâng tấm lên
 *   một milimét nào — nó chuyển layer sang dải depth 3D, và chỉ ở đó một tấm mới
 *   che được thứ nằm dưới. Không có nó thì ống nước ở −10 m đọc xuyên qua mặt
 *   đất dù `tube-3d-xray` tắt. Chỉ tấm này, không phải cả ba: `ground` và `grass`
 *   đồng phẳng với nó, và ba mặt tranh nhau từng ULP depth thì vỉa hè lẫn cỏ vỡ
 *   vụn ở góc nghiêng.
 * - `grass` là layer riêng chỉ vì chu kỳ texture của nó là 28 m chứ không phải
 *   42 m, và chu kỳ phải là hằng số của layer thì lưới UV mới còn là một hàm
 *   affine duy nhất. Hai chu kỳ, hai layer — không phải năm layer cho năm ảnh.
 */

import {Layer} from '@gis/gtelmaps-sdk-react';
import {useControls} from '../state';
import {NO_LAYOUT, withVisibility} from './visibility';

export function Surfaces() {
  const {controls} = useControls();
  const layout = withVisibility(NO_LAYOUT, controls.surfaces);

  return (
    <>
      <Layer id="zone_mask" type="fill-3d" layout={layout} />
      <Layer id="ground" type="fill-3d" layout={layout} />
      <Layer id="grass" type="fill-3d" layout={layout} />
    </>
  );
}

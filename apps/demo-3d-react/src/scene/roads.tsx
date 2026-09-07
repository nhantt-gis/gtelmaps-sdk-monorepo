/** Vạch kẻ đường. Một layer, một ô công tắc, không có gì khác đổi lúc chạy. */

import {Layer} from '@gis/gtelmaps-sdk-react';
import {useControls} from '../state';
import {NO_LAYOUT, withVisibility} from './visibility';

export function Roads() {
  const {controls} = useControls();

  return (
    <Layer id="road_line" type="line-3d" layout={withVisibility(NO_LAYOUT, controls.roads)} />
  );
}

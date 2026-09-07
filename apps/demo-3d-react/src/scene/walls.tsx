/**
 * Rèm ranh khu.
 *
 * Cùng van với "Nhịp cảnh báo" và "Sóng chạy": `wall-3d-speed` là hằng số của
 * layer, nên đặt về 0 dừng cả nhịp dâng trên rèm lẫn nhịp thở của vệt loang, và
 * hai lần chụp mới trùng nhau từng pixel.
 */

import {useMemo} from 'react';
import {Layer} from '@gis/gtelmaps-sdk-react';
import {useControls} from '../state';
import {NO_LAYOUT, withVisibility} from './visibility';

export function Walls() {
  const {controls} = useControls();
  const {zoneWall, wallPulse} = controls;

  const paint = useMemo(() => ({'wall-3d-speed': wallPulse ? 1 : 0}), [wallPulse]);

  return (
    <Layer
      id="zone_wall"
      type="wall-3d"
      layout={withVisibility(NO_LAYOUT, zoneWall)}
      paint={paint}
    />
  );
}

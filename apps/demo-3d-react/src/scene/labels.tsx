/** Nhãn POI. Một layer, một ô công tắc. */

import {Layer} from '@gis/gtelmaps-sdk-react';
import {useControls} from '../state';
import {NO_LAYOUT, withVisibility} from './visibility';

export function Labels() {
  const {controls} = useControls();

  return (
    <Layer id="label_poi" type="label-3d" layout={withVisibility(NO_LAYOUT, controls.labels)} />
  );
}

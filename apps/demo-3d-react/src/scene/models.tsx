/**
 * Mô hình đặt theo điểm: cây, hạ tầng POI, và nón tầm nhìn của camera.
 *
 * `camera_cone_edges` vẽ sau phần tô, đúng thứ tự `subOrder` 0 rồi 1 của bản
 * gốc — thứ tự ấy nằm trong `style.json`, nơi thứ tự mảng `layers` quyết định.
 */

import {useMemo} from 'react';
import {Layer} from '@gis/gtelmaps-sdk-react';
import {useControls} from '../state';
import {NO_LAYOUT, withVisibility} from './visibility';

export function Models() {
  const {controls} = useControls();
  const {models, cones, wind} = controls;

  const treePaint = useMemo(() => ({'model-3d-sway-amplitude': wind}), [wind]);
  const modelLayout = withVisibility(NO_LAYOUT, models);
  const coneLayout = withVisibility(NO_LAYOUT, cones);

  return (
    <>
      <Layer id="tree" type="model-3d" layout={modelLayout} paint={treePaint} />
      <Layer id="poi" type="model-3d" layout={modelLayout} />
      <Layer id="camera_cone" type="model-3d" layout={coneLayout} />
      <Layer id="camera_cone_edges" type="model-3d" layout={coneLayout} />
    </>
  );
}

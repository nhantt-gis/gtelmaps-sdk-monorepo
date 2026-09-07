/**
 * Mạng kỹ thuật: ống nổi và ống ngầm, hai layer trên cùng một source-layer, tách
 * nhau bằng filter trong `style.json`.
 *
 * Ống nước ngầm ở −10 m, và mặc định **không xuyên đất** — đúng bản gốc, nơi
 * nhóm này khai `underground: false`: nó bị mặt đất che, và chỉ lộ ra khi người
 * dùng khoét hố. Ô "Ống ngầm xuyên đất" bật `tube-3d-xray`, thứ tương đương cờ
 * ấy; khi bật, layer thôi test và thôi ghi depth nên `is3D()` trả false và nó
 * không cướp pass opaque của ai. Đây là công tắc **chế độ vẽ**, không phải công
 * tắc hiển thị — nên layer luôn hiện, và nó không có `withVisibility`.
 */

import {useMemo} from 'react';
import {Layer} from '@gis/gtelmaps-sdk-react';
import {useControls} from '../state';
import {NO_LAYOUT, withVisibility} from './visibility';

export function Networks() {
  const {controls} = useControls();
  const {networks, buried} = controls;

  const buriedPaint = useMemo(() => ({'tube-3d-xray': buried}), [buried]);

  return (
    <>
      <Layer id="network" type="tube-3d" layout={withVisibility(NO_LAYOUT, networks)} />
      <Layer id="network_buried" type="tube-3d" paint={buriedPaint} />
    </>
  );
}

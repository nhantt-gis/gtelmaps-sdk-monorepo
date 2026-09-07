/**
 * Ba lớp thông tin quy hoạch, mỗi lớp một tấm và một viền, mặc định tắt cả ba.
 *
 * Mỗi tập là một source-layer riêng của `overlay`, nên không có filter nào: tên
 * layer chính là thứ trước đây thuộc tính `kind` phải nói. Tấm rồi tới viền, và
 * lô đất nằm trên quy hoạch — lớp mịn hơn thắng khi hai cái chồng nhau.
 *
 * Bề rộng viền trong `style.json` là một biểu thức `interpolate` chứ không phải
 * một con số mét: viền của bản gốc là `LineBasicMaterial`, tức một nét 1 px
 * không đổi theo zoom, mà `line-3d-width` đo bằng **mét**. Cơ số 0,5 làm nó giảm
 * một nửa mỗi mức, đúng nhịp mét-trên-pixel, và nét ra ~1,3 px ở mọi zoom. Một
 * con số mét cố định thì ở z14,5 nó mỏng dưới một pixel và biến mất.
 */

import {Fragment} from 'react';
import {Layer} from '@gis/gtelmaps-sdk-react';
import {useControls} from '../state';
import {NO_LAYOUT, withVisibility} from './visibility';

import type {Controls} from '../state';

/** Id layer trong `style.json`, và ô công tắc cầm cả tấm lẫn viền của tập ấy. */
const PARCEL_SETS = [
  {layer: 'cadastral_parcel', control: 'cadastralParcel'},
  {layer: 'planned_landuse', control: 'plannedLanduse'},
  {layer: 'planned_parcel', control: 'plannedParcel'},
] as const satisfies ReadonlyArray<{layer: string; control: keyof Controls}>;

export function Parcels() {
  const {controls} = useControls();

  return (
    <>
      {PARCEL_SETS.map((set) => {
        // Một ô cầm cả tấm lẫn viền, nên hai layer dùng chung một object layout.
        const layout = withVisibility(NO_LAYOUT, Boolean(controls[set.control]));
        return (
          <Fragment key={set.layer}>
            <Layer id={set.layer} type="fill-3d" layout={layout} />
            <Layer id={`${set.layer}_outline`} type="line-3d" layout={layout} />
          </Fragment>
        );
      })}
    </>
  );
}

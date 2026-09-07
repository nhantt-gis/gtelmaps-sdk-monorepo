/**
 * Cả cảnh: mỗi nhóm một component, và mỗi component chỉ khai phần công tắc cầm.
 *
 * Thứ tự các dòng dưới đây **không** quyết định thứ tự chồng, dù nó đọc như thế.
 * 24 layer trên hai source tile đã có mặt trong `style.json` trước khi `<Layer>`
 * đầu tiên mount, nên `map.getLayer(id)` luôn trả về layer và `<Layer>` đi thẳng
 * vào nhánh cập nhật — không có `addLayer` nào để nối vào cuối. Đảo hai dòng ở
 * đây không đổi một pixel; đảo hai phần tử trong mảng `layers` mới đổi.
 *
 * Trình tự vẫn giữ đúng thứ tự của tài liệu, cố ý: đọc file này phải ra được
 * cảnh được xếp thế nào, không phải một danh sách theo bảng chữ cái.
 *
 * `<Movers>` và `<Trace>` là ngoại lệ, và là ngoại lệ thật: source của chúng đến
 * từ API nên không thuộc về một tài liệu style. Hai nhóm ấy tự dựng source và
 * layer, và vì dựng sau khi style nạp xong nên phải tự khai `beforeId`.
 */

import {Alerts} from './alerts';
import {Buildings} from './buildings';
import {Labels} from './labels';
import {Models} from './models';
import {Movers} from './movers';
import {Networks} from './networks';
import {Parcels} from './parcels';
import {Roads} from './roads';
import {Surfaces} from './surfaces';
import {Trace} from './trace';
import {useShadows} from './shadows';
import {Walls} from './walls';
import {Water} from './water';

import type {Trace as TraceRecord} from '../tracing/trace';

type SceneProps = {
  /** Biển số đang truy vết, `null` là không xem. */
  tracePlate?: string | null;
  /** Bảng hành trình, giao đúng một lần cho phần giao diện dựng danh sách. */
  onTracesLoad?: (traces: ReadonlyMap<string, TraceRecord>) => void;
};

export function Scene({tracePlate = null, onTracesLoad}: SceneProps) {
  useShadows();

  return (
    <>
      <Surfaces />
      <Water />
      <Parcels />
      <Roads />
      <Buildings />
      <Models />
      <Networks />
      <Walls />
      <Labels />
      <Alerts />
      <Movers />
      <Trace plate={tracePlate} onLoad={onTracesLoad} />
    </>
  );
}

/**
 * Nhãn bám con trỏ: hỏi layer nào đang ở dưới chuột rồi mở một `Label` tại đó.
 *
 * Ranh giới hiệu năng nằm ở đây, và nó là cả lý do file này không chỉ là một
 * `useState` nối vào `mousemove`:
 *
 * - **Chỉ khi đổi vật** mới đi qua React. Con trỏ trượt dọc một toà nhà bắn hàng
 *   chục sự kiện mà vật thì vẫn thế; render lại cây React ở nhịp đó là trả giá
 *   cho một thứ không đổi. `hoverKeyOf` là cái khoá quyết định điều ấy.
 * - **Đổi vị trí thì không.** Nhãn phải bám con trỏ ngay cả khi vẫn là vật cũ,
 *   nên vị trí được ghi thẳng vào instance qua `ref` — đúng đường thoát mà
 *   `<Popup>` của react-map-gl bày sẵn cho các cập nhật ở nhịp con trỏ.
 *
 * Ba chỗ theo bản gốc mà `demo-3d-parity` không có: tiết lưu 50 ms, con trỏ đổi
 * thành `pointer` khi trúng vật, và màu nhấn theo loại đối tượng.
 */

import {useEffect, useRef, useState} from 'react';
import {Label3D, useMap} from '@gis/gtelmaps-sdk-react';

import {HOVER_QUERY_LAYERS, HOVER_THROTTLE_MS, accentOf, hoverKeyOf, labelTextOf} from './hover';

import type {LabelInstance} from '@gis/gtelmaps-sdk-react';
import type {MapMouseEvent} from '@gis/gtelmaps-gl-js';

/**
 * Hình dáng nhãn, lấy của `demo-3d-parity`.
 *
 * Màu nền là mặc định của chính `Label`, và mặc định ấy vốn được đặt bằng màu
 * của layer `label-3d` — tức cùng bộ số với bản gốc. Màu nhấn thì đổi theo loại
 * vật nên nó không nằm trong đây.
 */
const LABEL_LOOK = {
  plateColor: 'rgba(12, 18, 28, 0.82)',
  fontSize: 14,
  leaderLength: 44,
  anchorSize: 18,
  maxTextWidth: 200,
} as const;

type Hovered = {
  text: string;
  accent: string;
  lng: number;
  lat: number;
};

export function HoverLabel() {
  const mapRef = useMap().current;
  const [hovered, setHovered] = useState<Hovered | null>(null);
  const labelRef = useRef<LabelInstance | null>(null);
  const keyRef = useRef('');
  const lastAskRef = useRef(0);

  useEffect(() => {
    const map = mapRef?.getMap();
    if (!map) return undefined;

    const canvas = map.getCanvas();
    const clear = () => {
      if (!keyRef.current) return;
      keyRef.current = '';
      canvas.style.cursor = '';
      setHovered(null);
    };

    const onMove = (event: MapMouseEvent) => {
      // Dời nhãn ở MỌI sự kiện, trước và độc lập với việc hỏi.
      //
      // Tiết lưu từng bọc cả hàm, và đó là sai: bản gốc chặn ở lượt raycast vì
      // bên ấy vị trí chip **là** kết quả raycast — không hỏi thì không có chỗ
      // mới. Ở đây vị trí lấy thẳng từ `event.lngLat`, chẳng cần hỏi ai, nên
      // buộc hai thứ vào một nhịp chỉ tổ hạ nhãn xuống 20 Hz. Đo được: 19,5
      // lần/giây so với 59,8 của `demo-3d-parity`, đúng một phần ba.
      labelRef.current?.setLngLat(event.lngLat);

      // Còn việc hỏi "dưới con trỏ là cái gì" thì vẫn theo nhịp — đó mới là chỗ
      // tốn tiền, và cũng là chỗ bản gốc chặn.
      const now = performance.now();
      if (now - lastAskRef.current < HOVER_THROTTLE_MS) return;
      lastAskRef.current = now;

      // Lọc theo layer đang có thật: đội xe và người tới sau `load`, còn người
      // dùng thì tắt được gần hết số còn lại. `queryRenderedFeatures` bỏ qua id
      // lạ mà không kêu, nên tự lọc mới biết lúc nào chẳng còn gì để hỏi.
      const live = HOVER_QUERY_LAYERS.filter(id => map.getLayer(id));
      if (live.length === 0) return;

      const hit = map.queryRenderedFeatures(event.point, {layers: live})[0];
      const text = labelTextOf(hit);
      if (!hit || !text) {
        clear();
        return;
      }

      canvas.style.cursor = 'pointer';

      const key = hoverKeyOf(hit, text);
      if (key !== keyRef.current) {
        keyRef.current = key;
        // Kèm luôn vị trí: lần render này mang cả chữ mới lẫn chỗ mới, nên không
        // cần ghi thêm bằng tay — và không có một frame nào nhãn mới đứng ở chỗ cũ.
        setHovered({text, accent: accentOf(hit), lng: event.lngLat.lng, lat: event.lngLat.lat});
      }
    };

    map.on('mousemove', onMove);
    // Con trỏ rời hẳn canvas thì không có `mousemove` nào báo điều đó.
    map.on('mouseout', clear);
    return () => {
      map.off('mousemove', onMove);
      map.off('mouseout', clear);
      canvas.style.cursor = '';
    };
  }, [mapRef]);

  if (!hovered) return null;

  return (
    <Label3D
      ref={labelRef}
      longitude={hovered.lng}
      latitude={hovered.lat}
      text={hovered.text}
      accentColor={hovered.accent}
      {...LABEL_LOOK}
    />
  );
}

/**
 * Số đọc viewport: zoom, toạ độ, hướng, độ nghiêng — và lỗi bản đồ, nếu có.
 *
 * Ghi thẳng vào DOM trong `map.on('render')`, không qua state. Sự kiện ấy bắn
 * mỗi frame, và một `setState` ở nhịp đó là render lại cả bảng điều khiển 60
 * lần mỗi giây để đổi một dòng chữ.
 *
 * Ô này cũng là chỗ **lỗi bản đồ hiện ra to nhất**: `addSource`/`addLayer` không
 * ném khi spec sai, chúng bắn sự kiện `error`, và một layer biến mất không dấu
 * vết là kiểu hỏng khó lần nhất của bộ này.
 */

import {useEffect, useRef} from 'react';
import {useMap} from '@gis/gtelmaps-sdk-react';

export function Readout() {
  const mapRef = useMap().current;
  const nodeRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const map = mapRef?.getMap();
    const node = nodeRef.current;
    if (!map || !node) return undefined;

    const view = () => {
      const {lng, lat} = map.getCenter();
      return (
        `zoom ${map.getZoom().toFixed(2)} · ${lat.toFixed(5)}, ${lng.toFixed(5)} · ` +
        `hướng ${map.getBearing().toFixed(1)}° · nghiêng ${map.getPitch().toFixed(0)}°`
      );
    };

    const onRender = () => {
      node.textContent = view();
    };
    const onError = (event: {error?: Error}) => {
      node.textContent = '';
      const line = document.createElement('span');
      line.className = 'err';
      // `textContent`, không `innerHTML`: chuỗi lỗi mang theo cả url và spec của
      // layer, tức dữ liệu ngoài.
      line.textContent = `LỖI: ${event.error?.message ?? String(event)}`;
      node.append(line);
    };

    map.on('render', onRender);
    map.on('error', onError);
    onRender();
    return () => {
      map.off('render', onRender);
      map.off('error', onError);
    };
  }, [mapRef]);

  return <div id='readout' ref={nodeRef} />;
}

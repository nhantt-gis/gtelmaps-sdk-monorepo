/**
 * Công tắc bóng đổ.
 *
 * Không phải một layer nên không có JSX cho nó: hướng nắng là thuộc tính của cả
 * style, và `setShadow` là chỗ duy nhất đổi được nó sau khi style đã nạp.
 *
 * `intensity: 0` chứ không phải gỡ khối `shadow`: nó bỏ hẳn lượt vẽ mà vẫn giữ
 * nguyên hướng mặt trời, nên bật lại không phải khai lại. Và hướng ấy được
 * **đọc lại từ style** chứ không giữ một bản sao ở đây — `style.json` là chỗ duy
 * nhất khai `azimuth`/`elevation`, nên không có bản thứ hai để trôi. Bản đối
 * chiếu có đúng hai bản như thế, 40 độ trong style và 42 trong chỗ nghe công
 * tắc, nên bật tắt một lần là cảnh nghiêng đi hai độ.
 *
 * `setShadow` **ném** nếu style chưa nạp xong (`Style._checkLoaded`), và từ khi
 * style là một URL thì hiệu ứng này chạy trước lúc ấy — object style nạp đồng
 * bộ, tài liệu tải qua mạng thì không. Nên chờ `style.load` khi chưa sẵn sàng.
 */

import {useEffect} from 'react';
import {useMap} from '@gis/gtelmaps-sdk-react';
import {useControls} from '../state';

export function useShadows() {
  const mapRef = useMap().current;
  const {controls} = useControls();
  const {shadows} = controls;

  useEffect(() => {
    const map = mapRef?.getMap();
    if (!map) return;

    const apply = () => map.setShadow({...map.getShadow(), intensity: shadows ? 1 : 0});

    // @ts-ignore `style` là nội bộ, và đây đúng là cờ `<Layer>` cũng đọc.
    if (map.style?._loaded) {
      apply();
      return;
    }
    map.once('style.load', apply);
    return () => {
      map.off('style.load', apply);
    };
  }, [mapRef, shadows]);
}

/**
 * Cổng đưa một mảnh giao diện ra thẳng dưới `<body>`.
 *
 * React mount vào `#map`, mà `#map` là `position: absolute; inset: 0` phủ kín
 * màn hình. Tiêu đề HUD và lớp phủ tải phải là **anh em ruột** của nó chứ không
 * phải con: bộ script chụp ảnh ẩn mọi `body > *` trừ `#map` để chụp riêng bản
 * đồ, và một lớp phủ nằm trong `#map` sẽ đi vào mọi tấm ảnh đối chiếu.
 */

import {useEffect, useState} from 'react';
import {createPortal} from 'react-dom';

import type {ReactNode} from 'react';

export function BodyPortal({children}: {children: ReactNode}) {
  // Chỉ mở cổng sau khi đã mount: `document.body` không tồn tại lúc render đầu
  // trên máy chủ, và trang này còn có thể được dựng lại bằng SSR về sau.
  const [ready, setReady] = useState(false);
  useEffect(() => setReady(true), []);
  return ready ? createPortal(children, document.body) : null;
}

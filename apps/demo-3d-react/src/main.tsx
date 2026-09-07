/**
 * Điểm vào. Gắn React vào chính `#map` của `index.html`.
 *
 * Không bọc `<StrictMode>`: nó dựng rồi huỷ rồi dựng lại mọi effect một lượt, mà
 * ở đây effect nào cũng nặng — một context WebGL và hai lượt `fetch` GeoJSON —
 * còn `onLoad` của bảng hành trình thì phải nổ đúng một lần.
 *
 * Style được nạp **trước** khi React dựng, cố ý. `<Map>` cần `mapStyle` ngay ở
 * lần mount đầu; đưa nó vào sau qua state là một lần `setStyle` thứ hai, mà lần
 * ấy quét sạch những layer `<Layer>` vừa thêm. Đổi lại là một lượt `fetch` một
 * tài liệu vài chục KB cùng origin — đứng trước một context WebGL và hàng trăm
 * tile, nó không phải chỗ đáng tiếc.
 */

/*
 * Hai stylesheet, và **thứ tự giữa chúng là bắt buộc**: CSS của renderer trước,
 * CSS của trang sau, vì trang ghi đè lên nó (`.maplibregl-ctrl-group` trong
 * `styles.css` đặt nền trong suốt, nút 38px, viền kính — toàn những thứ chỉ
 * thắng khi đứng sau).
 *
 * Đây từng là hai thẻ `<link>` trong `index.html`, đúng thứ tự này. Khi bundle
 * chuyển sang `import`, CSS renderer đi theo nó vào `gl.ts` và bị tiêm **sau**
 * thẻ `<link>` của `styles.css` — mặc định của MapLibre thắng ngược, và bảng
 * điều khiển mất hết lớp áo: nền trắng thay vì trong suốt, nút 29px thay vì 38px.
 *
 * Nên cả hai về đây, cạnh nhau, đúng thứ tự, ở một chỗ đọc là thấy. Import của
 * ES module được đánh giá theo thứ tự viết, nên hai dòng này chạy trước cả cây
 * `App` bên dưới.
 */
import '@gis/gtelmaps-gl-js/dist/gtelmaps-gl.css';
import './styles.css';

import {createRoot} from 'react-dom/client';

import {App} from './App';
import {STYLE_URL, loadStyle} from './style';

const container = document.getElementById('map');
if (!container) throw new Error('không tìm thấy #map trong index.html');

// `.then` chứ không phải `await` ở tầng module: top-level await buộc cả bundle
// sang định dạng ESM mới hơn, và `esbuild` từ chối dựng ở target mặc định. Một
// lời hứa ở đây rẻ hơn là nâng target cho cả app vì đúng một dòng.
void loadStyle()
  .then((mapStyle) => {
    createRoot(container).render(<App mapStyle={mapStyle} />);
  })
  .catch((error) => {
    // Không có style thì không có bản đồ, và một trang đen im lặng là thứ tệ
    // nhất để gỡ. Nói ra cả ở console lẫn trên trang.
    console.error('không nạp được style:', error);
    container.textContent = `Không nạp được ${STYLE_URL}: ${String(error)}`;
  });

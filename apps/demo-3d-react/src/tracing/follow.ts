/**
 * Camera bám theo cái xe đang truy vết — bản port của `cameraFollow.ts` bên
 * `3d-plugins` (`apps/demo-3d-js/src/integration/cameraFollow.ts`).
 *
 * Giữ nguyên mọi hằng số của bản gốc: vào cảnh 900 ms theo đường cong bậc ba,
 * làm mượt hướng bằng nội suy góc hệ số 0,14, đẩy tâm nhìn 25 m **về phía trước**
 * cái xe để nó nằm thấp trong khung, huỷ bám khi người dùng kéo bản đồ quá 4 px,
 * còn cuộn chuột chỉ tạm dừng 320 ms rồi chạy lại.
 *
 * Hai chỗ khác bản gốc, và cả hai đều nói ra được:
 *
 * - Bản gốc chạy vòng bằng `setInterval(33ms)` để sống khi tab ẩn; ở đây dùng
 *   `requestAnimationFrame`. Hai khác biệt thật: vòng dừng hẳn khi tab ẩn, và khi
 *   tab hiện thì nó chạy ~60 Hz thay vì 30 Hz — tức gấp đôi số lần `setCenter`
 *   và gấp đôi số sự kiện `move` mỗi giây. Đổi lại camera đi cùng nhịp với cái
 *   xe, thứ cũng do rAF đẩy.
 * - Bản gốc suy hướng từ chênh lệch vị trí giữa hai nhịp; ở đây hướng lấy thẳng
 *   từ tiếp tuyến tuyến đường — **cùng một nguồn** với thứ shader dùng để xoay
 *   model, nên camera và cái xe không bao giờ lệch pha nhau.
 *
 * Vẫn đi qua `map.stop()` cộng các setter hạt mịn chứ không `easeTo`/`jumpTo`:
 * dưới một vòng vẽ lại liên tục thì hai cái kia không đáng tin, đúng như bản gốc
 * đã ghi.
 */

import { METRES_PER_DEGREE } from './route';

import type { Map as MapLike } from '@gis/gtelmaps-gl-js';
import type { RouteSample } from './route';


const APPROACH_MS = 900;
const DRAG_PX = 4;
const WHEEL_IDLE_MS = 320;
const BEARING_SMOOTHING = 0.14;
const FOLLOW_ZOOM = 18;
const FOLLOW_PITCH = 60;
const AHEAD_METRES = 25;

export class CameraFollow {
  private active = false;
  private settled = false;
  private frame = 0;
  private smoothBearing = 0;
  private startMs = 0;
  private startZoom = 0;
  private startPitch = 0;

  private readonly pointers = new Set<number>();
  private readonly downPoint = { x: 0, y: 0 };
  private moved = false;
  private keepGesture = false;
  private wheelResume: ReturnType<typeof setTimeout> | 0 = 0;

  constructor(
    private readonly map: MapLike,
    private readonly getTarget: () => RouteSample | null,
    private readonly onStop: () => void,
  ) {}

  get following() {
    return this.active;
  }

  start() {
    if (this.active) return;
    const target = this.getTarget();
    if (!target) return;

    this.active = true;
    this.settled = false;
    // Bắt đầu từ hướng bản đồ đang nhìn, không từ hướng cái xe — nếu không thì
    // nhịp đầu tiên `setBearing` thẳng vào đích và bản đồ **xoay giật** trong một
    // frame, trong khi zoom và pitch vẫn ease 900 ms. Bản gốc khởi tạo bằng
    // `map.getBearing()` trên thực tế, vì `bearingDeg` của nó là null cho tới khi
    // mover nhúc nhích (`TracePlaybackController.target`); ở đây tiếp tuyến có
    // sẵn ngay nên phải nói rõ điều ấy ra.
    this.smoothBearing = this.map.getBearing();
    this.map.stop();
    this.startMs = performance.now();
    this.startZoom = this.map.getZoom();
    this.startPitch = this.map.getPitch();

    this.map.on('dragstart', this.cancel);
    const host = this.map.getCanvasContainer();
    host.addEventListener('pointerdown', this.onPointerDown);
    host.addEventListener('wheel', this.onWheel, { passive: true });
    window.addEventListener('pointermove', this.onPointerMove);
    window.addEventListener('pointerup', this.onPointerUp);
    window.addEventListener('pointercancel', this.onPointerUp);
    this.resumeLoop();
  }

  stop() {
    if (!this.active) return;
    this.active = false;
    this.pauseLoop();
    if (this.wheelResume) clearTimeout(this.wheelResume);
    this.wheelResume = 0;
    this.pointers.clear();

    this.map.off('dragstart', this.cancel);
    const host = this.map.getCanvasContainer();
    host.removeEventListener('pointerdown', this.onPointerDown);
    host.removeEventListener('wheel', this.onWheel);
    window.removeEventListener('pointermove', this.onPointerMove);
    window.removeEventListener('pointerup', this.onPointerUp);
    window.removeEventListener('pointercancel', this.onPointerUp);
    this.onStop();
  }

  private cancel = () => this.stop();

  private pauseLoop() {
    if (this.frame) cancelAnimationFrame(this.frame);
    this.frame = 0;
  }

  private resumeLoop() {
    if (this.active && !this.frame && this.pointers.size === 0) {
      this.frame = requestAnimationFrame(this.tick);
    }
  }

  private onPointerDown = (e: PointerEvent) => {
    this.pointers.add(e.pointerId);
    if (this.pointers.size === 1) {
      this.downPoint.x = e.clientX;
      this.downPoint.y = e.clientY;
      this.moved = false;
      // Chuột phải và hai ngón là xoay-nghiêng, không phải kéo — chúng không huỷ bám.
      this.keepGesture = e.button === 2 || e.ctrlKey || e.metaKey;
    } else {
      this.keepGesture = true;
    }
    this.pauseLoop();
  };

  private onPointerMove = (e: PointerEvent) => {
    if (this.pointers.size === 0 || this.moved) return;
    if (Math.hypot(e.clientX - this.downPoint.x, e.clientY - this.downPoint.y) > DRAG_PX) {
      this.moved = true;
    }
  };

  private onPointerUp = (e: PointerEvent) => {
    this.pointers.delete(e.pointerId);
    if (this.pointers.size > 0 || !this.active) return;
    if (this.moved && !this.keepGesture) this.stop();
    else this.resumeLoop();
  };

  private onWheel = () => {
    this.pauseLoop();
    if (this.wheelResume) clearTimeout(this.wheelResume);
    this.wheelResume = setTimeout(() => {
      this.wheelResume = 0;
      this.resumeLoop();
    }, WHEEL_IDLE_MS);
  };

  private tick = () => {
    this.frame = 0;
    if (!this.active) return;
    const target = this.getTarget();
    // Một nhịp không có target chỉ là một nhịp bỏ qua — bản gốc chạy `setInterval`
    // nên điều đó hiển nhiên; ở đây phải tự lên lịch lại, không thì vòng lặp chết
    // hẳn mà `active` vẫn true và ô tick vẫn nói đang bám.
    if (!target) { this.resumeLoop(); return; }

    this.smoothBearing = lerpAngle(this.smoothBearing, target.bearing, BEARING_SMOOTHING);
    this.map.setBearing(this.smoothBearing);
    this.map.setCenter(this.centreFor(target));

    if (!this.settled) {
      const k = Math.min(1, (performance.now() - this.startMs) / APPROACH_MS);
      const eased = 1 - Math.pow(1 - k, 3);
      this.map.setZoom(lerp(this.startZoom, FOLLOW_ZOOM, eased));
      this.map.setPitch(lerp(this.startPitch, FOLLOW_PITCH, eased));
      if (k >= 1) this.settled = true;
    }
    this.resumeLoop();
  };

  /** Tâm nhìn: vị trí cái xe, đẩy `AHEAD_METRES` về phía nó đang đi. */
  private centreFor(target: RouteSample): [number, number] {
    const [lng, lat] = target.lngLat;
    const radians = (this.smoothBearing * Math.PI) / 180;
    const metresPerLon = METRES_PER_DEGREE * Math.cos((lat * Math.PI) / 180);
    const centre: [number, number] = [
      lng + (Math.sin(radians) * AHEAD_METRES) / metresPerLon,
      lat + (Math.cos(radians) * AHEAD_METRES) / METRES_PER_DEGREE,
    ];
    // Lưới an toàn của bản gốc: một tâm nhìn NaN đưa bản đồ đi đâu không ai biết,
    // và rơi về chính vị trí cái xe thì tệ nhất cũng chỉ là mất phần đẩy trước.
    return Number.isFinite(centre[0]) && Number.isFinite(centre[1]) ? centre : [lng, lat];
  }
}

function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Nội suy góc theo đường ngắn nhất, để không quay ngược cả vòng ở mốc 359°→0°. */
function lerpAngle(a: number, b: number, t: number): number {
  const delta = ((b - a + 540) % 360) - 180;
  return a + delta * t;
}

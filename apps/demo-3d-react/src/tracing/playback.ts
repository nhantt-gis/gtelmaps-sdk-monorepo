/**
 * Đồng hồ phát lại: chạy, dừng, tua, đổi tốc.
 *
 * Toàn bộ việc của nó là ghi **một con số** mỗi frame —
 * `model-3d-route-time` của layer `trace_actor` — rồi để GPU đặt cái xe. Đó là
 * cả điểm khác so với bản gốc: `ActorModelGroup.onUpdate` của plugin ghi lại
 * toàn bộ ma trận instance của nhóm mỗi khi bất kỳ actor nào nhúc nhích.
 *
 * Lớp này **không biết React**, và đó là chủ ý. Một con số đổi 60 lần mỗi giây
 * mà đi qua `useState` là 60 lần render cây React mỗi giây; đi qua
 * `<Layer paint>` thì còn thêm một lượt `deepEqual` trên từng property của layer.
 * Hook `useTracePlayback` chỉ giữ instance này trong một ref và chuyển tiếp
 * trạng thái cho phần chữ đọc được.
 *
 * Ba con số dưới đây là của bản gốc, không phải chọn lại: kẹp `dt` ở 0,1 s
 * (`ActorModelGroup.onUpdate`), hệ số tốc độ trong [0,25 … 8]
 * (`setSpeedMultiplier`), và `gotoDistance` **tự dừng** phát lại.
 *
 * Dừng là dừng hẳn vòng `requestAnimationFrame`. Layer thôi tự gọi
 * `triggerRepaint` khi van đồng hồ được đặt, nên khi cả hai cùng im thì bản đồ
 * về `idle` được — thứ mà không layer động nào khác của bộ này làm được.
 */

import {TRACE_PLAYBACK_MPS, TRACE_SPEED_RANGE} from './trace';

import type {Trace} from './trace';
import type {Route} from './route';

/** Trần bước thời gian, giây. Tab quay lại sau một phút không được nhảy một phút đường. */
const MAX_STEP_SECONDS = 0.1;

export type PlaybackState = {
  /** Quãng đường đã đi, mét — cũng chính là giá trị đang nằm trong layer. */
  distance: number;
  playing: boolean;
  speed: number;
  /** Chỉ số chặng đang đi qua, hoặc -1 khi còn trước chặng đầu. */
  legIndex: number;
};

export const IDLE_PLAYBACK: PlaybackState = {distance: 0, playing: false, speed: 1, legIndex: -1};

export class TracePlayback {
  private trace: Trace | null = null;
  private route: Route | null = null;
  /**
   * Mốc tua của từng chặng, mét, **theo thước của layer**.
   *
   * Không phải `leg.distance_m`: con số ấy đo bằng thước phẳng của bộ sinh dữ
   * liệu và lệch tới 15 m ở cuối tuyến. Xem `route.ts`.
   */
  private legDistances: ReadonlyArray<number> = [];
  private distance = 0;
  private playing = false;
  private speed = 1;
  private frame = 0;
  private lastMs = 0;

  /**
   * `writeRouteTime` là chỗ duy nhất lớp này chạm vào bản đồ, nên nó được truyền
   * vào chứ không tự đi tìm. Chỗ gọi đưa `useMapPaintProperty` của SDK — hook ấy
   * đã chắn sẵn cả `isStyleLoaded()` lẫn `getLayer()`, hai điều kiện mà layer
   * truy vết (dựng từ một source geojson tải sau `load`) đều có lúc chưa thoả.
   */
  constructor(
    private readonly writeRouteTime: (seconds: number) => void,
    private readonly onChange: (state: PlaybackState) => void,
  ) {}

  /** Hành trình đang xem, hoặc `null` để thôi xem. Chọn xong là chạy ngay, như bản gốc. */
  select(trace: Trace | null, route: Route | null, legDistances: ReadonlyArray<number> = []) {
    this.trace = trace;
    this.route = route;
    this.legDistances = legDistances;
    this.distance = 0;
    this.speed = 1;
    this.publish();
    if (trace) this.play();
    else this.pause();
  }

  play() {
    if (!this.trace || this.playing) return;
    this.playing = true;
    this.lastMs = performance.now();
    this.frame = requestAnimationFrame(this.tick);
    this.publish();
  }

  pause() {
    if (this.frame) cancelAnimationFrame(this.frame);
    this.frame = 0;
    if (!this.playing) return;
    this.playing = false;
    this.publish();
  }

  /** Tua tới một mốc quãng đường. Tự dừng — đúng hành vi `gotoDistance` của bản gốc. */
  gotoDistance(distance: number) {
    if (!this.route) return;
    this.pause();
    // Kẹp ở `usableLength`, KHÔNG ở `length`: quãng giữa hai mốc ấy nằm trên dây
    // cung nhảy về xuất phát, không nằm trên đường. Xem `route.ts`.
    this.distance = clamp(distance, 0, this.route.usableLength);
    this.publish();
  }

  /** Tua tới chặng thứ `index`. */
  gotoLeg(index: number) {
    const distance = this.legDistances[index];
    if (distance !== undefined) this.gotoDistance(distance);
  }

  setSpeed(multiplier: number) {
    this.speed = clamp(multiplier, TRACE_SPEED_RANGE.min, TRACE_SPEED_RANGE.max);
    this.publish();
  }

  /** Về đầu tuyến và chạy lại — `reset` của bản gốc. */
  reset() {
    this.distance = 0;
    this.publish();
    this.play();
  }

  getState(): PlaybackState {
    return {
      distance: this.distance,
      playing: this.playing,
      speed: this.speed,
      legIndex: this.legIndexAt(this.distance),
    };
  }

  /** Vị trí và hướng hiện tại của cái xe, để camera bám theo. */
  currentSample() {
    return this.route?.sample(this.distance) ?? null;
  }

  /** Gỡ hẳn: dùng khi component tháo, để vòng rAF không sống lâu hơn bản đồ. */
  destroy() {
    if (this.frame) cancelAnimationFrame(this.frame);
    this.frame = 0;
    this.playing = false;
    this.trace = null;
    this.route = null;
  }

  private tick = (now: number) => {
    // Xoá trước khi làm bất cứ gì: nhịp này đã bắn, id của nó không huỷ được nữa.
    // Không xoá thì một `pause()` tái nhập từ `onChange` sẽ huỷ nhầm id cũ, `tick`
    // vẫn lên lịch nhịp mới, và lần `play()` sau cho **hai** vòng rAF cùng chạy —
    // cái xe đi nhanh gấp đôi. `follow.ts` đã làm đúng lối này.
    this.frame = 0;
    if (!this.playing || !this.route) return;
    const dt = Math.min(Math.max((now - this.lastMs) / 1000, 0), MAX_STEP_SECONDS);
    this.lastMs = now;

    this.distance += dt * TRACE_PLAYBACK_MPS * this.speed;
    // Vòng lại ở `span` chứ không ở độ dài tuyến: đó là chỗ shader vòng lại, và
    // hai bên lệch nhau là camera rời khỏi cái xe đúng lúc nó về đích. Quãng
    // `(usableLength, span)` là cú nhảy về xuất phát — chạy qua nó là đúng, chỉ
    // **tua** vào giữa nó mới sai.
    if (this.distance >= this.route.span) this.distance %= this.route.span;

    this.publish();
    this.frame = requestAnimationFrame(this.tick);
  };

  /**
   * Ghi mốc vào layer rồi báo cho chỗ gọi. Đây là toàn bộ phần "vẽ" của lớp này.
   *
   * Quãng đường tính bằng mét ghi thẳng vào một property tính bằng **giây** là
   * đúng, không phải nhầm đơn vị: layer `trace_actor` đặt
   * `model-3d-route-speed: 1`, nên `travelled = offset + route_time × speed` cho
   * ra đúng số mét. Đó là lý do bộ số ấy được chọn — `gotoDistance` của bản gốc
   * ánh xạ 1:1, không có phép quy đổi nào để sai.
   */
  private publish() {
    this.writeRouteTime(this.distance);
    this.onChange(this.getState());
  }

  private legIndexAt(distance: number): number {
    let index = -1;
    for (let i = 0; i < this.legDistances.length; i++) {
      if (this.legDistances[i] <= distance) index = i;
    }
    return index;
  }
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

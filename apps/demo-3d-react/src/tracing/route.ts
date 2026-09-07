/**
 * Tuyến đã ghép, tra được theo quãng đường — bản song song ở CPU của thứ shader
 * đang làm trên GPU.
 *
 * Bộ điều khiển cần biết cái xe **đang ở đâu** để camera bám theo nó, mà vị trí
 * ấy do shader tính. Nên chỗ này không được xấp xỉ: nó dựng lại đúng luật mà
 * `Model3DBucket.addRoute` và `model_3d.vertex.glsl` dùng, và nguồn sự thật là
 * `packages/gtelmaps-gl-js/src/style/style_layer/model_3d_route_pick.ts` — chính
 * file mà picking dùng để bấm trúng một cái xe đang chạy. Ba luật phải khớp, và
 * mỗi luật đã có một lần đo cho thấy bỏ nó thì lệch bao nhiêu:
 *
 * 1. **Hình học là hình học đã làm tròn.** geojson-vt làm tròn mọi toạ độ về số
 *    nguyên trong hệ đơn vị tile (`Math.round(extent · (x·2^z − tx))`). Ở
 *    `maxzoom 12` một đơn vị là 1,17 m; đọc toạ độ gốc trong feed thay vì lưới
 *    ấy làm cái xe đỗ cách chặng cuối 1,8–4,7 m.
 * 2. **Thước là thước của tile, không phải thước tại chỗ.** Layer quy đổi mét
 *    bằng `tileUnitsPerMetre`, tức **một** hằng số cho cả tile, lấy ở vĩ độ tâm
 *    tile. Dùng vĩ độ trung điểm từng đoạn — đúng hơn về địa lý — làm hai bên
 *    lệch tới 2,4 m ở z12. Nên chỗ này đo trong chính hệ Mercator ấy.
 * 3. **Mẫu cách đều `step` mét kể từ đầu đường**, không phải tại các đỉnh, và
 *    điểm đầu được đẩy lại một lần nữa ở cuối — bước cuối là **cú nhảy về chỗ
 *    xuất phát** chứ không phải một chỗ đứng lại.
 *
 * Mercator bảo giác nên tỉ lệ đẳng hướng: một đơn vị Mercator là
 * `C·cos(vĩ độ tâm tile)` mét theo cả hai chiều, và góc đo trong hệ ấy chính là
 * góc thật. Đó là lý do cả quãng đường lẫn hướng đều tính thẳng từ toạ độ
 * Mercator mà không phải quy đổi gì thêm.
 */

/** Bề rộng một tile tính bằng đơn vị toạ độ, bằng `EXTENT` của MapLibre. */
const TILE_EXTENT = 8192;
const EARTH_RADIUS_METRES = 6371008.8;
const EARTH_CIRCUMFERENCE_METRES = 2 * Math.PI * EARTH_RADIUS_METRES;
/** Xuất ra để `follow.ts` không dựng một cái thước thứ hai lệch với cái này. */
export const METRES_PER_DEGREE = EARTH_CIRCUMFERENCE_METRES / 360;

export type LngLat = [number, number];

/** Toạ độ Mercator chuẩn hoá, cùng hệ mà `MercatorCoordinate` của fork dùng. */
type Mercator = { x: number; y: number };

export type RouteSample = {
  lngLat: LngLat;
  /** Góc la bàn của hướng đi, độ. */
  bearing: number;
};

const toMercator = ([lng, lat]: LngLat): Mercator => ({
  x: (180 + lng) / 360,
  y: (180 - (180 / Math.PI) * Math.log(Math.tan(Math.PI / 4 + (lat * Math.PI) / 360))) / 360,
});

const toLngLat = ({x, y}: Mercator): LngLat => [
  x * 360 - 180,
  (360 / Math.PI) * Math.atan(Math.exp(((180 - y * 360) * Math.PI) / 180)) - 90,
];

/** Tuyến đã ghép, đo bằng đúng mét mà layer đo, và tra được theo quãng đường. */
export class Route {
  private readonly points: ReadonlyArray<Mercator>;
  /** Quãng đường cộng dồn tới từng đỉnh, mét. `cumulative[0]` là 0. */
  private readonly cumulative: ReadonlyArray<number>;
  /** Mét trên một đơn vị Mercator, tại vĩ độ tâm của tile nhận tuyến. */
  private readonly metresPerMercator: number;
  readonly length: number;
  /** Quãng mà shader chạy hết một vòng — dài hơn tuyến đúng một `step`. */
  readonly span: number;
  /**
   * Mốc lớn nhất còn nằm **trên đường**, mét.
   *
   * Bảng route chỉ có mẫu tại `k·step` với `k ≤ floor(length/step)`; mẫu kế tiếp
   * **là điểm xuất phát**. Nên mọi quãng đường trong `(usableLength, span)` rơi
   * vào dây cung nhảy về đầu tuyến — một đường thẳng cắt ngang khu công nghiệp,
   * không phải đường xe đi. Kẹp mốc tua ở `length` là chưa đủ: `length` lớn hơn
   * `usableLength` với mọi tuyến không chia hết cho `step`, và đo trên bốn hành
   * trình này thì bấm chặng cuối đặt cái xe cách đích **392 đến 2096 m**.
   */
  readonly usableLength: number;

  constructor(coordinates: ReadonlyArray<LngLat>, private readonly step: number, sourceMaxzoom: number) {
    const units = Math.pow(2, sourceMaxzoom) * TILE_EXTENT;
    const snap = (m: Mercator): Mercator => ({
      x: Math.round(m.x * units) / units,
      y: Math.round(m.y * units) / units,
    });
    this.points = coordinates.map((c) => snap(toMercator(c)));

    // Vĩ độ tâm của tile chứa đỉnh đầu — tile duy nhất vẽ cái xe, và là vĩ độ mà
    // `tileUnitsPerMetre` lấy làm thước cho **toàn bộ** tile.
    const tiles = Math.pow(2, sourceMaxzoom);
    const tileCentreLat = toLngLat({x: 0, y: (Math.floor(this.points[0].y * tiles) + 0.5) / tiles})[1];
    this.metresPerMercator = EARTH_CIRCUMFERENCE_METRES * Math.cos((tileCentreLat * Math.PI) / 180);

    const cumulative = [0];
    for (let i = 1; i < this.points.length; i++) {
      cumulative.push(cumulative[i - 1] + this.metres(this.points[i - 1], this.points[i]));
    }
    this.cumulative = cumulative;
    this.length = cumulative[cumulative.length - 1] ?? 0;
    this.span = this.length > 0 ? (Math.floor(this.length / step) + 1) * step : 0;
    this.usableLength = Math.max(this.span - step, 0);
  }

  /** Vị trí và hướng ở `travelled` mét dọc tuyến; `null` nếu tuyến suy biến. */
  sample(travelled: number): RouteSample | null {
    if (this.length <= 0 || this.span <= 0) return null;

    let wrapped = travelled % this.span;
    if (wrapped < 0) wrapped += this.span;

    // Cùng phép nội suy của shader: hai mẫu cách đều kề nhau, rồi lerp giữa chúng.
    const u = wrapped / this.step;
    const i0 = Math.floor(u);
    const p0 = this.sampleAt(i0);
    const p1 = this.sampleAt(i0 + 1);
    const t = u - i0;

    const dx = p1.x - p0.x;
    const dy = p1.y - p0.y;
    return {
      lngLat: toLngLat({x: p0.x + dx * t, y: p0.y + dy * t}),
      // Mercator y chạy về NAM, nên bắc là y âm và góc la bàn là atan(đông, bắc).
      // Đúng dòng mà `routePlacement` dùng.
      bearing: dx === 0 && dy === 0 ? 0 : (Math.atan2(dx, -dy) * 180) / Math.PI,
    };
  }

  /**
   * Quãng đường tới điểm trên tuyến gần `target` nhất, cùng khoảng lệch của nó.
   *
   * Đây là cách một chặng có được mốc tua: toạ độ của nó là dữ kiện đáng tin,
   * còn `distance_m` đi kèm thì đo bằng thước khác. `offset` trả về để chỗ gọi
   * kiểm được rằng chặng thật sự nằm trên tuyến.
   *
   * `after` là mốc của chặng trước, để chuỗi chặng luôn tăng dần.
   */
  distanceAt(target: LngLat, after = 0): { distance: number; offset: number } {
    const point = toMercator(target);
    let best = { distance: 0, offset: Infinity };
    for (let i = 1; i < this.points.length; i++) {
      // Bỏ qua các đoạn đã nằm sau mốc trước. Một tuyến tự chồng lên chính nó —
      // và bộ này có tiền lệ, hình học mover đã bị `outAndBack` nhân đôi — sẽ
      // gán chặng của nhánh về vào mốc của nhánh đi nếu tìm từ đầu mỗi lần.
      if (this.cumulative[i] < after) continue;

      const a = this.points[i - 1];
      const b = this.points[i];
      const abX = b.x - a.x;
      const abY = b.y - a.y;
      const lengthSquared = abX * abX + abY * abY;
      const t = lengthSquared > 0
        ? Math.min(Math.max(((point.x - a.x) * abX + (point.y - a.y) * abY) / lengthSquared, 0), 1)
        : 0;
      const offset = this.metres(point, {x: a.x + abX * t, y: a.y + abY * t});
      if (offset < best.offset) {
        best = {
          distance: this.cumulative[i - 1] + Math.sqrt(lengthSquared) * this.metresPerMercator * t,
          offset,
        };
      }
    }
    return best;
  }

  /**
   * Mẫu thứ `k` của bảng route.
   *
   * Chỉ số vượt mẫu cuối trả về **điểm đầu** — đó là bản sao mà `addRoute` đẩy
   * thêm để phép wrap trong shader rơi vào một mẫu có thật.
   */
  private sampleAt(k: number): Mercator {
    const last = Math.floor(this.length / this.step);
    if (k >= last + 1) return this.points[0];

    const target = k * this.step;
    let segment = 1;
    while (segment < this.cumulative.length - 1 && this.cumulative[segment] < target) segment++;

    const before = this.cumulative[segment - 1];
    const span = this.cumulative[segment] - before;
    const t = span > 0 ? (target - before) / span : 0;
    const a = this.points[segment - 1];
    const b = this.points[segment];
    return {x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t};
  }

  private metres(a: Mercator, b: Mercator): number {
    return Math.hypot(b.x - a.x, b.y - a.y) * this.metresPerMercator;
  }
}

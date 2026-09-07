/**
 * Mở trang trong Chrome không đầu và chờ tới lúc cảnh đã đủ.
 *
 * Chỉ còn một người dùng: `build-style.mjs`, thứ đọc `map.getStyle()` của trang
 * đang chạy. Trước đây đây là nền chung cho ba phép kiểm `check-*` chạy trên
 * trình duyệt; chúng đã bị gỡ, còn hai cái bẫy dưới đây thì không nên gỡ theo.
 *
 * Chạy được từ bất kỳ đâu: `puppeteer` không phải dependency của app này — nạp
 * nó từ `packages/gtelmaps-gl-js`, nơi bộ render test đã có sẵn. Khai thêm ở đây
 * là kéo về một bản Chrome nữa cho một việc chỉ chạy tay.
 *
 * Hai bẫy đã trả giá, đừng gỡ:
 *
 * - **Không dùng `networkidle2`.** Tile chảy liên tục nên nó không bao giờ tới.
 * - **`waitForFunction` phải nhận một HÀM, không phải chuỗi.** Dạng chuỗi trong
 *   puppeteer 24 không bao giờ khớp, và biểu hiện là timeout 90 giây ở một trang
 *   thực ra đã sẵn sàng từ giây thứ tám.
 */
import {createRequire} from 'node:module';
import {dirname, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

const here = dirname(fileURLToPath(import.meta.url));
const glJs = resolve(here, '../../../../packages/gtelmaps-gl-js');
const requireFromGlJs = createRequire(resolve(glJs, 'package.json'));

/** @type {import('puppeteer')} */
const puppeteer = requireFromGlJs('puppeteer');

export const REACT = 'http://localhost:5181';

/** Khung nhìn nghiệm thu, đặt qua hash `m` mà `<Map>` đọc. */
export const VIEW = '#m=18.15/10.59153/107.169352/-36.5/64';

/** Sáu layer dựng từ source geojson tải bằng `fetch` — chúng đến sau `loaded()`. */
const LATE_LAYERS = [
  'vehicle_trace',
  'vehicle',
  'employee_trace',
  'employee',
  'trace_route',
  'trace_actor',
];

export async function open(url, {width = 1280, height = 800} = {}) {
  const browser = await puppeteer.launch({
    headless: true,
    args: ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--no-sandbox'],
  });
  const page = await browser.newPage();
  await page.setViewport({width, height, deviceScaleFactor: 1});
  const errors = [];
  page.on('console', m => {
    if (m.type() === 'error') errors.push(m.text());
  });
  page.on('pageerror', e => errors.push(String(e)));
  await page.goto(url, {waitUntil: 'domcontentloaded', timeout: 60000});
  await page.waitForFunction(() => Boolean(window.map?.loaded?.()), {timeout: 90000, polling: 250});
  // `loaded()` xanh TRƯỚC khi ba source geojson về, vì chúng được `fetch` sau khi
  // style nạp xong. Không chờ thêm thì mọi phép đo chạy trên một cảnh còn thiếu
  // sáu layer, và nó xanh vì hỏi sai lúc chứ không vì đúng.
  await page.waitForFunction(
    ids => ids.every(id => Boolean(window.map.getLayer(id))),
    {timeout: 90000, polling: 250},
    LATE_LAYERS,
  );
  return {browser, page, errors};
}

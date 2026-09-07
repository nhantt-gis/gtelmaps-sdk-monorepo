/**
 * Tab "Truy vết": chọn một biển số rồi xem lại hành trình của nó.
 *
 * Danh sách chặng đúng là thứ bảng Dashboard của bản gốc bày ra
 * (`VehicleTraceController.sendResponse` → `TraceSegmentInfo[]`): số thứ tự, giờ
 * ghi nhận, tên nút, mã camera, tốc độ, hướng, độ tin của AI. Bản gốc **không
 * vẽ** các chặng ấy trong 3D và ở đây cũng vậy.
 *
 * Thanh tua và ô chữ **không** đi qua state: chúng nghe thẳng nhịp phát lại rồi
 * tự ghi vào DOM. Xem đầu `tracing/hooks.ts` để biết vì sao ranh giới nằm ở đó.
 */

import {useCallback, useEffect, useMemo, useRef} from 'react';
import {useMap} from '@gis/gtelmaps-sdk-react';

import {TRACE_SPEED_CHOICES, boundsOf} from '../../tracing/trace';
import {useCameraFollow, useTracePlayback} from '../../tracing/hooks';

import type {Trace} from '../../tracing/trace';

/** Bản gốc bay tới hành trình vừa chọn bằng đúng bộ tham số này. */
const FIT_BOUNDS = {padding: 90, bearing: 0, pitch: 0, duration: 1600} as const;

type Props = {
  traces: ReadonlyMap<string, Trace>;
  plate: string | null;
  onPlate: (plate: string | null) => void;
};

export function TraceTab({traces, plate, onPlate}: Props) {
  const mapRef = useMap().current;
  const trace = useMemo(() => (plate ? traces.get(plate) ?? null : null), [traces, plate]);

  const {route, status, controls, subscribe, currentSample} = useTracePlayback(trace);
  const follow = useCameraFollow(currentSample);

  const seekRef = useRef<HTMLInputElement>(null);
  const readoutRef = useRef<HTMLSpanElement>(null);
  const usable = Math.floor(route?.usableLength ?? 0);

  // Nghe nhịp đầy đủ và ghi thẳng vào hai nút DOM. Không `setState` ở đây.
  useEffect(
    () =>
      subscribe(state => {
        const seek = seekRef.current;
        // Thanh tua do chính tay người dùng kéo thì không ghi đè lên tay họ.
        if (seek && document.activeElement !== seek) {
          seek.value = String(Math.round(state.distance));
        }
        const readout = readoutRef.current;
        if (readout) {
          readout.textContent = route
            ? `${Math.round(state.distance)} / ${usable} m` +
              (state.legIndex >= 0 ? ` · chặng ${state.legIndex + 1}` : '')
            : '';
        }
      }),
    [subscribe, route, usable],
  );

  // Chọn xe mới là thôi bám và bay tới hành trình ấy.
  useEffect(() => {
    follow.setFollowing(false);
    if (!trace) return;
    mapRef?.getMap().fitBounds(boundsOf(trace), FIT_BOUNDS);
    // `follow` đổi identity mỗi lần `following` đổi; chỉ `trace` mới được kích hoạt lại.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [trace, mapRef]);

  const stepSpeed = useCallback(
    (direction: -1 | 1) => {
      const index = TRACE_SPEED_CHOICES.indexOf(status.speed as (typeof TRACE_SPEED_CHOICES)[number]);
      const next = TRACE_SPEED_CHOICES[Math.min(Math.max(index + direction, 0), TRACE_SPEED_CHOICES.length - 1)];
      controls.setSpeed(next);
    },
    [controls, status.speed],
  );

  const plates = useMemo(() => [...traces.keys()], [traces]);

  return (
    <>
      <div className='cd-sim-filter'>
        <select
          // Mốc ổn định cho bộ kiểm không đầu bám vào; tab Lớp nền cũng có một
          // `<select>` và nó đứng trước trong DOM.
          id='trace-plate'
          className='cd-sim-input'
          value={plate ?? ''}
          onChange={e => onPlate(e.currentTarget.value || null)}
        >
          <option value=''>— chọn biển số —</option>
          {plates.map(value => (
            <option key={value} value={value}>
              {value}
            </option>
          ))}
        </select>
        <button
          type='button'
          className='cd-sim-act ghost'
          disabled={!trace}
          onClick={() => onPlate(null)}
        >
          ✕ Hủy bỏ
        </button>
      </div>

      {trace ? (
        <>
          <div className='cd-sim-playbar'>
            <button type='button' className='cd-sim-act primary' onClick={controls.toggle}>
              {status.playing ? '⏸ Dừng' : '▶ Chạy'}
            </button>
            <button
              type='button'
              className='cd-sim-act'
              title='Về đầu tuyến và chạy lại'
              onClick={controls.restart}
            >
              ↻ Chạy lại
            </button>
            <button
              type='button'
              className={follow.following ? 'cd-sim-act primary' : 'cd-sim-act'}
              onClick={() => follow.setFollowing(!follow.following)}
            >
              🎯 Bám theo
            </button>
            <div className='cd-sim-stepper'>
              <button
                type='button'
                onClick={() => stepSpeed(-1)}
                disabled={status.speed <= TRACE_SPEED_CHOICES[0]}
              >
                −
              </button>
              <span className='cd-sim-stepper-val'>×{status.speed}</span>
              <button
                type='button'
                onClick={() => stepSpeed(1)}
                disabled={status.speed >= TRACE_SPEED_CHOICES[TRACE_SPEED_CHOICES.length - 1]}
              >
                +
              </button>
            </div>
          </div>

          <div className='cd-sim-explode'>
            <div className='cd-sim-explode-label'>
              <span>Tua</span>
              <span className='cd-sim-val' ref={readoutRef} />
            </div>
            {/*
              Trần là `usableLength`, KHÔNG phải độ dài tuyến: quãng giữa hai mốc
              ấy nằm trên dây cung nhảy về xuất phát. Kéo hết tay phải ra đích,
              không phải ra giữa khu công nghiệp.
            */}
            <input
              ref={seekRef}
              // Cùng lý do với `#trace-plate`: bộ kiểm cần một mốc ổn định, và
              // `.cd-sim-explode-range` là class dùng chung của mọi thanh trượt.
              id='trace-seek'
              className='cd-sim-explode-range'
              type='range'
              min={0}
              max={usable}
              step={1}
              defaultValue={0}
              onChange={e => controls.seek(Number(e.currentTarget.value))}
            />
          </div>

          <div className='cd-sim-sec'>
            <span className='cd-sim-sec-t'>{trace.legs.length} chặng</span>
            <span className='cd-sim-sec-evt'>{trace.route}</span>
          </div>
          <div className='cd-sim-list'>
            {trace.legs.map((leg, index) => (
              <button
                key={leg.sequence}
                type='button'
                className={index === status.legIndex ? 'cd-sim-row seg sel' : 'cd-sim-row seg'}
                onClick={() => controls.gotoLeg(index)}
              >
                <span className='cd-sim-seq'>{leg.sequence}</span>
                <span className='cd-sim-seg-col'>
                  <span className='cd-sim-row-name'>{leg.name}</span>
                  <span className='cd-sim-row-sub'>
                    {leg.capture_time} · {leg.camera_code} · {leg.speed_kmh} km/h · {leg.direction} ·
                    AI {leg.ai_confidence}%
                  </span>
                </span>
              </button>
            ))}
          </div>
        </>
      ) : (
        <div className='cd-sim-empty'>Chọn một biển số để xem lại hành trình.</div>
      )}
    </>
  );
}

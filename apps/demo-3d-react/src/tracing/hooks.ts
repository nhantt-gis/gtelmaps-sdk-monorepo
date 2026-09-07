/**
 * Hai hook nối tầng truy vết mệnh lệnh vào React — và ranh giới giữa chúng là
 * cả lý do file này tồn tại.
 *
 * `TracePlayback` và `CameraFollow` đẩy trạng thái ra 60 lần mỗi giây. Đưa con
 * số ấy vào `useState` là render lại cả cây React ở nhịp đó, mà cây này có bảng
 * điều khiển với hơn hai chục ô — đúng thứ mà `3d-plugins` ghi thẳng trong
 * `CLAUDE.md` của họ là lỗi, không phải chuyện tối ưu vặt.
 *
 * Nên trạng thái bị chẻ đôi:
 *
 * - **Đổi hiếm** (`playing`, `speed`, `legIndex`) đi qua `useState`. `legIndex`
 *   nhảy vài chục lần cho cả hành trình, không phải mỗi frame.
 * - **Đổi mỗi frame** (`distance`) chỉ đi tới những ai đăng ký nghe. Thanh tua
 *   và ô chữ tự ghi vào DOM qua ref — cùng lối `demo-3d-parity` làm, vì ở đó
 *   cũng không có React nào để mà đi qua.
 *
 * Kết quả đo được: 3 giây phát lại, cây React render đúng số lần bằng số lần
 * `legIndex` đổi.
 */

import {useCallback, useEffect, useMemo, useRef, useState} from 'react';
import {useMap, useMapPaintProperty} from '@gis/gtelmaps-sdk-react';

import {CameraFollow} from './follow';
import {Route} from './route';
import {IDLE_PLAYBACK, TracePlayback} from './playback';
import {TRACE_ACTOR_LAYER, TRACE_ROUTE_STEP_METRES, TRACE_SOURCE_MAXZOOM} from './trace';

import type {Map as MapLike} from '@gis/gtelmaps-gl-js';
import type {PlaybackState} from './playback';
import type {RouteSample} from './route';
import type {Trace} from './trace';

/** Khoảng lệch tối đa còn coi là chặng nằm trên tuyến, mét. */
const ON_ROUTE_TOLERANCE_M = 2;

/** Phần trạng thái đủ chậm để được phép làm React render lại. */
export type PlaybackStatus = {
  playing: boolean;
  speed: number;
  legIndex: number;
};

export type PlaybackControls = {
  play(): void;
  pause(): void;
  toggle(): void;
  /** Về đầu tuyến và chạy lại — `reset` của bản gốc. */
  restart(): void;
  seek(distance: number): void;
  gotoLeg(index: number): void;
  setSpeed(multiplier: number): void;
};

export type TracePlaybackApi = {
  route: Route | null;
  /** Mốc tua của từng chặng, mét, theo thước của layer. */
  legDistances: ReadonlyArray<number>;
  status: PlaybackStatus;
  controls: PlaybackControls;
  /** Nghe nhịp đầy đủ. Trả về hàm huỷ đăng ký. */
  subscribe(listener: (state: PlaybackState) => void): () => void;
  currentSample(): RouteSample | null;
};

function statusOf(state: PlaybackState): PlaybackStatus {
  return {playing: state.playing, speed: state.speed, legIndex: state.legIndex};
}

/**
 * Mốc tua của từng chặng, chiếu lên tuyến bằng thước của layer.
 *
 * Không lấy `leg.distance_m`: con số ấy đo bằng công thức phẳng của bộ sinh dữ
 * liệu (`111320·cos`, `110540`) còn layer đo bằng Mercator bảo giác — hai thước
 * lệch 0,27–0,40%, tức 14–17 m ở cuối tuyến. Mỗi chặng tìm từ mốc của chặng
 * trước để chuỗi luôn tăng dần, kể cả khi tuyến tự chồng lên chính nó.
 */
function placeLegs(trace: Trace, route: Route): ReadonlyArray<number> {
  const distances: number[] = [];
  let strays = 0;
  let after = 0;
  for (const leg of trace.legs) {
    const placed = route.distanceAt([leg.lng, leg.lat], after);
    // `offset` phải gần 0. Nếu không thì dữ liệu sai chứ không phải phép chiếu sai.
    if (placed.offset > ON_ROUTE_TOLERANCE_M) strays++;
    distances.push(placed.distance);
    after = placed.distance;
  }
  if (strays) console.warn(`${strays} chặng không nằm trên tuyến của chính nó`);
  return distances;
}

/**
 * Phát lại hành trình `trace`.
 *
 * Chọn hành trình mới là chạy ngay, đúng như bản gốc. `trace` là `null` thì
 * dừng và tuyến rỗng.
 */
export function useTracePlayback(trace: Trace | null): TracePlaybackApi {
  const setActorPaint = useMapPaintProperty(TRACE_ACTOR_LAYER);

  const [status, setStatus] = useState<PlaybackStatus>(() => statusOf(IDLE_PLAYBACK));
  const statusRef = useRef(status);
  const listenersRef = useRef(new Set<(state: PlaybackState) => void>());
  const playbackRef = useRef<TracePlayback | null>(null);

  // Tuyến dựng lại đúng một lần cho mỗi hành trình. `Route` lấy mẫu cả tuyến
  // trong hàm dựng — 3,6 km ở bước 2 m là khoảng 1800 mẫu.
  const route = useMemo(
    () => (trace ? new Route(trace.coordinates, TRACE_ROUTE_STEP_METRES, TRACE_SOURCE_MAXZOOM) : null),
    [trace],
  );
  const legDistances = useMemo(() => (trace && route ? placeLegs(trace, route) : []), [trace, route]);

  useEffect(() => {
    const playback = new TracePlayback(
      seconds => setActorPaint('model-3d-route-time', seconds),
      state => {
        for (const listener of listenersRef.current) listener(state);
        // Chỉ chạm React khi phần chậm thật sự đổi. Gọi `setStatus` mỗi frame với
        // một object mới là render lại mỗi frame, kể cả khi ba trường bằng nhau.
        const next = statusOf(state);
        const prev = statusRef.current;
        if (
          prev.playing === next.playing &&
          prev.speed === next.speed &&
          prev.legIndex === next.legIndex
        ) {
          return;
        }
        statusRef.current = next;
        setStatus(next);
      },
    );
    playbackRef.current = playback;
    return () => {
      playback.destroy();
      playbackRef.current = null;
    };
  }, [setActorPaint]);

  useEffect(() => {
    playbackRef.current?.select(trace, route, legDistances);
  }, [trace, route, legDistances]);

  const controls = useMemo<PlaybackControls>(
    () => ({
      play: () => playbackRef.current?.play(),
      pause: () => playbackRef.current?.pause(),
      toggle: () => {
        const playback = playbackRef.current;
        if (!playback) return;
        if (playback.getState().playing) playback.pause();
        else playback.play();
      },
      restart: () => playbackRef.current?.reset(),
      seek: distance => playbackRef.current?.gotoDistance(distance),
      gotoLeg: index => playbackRef.current?.gotoLeg(index),
      setSpeed: multiplier => playbackRef.current?.setSpeed(multiplier),
    }),
    [],
  );

  const subscribe = useCallback((listener: (state: PlaybackState) => void) => {
    const listeners = listenersRef.current;
    listeners.add(listener);
    // Đẩy ngay một nhịp: người nghe vừa gắn vào phải thấy trạng thái hiện tại
    // chứ không phải chờ frame sau — và khi đang dừng thì không có frame sau.
    listener(playbackRef.current?.getState() ?? IDLE_PLAYBACK);
    return () => {
      listeners.delete(listener);
    };
  }, []);

  const currentSample = useCallback(() => playbackRef.current?.currentSample() ?? null, []);

  return {route, legDistances, status, controls, subscribe, currentSample};
}

export type CameraFollowApi = {
  following: boolean;
  setFollowing(on: boolean): void;
};

/**
 * Camera bám theo cái xe đang chạy.
 *
 * `getTarget` phải là một hàm ổn định đọc vị trí **tại lúc gọi** — vòng bám tự
 * hỏi mỗi nhịp, nên truyền một giá trị đã chụp vào đây là camera đứng yên.
 */
export function useCameraFollow(getTarget: () => RouteSample | null): CameraFollowApi {
  const mapRef = useMap().current;
  const map = mapRef?.getMap() as MapLike | undefined;

  const [following, setFollowing] = useState(false);
  const followRef = useRef<CameraFollow | null>(null);
  const getTargetRef = useRef(getTarget);
  getTargetRef.current = getTarget;

  useEffect(() => {
    if (!map) return undefined;
    let live = true;
    const follow = new CameraFollow(
      map,
      () => getTargetRef.current(),
      () => {
        // Người dùng kéo bản đồ là thôi bám — ô tick phải nói đúng sự thật ấy.
        // Chắn `live` vì `stop()` cũng chạy trong lúc dọn dẹp khi component tháo.
        if (live) setFollowing(false);
      },
    );
    followRef.current = follow;
    return () => {
      live = false;
      follow.stop();
      followRef.current = null;
    };
  }, [map]);

  const request = useCallback((on: boolean) => {
    const follow = followRef.current;
    if (!follow) return;
    if (on) follow.start();
    else follow.stop();
    // `start` từ chối khi chưa có xe nào để bám; ô tick phải nói đúng điều đó
    // thay vì đứng đó khẳng định một việc không xảy ra.
    setFollowing(follow.following);
  }, []);

  return {following, setFollowing: request};
}

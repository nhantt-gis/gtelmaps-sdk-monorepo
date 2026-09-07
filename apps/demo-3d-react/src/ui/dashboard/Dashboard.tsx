/**
 * Ngăn kéo điều khiển, giữa mép dưới — mượn hình dáng bảng Dashboard giả lập của
 * `3d-plugins` (`#cd-evtdbg`).
 *
 * **Cả ba tab luôn mount**, chỉ đổi class `is-active`. Tháo tab đang ẩn ra sẽ
 * làm mất giá trị của các ô không kiểm soát và, tệ hơn ở trang này, tháo luôn
 * `useTracePlayback` — tức là dừng phát lại chỉ vì người dùng nhìn sang tab khác.
 *
 * Cả ngăn kéo đưa ra ngoài `<body>` qua cổng: nó phải là anh em ruột của `#map`
 * để script chụp ảnh ẩn được nó.
 */

import {useState} from 'react';

import {BodyPortal} from '../BodyPortal';
import {BuildingsTab} from './BuildingsTab';
import {LayersTab} from './LayersTab';
import {TraceTab} from './TraceTab';

import type {Trace} from '../../tracing/trace';

const TABS = [
  {id: 'layers', label: 'Lớp nền'},
  {id: 'buildings', label: 'Công trình'},
  {id: 'trace', label: 'Truy vết'},
] as const;

type TabId = (typeof TABS)[number]['id'];

type Props = {
  traces: ReadonlyMap<string, Trace>;
  plate: string | null;
  onPlate: (plate: string | null) => void;
};

export function Dashboard({traces, plate, onPlate}: Props) {
  const [open, setOpen] = useState(true);
  const [tab, setTab] = useState<TabId>('layers');

  const pane = (id: TabId) => (id === tab ? 'cd-evtdbg-pane is-active' : 'cd-evtdbg-pane');

  return (
    <BodyPortal>
      <div className={open ? 'cd-evtdbg open' : 'cd-evtdbg'}>
        <button type='button' className='cd-evtdbg-toggle' onClick={() => setOpen(v => !v)}>
          <span className='cd-evtdbg-caret'>{open ? '▼' : '▲'}</span> Bảng điều khiển
        </button>
        <div className='cd-evtdbg-panel'>
          <div className='cd-evtdbg-tabs'>
            {TABS.map(item => (
              <button
                key={item.id}
                type='button'
                className={item.id === tab ? 'cd-evtdbg-tab is-active' : 'cd-evtdbg-tab'}
                onClick={() => setTab(item.id)}
              >
                {item.label}
              </button>
            ))}
          </div>
          <div className='cd-evtdbg-body'>
            <div className={pane('layers')}>
              <LayersTab />
            </div>
            <div className={pane('buildings')}>
              <BuildingsTab />
            </div>
            <div className={pane('trace')}>
              <TraceTab traces={traces} plate={plate} onPlate={onPlate} />
            </div>
          </div>
        </div>
      </div>
    </BodyPortal>
  );
}

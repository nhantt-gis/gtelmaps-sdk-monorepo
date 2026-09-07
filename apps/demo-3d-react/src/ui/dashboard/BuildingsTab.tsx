/**
 * Tab "Công trình": chọn bộ vỏ nhà và chỉnh nó.
 *
 * Ba layer cùng vẽ 372 toà nhà, luôn đúng một cái hiện: `building-atlas` (mặt
 * tiền có ô cửa), `building-glass` (kính, X-quang) và `fill-extrusion` đặc — cái
 * cuối là **mốc đối chiếu**, không phải một lựa chọn thẩm mỹ.
 */

import {useControls} from '../../state';
import {DEFAULT_BAY_WIDTH} from '../../scene/buildings';
import {Note, Section, Segmented, Slider, Toggle, ToggleGrid} from './parts';

import type {BuildingMode} from '../../state';

const MODES: ReadonlyArray<{value: BuildingMode; label: string}> = [
  {value: 'atlas', label: 'building-atlas'},
  {value: 'glass', label: 'building-glass'},
];

export function BuildingsTab() {
  const {controls, set} = useControls();
  const glass = controls.mode === 'glass';

  return (
    <>
      <Section title='Bộ vỏ'>
        <Segmented options={MODES} value={controls.mode} onChange={v => set('mode', v)} />
      </Section>

      {glass ? (
        <Section title='Kính'>
          <ToggleGrid>
            <Toggle
              label='X-quang'
              title='Xuyên nền và nhà khác'
              checked={controls.xray}
              onChange={v => set('xray', v)}
            />
            <Toggle
              label='Viền khuất'
              title='Mặt sau và mặt dưới'
              checked={controls.hiddenEdges}
              onChange={v => set('hiddenEdges', v)}
            />
          </ToggleGrid>
          <Slider
            label='Độ đậm viền'
            value={controls.edge}
            min={0}
            max={1}
            step={0.05}
            format={v => v.toFixed(2)}
            onChange={v => set('edge', v)}
          />
          <Slider
            label='Độ đục nền kính'
            value={controls.opacity}
            min={0}
            max={0.6}
            step={0.01}
            format={v => v.toFixed(2)}
            onChange={v => set('opacity', v)}
          />
        </Section>
      ) : (
        <Section title='Mặt tiền'>
          <Slider
            label='Đêm (cửa sổ sáng)'
            value={controls.night}
            min={0}
            max={1}
            step={0.05}
            format={v => v.toFixed(2)}
            onChange={v => set('night', v)}
          />
          <Slider
            label='Bề rộng ô cửa'
            // `null` là "theo từng toà nhà"; thanh trượt đứng ở giá trị dự phòng
            // cho tới khi có người chạm vào nó.
            value={controls.bay ?? DEFAULT_BAY_WIDTH}
            min={2}
            max={16}
            step={0.5}
            format={v => (controls.bay === null ? 'theo từng toà' : `${v} m`)}
            onChange={v => set('bay', v)}
          />
          <Note>
            Bề rộng ô là property <b>layout</b>: đổi nó là parse lại hình học tile,
            nên thanh này giật là đúng thiết kế chứ không phải chậm. Kéo một lần là
            ghi đè cho mọi toà nhà, và không có đường quay lại "theo từng toà" —
            bản gốc cũng vậy.
          </Note>
        </Section>
      )}
    </>
  );
}

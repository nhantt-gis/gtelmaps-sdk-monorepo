/**
 * Tab "Lớp nền": bật/tắt từng tập dữ liệu, và bốn cái van đóng băng.
 *
 * Bốn ô "đóng băng" (sóng, nhịp cảnh báo, nhịp tường, dòng chảy) không phải cho
 * đẹp: mỗi layer động tự gọi `triggerRepaint` mỗi frame, nên chừng nào còn một
 * cái chạy thì hai lần chụp cùng một khung nhìn **không bao giờ** trùng pixel.
 */

import {useControls} from '../../state';
import {Section, Slider, Toggle, ToggleGrid} from './parts';

export function LayersTab() {
  const {controls, set} = useControls();

  return (
    <>
      <Section title='Cảnh quan'>
        <ToggleGrid>
          <Toggle
            label='Thảm nền'
            title='Ranh khu, 505 mặt cỏ, vỉa hè và đường'
            checked={controls.surfaces}
            onChange={v => set('surfaces', v)}
          />
          <Toggle
            label='Mặt nước'
            title='44 mặt — hai màu, sóng, đốm nắng'
            checked={controls.water}
            onChange={v => set('water', v)}
          />
          <Toggle
            label='Mặt đường'
            title='888 tim đường, vạch gạch 7/6 m'
            checked={controls.roads}
            onChange={v => set('roads', v)}
          />
          <Toggle
            label='Bóng đổ'
            title='Nhà và model đổ bóng lên mặt nền'
            checked={controls.shadows}
            onChange={v => set('shadows', v)}
          />
        </ToggleGrid>

      </Section>

      <Section title='Đối tượng và hạ tầng'>
        <ToggleGrid>
          <Toggle
            label='Model 3D'
            title='Cây, hạ tầng, xe, nhân viên'
            checked={controls.models}
            onChange={v => set('models', v)}
          />
          <Toggle
            label='Nón camera'
            title='32 camera, màu theo trạng thái'
            checked={controls.cones}
            onChange={v => set('cones', v)}
          />
          <Toggle
            label='Nhãn 3D'
            title='Tên nhà, thửa, thiết bị, tuyến — chống chồng lấn'
            checked={controls.labels}
            onChange={v => set('labels', v)}
          />
          <Toggle
            label='Cảnh báo động'
            title='16/651 thiết bị bất thường — vòng radar và cột đèn hiệu'
            checked={controls.alerts}
            onChange={v => set('alerts', v)}
          />
          <Toggle
            label='Tường ranh khu'
            title='Rèm cyan 100 m dọc ranh KCN, 1986 đỉnh'
            checked={controls.zoneWall}
            onChange={v => set('zoneWall', v)}
          />
          <Toggle
            label='Mạng kỹ thuật'
            title='112 ống điện và cáp ở +18/+19 m'
            checked={controls.networks}
            onChange={v => set('networks', v)}
          />
          <Toggle
            label='Ống ngầm xuyên đất'
            title='83 ống cấp nước ở −10 m; tắt là chìm dưới đất, đúng bản gốc'
            checked={controls.buried}
            onChange={v => set('buried', v)}
          />
          <Toggle
            label='Tuyến di chuyển'
            title='200 tuyến xe và người, dải sáng chạy dọc hành trình'
            checked={controls.traces}
            onChange={v => set('traces', v)}
          />
        </ToggleGrid>
      </Section>

      <Section title='Quy hoạch'>
        <ToggleGrid>
          <Toggle
            label='Lô doanh nghiệp'
            title='142 thửa, viền hổ phách'
            checked={controls.cadastralParcel}
            onChange={v => set('cadastralParcel', v)}
          />
          <Toggle
            label='Quy hoạch SDĐ'
            title='794 thửa, 20 màu theo feature'
            checked={controls.plannedLanduse}
            onChange={v => set('plannedLanduse', v)}
          />
          <Toggle
            label='Lô đất quy hoạch'
            title='683 thửa, viền lam'
            checked={controls.plannedParcel}
            onChange={v => set('plannedParcel', v)}
          />
        </ToggleGrid>
      </Section>

      <Section title='Đóng băng chuyển động'>
        <ToggleGrid>
          <Toggle label='Sóng chạy' checked={controls.waves} onChange={v => set('waves', v)} />
          <Toggle
            label='Nhịp cảnh báo'
            checked={controls.alertPulse}
            onChange={v => set('alertPulse', v)}
          />
          <Toggle label='Nhịp tường' checked={controls.wallPulse} onChange={v => set('wallPulse', v)} />
          <Toggle
            label='Dòng chảy trên tuyến'
            title='Vạch 14 m chạy 26 m/s, đúng mặc định bản gốc; tắt là đứng yên chứ không mất'
            checked={controls.traceFlow}
            onChange={v => set('traceFlow', v)}
          />
        </ToggleGrid>
        <Slider
          label='Gió (cây đung đưa)'
          value={controls.wind}
          min={0}
          max={2}
          step={0.1}
          format={v => v.toFixed(1)}
          onChange={v => set('wind', v)}
        />
      </Section>
    </>
  );
}

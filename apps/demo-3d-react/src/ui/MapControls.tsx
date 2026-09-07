/**
 * Cụm điều khiển bản đồ, góc phải dưới.
 *
 * Thứ tự nhìn thấy **ngược** với thứ tự JSX: MapLibre chèn control ở neo
 * `bottom-*` vào đầu container, nên cái khai báo sau lại nằm trên. Bản React của
 * `3d-plugins` ghi lại đúng bẫy này; giữ nguyên trình tự dưới đây thì cụm hiện
 * ra là toàn màn hình → 2D/3D → zoom và la bàn, từ trên xuống.
 */

import {useCallback} from 'react';
import {FullscreenControl, NavigationControl, useControl, useMap} from '@gis/gtelmaps-sdk-react';

/** Độ nghiêng khi về chế độ 2D. */
const FLAT_PITCH = 0;

class PitchToggleControl {
  private container: HTMLElement | null = null;

  constructor(
    private readonly pitch3D: number,
    private readonly onToggle: (next: number) => void,
    private readonly getPitch: () => number,
  ) {}

  onAdd(): HTMLElement {
    const container = document.createElement('div');
    container.className = 'maplibregl-ctrl maplibregl-ctrl-group';
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'maplibregl-ctrl-pitchtoggle';
    const paint = () => {
      // Nhãn là chế độ sẽ **chuyển sang**, không phải chế độ đang ở — cùng lối
      // bản gốc, và đó là điều người ta trông đợi ở một nút chuyển.
      button.textContent = this.getPitch() > FLAT_PITCH ? '2D' : '3D';
    };
    button.addEventListener('click', () => {
      this.onToggle(this.getPitch() > FLAT_PITCH ? FLAT_PITCH : this.pitch3D);
      // Bản đồ ease tới góc mới, nên nhãn phải chờ chuyến bay xong mới đổi.
      setTimeout(paint, 0);
    });
    paint();
    container.append(button);
    this.container = container;
    return container;
  }

  onRemove(): void {
    this.container?.remove();
    this.container = null;
  }
}

export function MapControls({pitch3D}: {pitch3D: number}) {
  const mapRef = useMap().current;

  const toggle = useCallback(
    (pitch: number) => {
      mapRef?.getMap().easeTo({pitch, duration: 600});
    },
    [mapRef],
  );

  useControl(
    ({map}) => new PitchToggleControl(pitch3D, toggle, () => map.getMap().getPitch()),
    {position: 'bottom-right'},
  );

  return (
    <>
      <NavigationControl position='bottom-right' showCompass showZoom visualizePitch />
      <FullscreenControl position='bottom-right' />
    </>
  );
}

/** Tiêu đề trung tâm giám sát, góc trái trên. Chỉ để nhìn, không bấm được. */

import {BodyPortal} from './BodyPortal';

export function HudTitle() {
  return (
    <BodyPortal>
      <div id='hud-title'>
        <span className='hud-dot' />
        <div>
          <h1>KHU CÔNG NGHIỆP CHÂU ĐỨC</h1>
          <p>Trung tâm giám sát vận hành · 3D WebGIS</p>
        </div>
      </div>
    </BodyPortal>
  );
}

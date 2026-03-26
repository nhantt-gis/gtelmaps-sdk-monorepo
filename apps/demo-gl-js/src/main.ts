import './style.css';
import * as gtelmapsgl from '@gis/gtelmaps-gl-js';
import '@gis/gtelmaps-gl-js/dist/gtelmaps-gl.css';

const map = new gtelmapsgl.Map({
  container: 'map',
  style: 'https://demotiles.maplibre.org/style.json',
  center: [105.8042435, 20.9966552],
  zoom: 18,
  hash: true
});

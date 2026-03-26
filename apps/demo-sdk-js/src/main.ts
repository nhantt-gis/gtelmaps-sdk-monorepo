import './style.css';
import { Map as SDKMap } from '@gis/gtelmaps-sdk-js';
import '@gis/gtelmaps-sdk-js/dist/gtelmaps-sdk.css';

const map = new SDKMap({
  container: 'map',
  style: 'gtelmaps-streets-v1',
  center: [105.8042435, 20.9966552],
  zoom: 18,
  hash: true,
  apiKey: "NkJ7pLZ3rA5tXvW2cE0KdQ9oIi4CVY8Ox"
});

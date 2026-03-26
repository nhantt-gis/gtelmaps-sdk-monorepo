import './style.css';
import * as gtelmapsgl from '@gis/gtelmaps-gl-js';
import '@gis/gtelmaps-gl-js/dist/gtelmaps-gl.css';
import { Layer3D, AltitudeReference } from '@gis/gtelmaps-3d-js';
import { GUI } from 'lil-gui';

const map = new gtelmapsgl.Map({
  container: 'map',
  style: 'https://demotiles.maplibre.org/style.json',
  center: [105.8042435, 20.9966552],
  zoom: 18,
  pitch: 45,
  hash: true
});

map.on('style.load', async () => {
  const layer3D = new Layer3D('3d-layer');
  map.addLayer(layer3D as unknown as gtelmapsgl.CustomLayerInterface);
  
  // Increasing the intensity of the ambient light
  layer3D.setAmbientLight({intensity: 2});

  // Adding a point light
  layer3D.addPointLight("point-light", {intensity: 30});

  const gui = new GUI({ width: 200 });

  // Adding a mesh of a lantern.
  // We make this first mesh invisible because we will only use it to be cloned
  const originalLanternID = "lantern";
  await layer3D.addMeshFromURL(
    originalLanternID,
    "https://docs-media.maptiler.com/docs/models/lantern.glb",
    {
      scale: 1,
      visible: true,
      heading: 215,
      lngLat: [105.8045435, 20.9969552]
    }
  );

  const originalDuckID = "duck";
  await layer3D.addMeshFromURL(
    originalDuckID,
    "https://docs-media.maptiler.com/docs/models/duck.glb",
    {
      scale: 10,
      visible: true,
      heading: 155,
      lngLat: [105.8039435, 20.9963552]
    }
  );

  const originalPlaneID = "plane";
  await layer3D.addMeshFromURL(
    originalPlaneID,
    "https://docs-media.maptiler.com/docs/models/plane_a340.glb",
    {
      scale: 1,
      visible: false,
      altitude: 0,
      altitudeReference: AltitudeReference.MEAN_SEA_LEVEL,
    }
  );

  const originalDragonID = "dragon";
  await layer3D.addMeshFromURL(
    originalDragonID,
    "https://docs-media.maptiler.com/docs/models/stanford_dragon_pbr.glb",
    {
      scale: 0.20,
      visible: true,
      heading: 215.7,
      lngLat: [105.8045435, 20.9963552]
    }
  );

  const guiObj = {
    model: originalLanternID,
    heading: 0,
    scale: 1,
    altitude: 0,
  }

  let meshCounter = 0;
  let latestMeshID = originalLanternID

  // Clones of this mesh will be added as we click on the map.
  // The lantern model that is used for the clone is the latest mesh added,
  // so that we can benefit from the latest heading we defined
  map.on("click", (e) => {
    meshCounter += 1;
    const newCloneID = `${originalLanternID}_${meshCounter}`;
    console.log(e.lngLat);
    layer3D.cloneMesh(guiObj.model, newCloneID, {lngLat: e.lngLat, visible: true, heading: guiObj.heading, scale: guiObj.scale})
    latestMeshID = newCloneID;
  })

  gui.add(guiObj, "model", [originalLanternID, originalDuckID, originalPlaneID, originalDragonID])

  // We can change the heading of the latest mesh added
  gui.add( guiObj, 'heading', 0, 360, 0.1 )
  .onChange((heading: number) => {
    const mesh = layer3D.getItem3D(latestMeshID);
    mesh?.modify({heading});
  });

  gui.add( guiObj, 'scale', 0.01, 10, 0.01 )
  .onChange((scale: number) => {
    const mesh = layer3D.getItem3D(latestMeshID);
    mesh?.modify({scale});
  })

  gui.add( guiObj, 'altitude', -100, 1000, 1 )
  .onChange((altitude: number) => {
    const mesh = layer3D.getItem3D(latestMeshID);
    mesh?.modify({altitude});
  })
});

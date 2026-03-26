'use client';
import React from 'react';
import { Layer, Source } from '@gis/gtelmaps-sdk-react';
import type { ModelLayerSpecification, VectorSourceSpecification } from '@gis/gtelmaps-sdk-react';

const TILE_URL = 'https://your-tile-server.example.com/tiles/{z}/{x}/{y}.pbf';
const SOURCE_LAYER = 'your_model_source_layer';

const source: VectorSourceSpecification & { id: string } = {
  id: 'model-source',
  type: 'vector',
  tiles: [TILE_URL],
};

const layer: ModelLayerSpecification = {
  id: 'building-3d',
  type: 'model',
  source: 'model-source',
  'source-layer': SOURCE_LAYER,
  minzoom: 16,
  maxzoom: 21,
  layout: {
    'model-id': ['get', 'model_url'],
    visibility: 'visible',
  },
  paint: {
    'model-scale': ['get', 'scale'],
    'model-rotation': ['vector3', ['get', 'roll'], ['get', 'pitch'], ['get', 'bearing']],
    'model-translation': ['vector3', 0, 0, 0],
  },
};

const Layers = () => {
  return (
    <React.Fragment>
      <Source {...source}>
        <Layer {...layer} />
      </Source>
    </React.Fragment>
  );
};

export default React.memo(Layers);

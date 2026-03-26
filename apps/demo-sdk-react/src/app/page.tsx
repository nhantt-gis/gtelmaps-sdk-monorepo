'use client';
import React from 'react';
import { Map, NavigationControl } from '@gis/gtelmaps-sdk-react';
// import Layers from './layers';
import '@gis/gtelmaps-sdk-js/dist/gtelmaps-sdk.css';

export default function App() {
  return (
    <div style={{ width: '100vw', height: '100vh' }}>
      <Map
        initialViewState={{
          longitude: 105.8042435,
          latitude: 20.9966552,
          zoom: 18,
        }}
        mapStyle='gtelmaps-streets-v1'
        gtelmapsApiKey='NkJ7pLZ3rA5tXvW2cE0KdQ9oIi4CVY8Ox'
        space={true}
        halo={true}
        hash={true}
      >
        <NavigationControl position='top-left' />
        {/* <Layers /> */}
      </Map>
    </div>
  );
}

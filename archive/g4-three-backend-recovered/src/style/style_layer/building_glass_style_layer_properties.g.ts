// This file is generated. Edit build/generate-style-code.ts, then run 'npm run codegen'.
/* eslint-disable */

import {latest as styleSpec} from '@maplibre/maplibre-gl-style-spec';

import {
    Properties,
    DataConstantProperty,
    DataDrivenProperty,
    CrossFadedDataDrivenProperty,
    CrossFadedProperty,
    ColorRampProperty,
    PossiblyEvaluatedPropertyValue,
    CrossFaded
} from '../properties';

import type {Color, Formatted, Padding, NumberArray, ColorArray, ResolvedImage, VariableAnchorOffsetCollection} from '@maplibre/maplibre-gl-style-spec';
import {StylePropertySpecification} from '@maplibre/maplibre-gl-style-spec';


export type BuildingGlassPaintProps = {
    "building-glass-height": DataDrivenProperty<number>,
    "building-glass-base": DataDrivenProperty<number>,
    "building-glass-color": DataDrivenProperty<Color>,
    "building-glass-opacity": DataConstantProperty<number>,
    "building-glass-translate": DataConstantProperty<[number, number]>,
    "building-glass-translate-anchor": DataConstantProperty<"map" | "viewport">,
    "building-glass-fresnel-power": DataConstantProperty<number>,
    "building-glass-fresnel-intensity": DataConstantProperty<number>,
    "building-glass-ambient": DataConstantProperty<number>,
    "building-glass-rim-gain": DataConstantProperty<number>,
    "building-glass-xray": DataConstantProperty<boolean>,
    "building-glass-edge-color": DataConstantProperty<Color>,
    "building-glass-edge-opacity": DataConstantProperty<number>,
    "building-glass-edge-width": DataConstantProperty<number>,
};

export type BuildingGlassPaintPropsPossiblyEvaluated = {
    "building-glass-height": PossiblyEvaluatedPropertyValue<number>,
    "building-glass-base": PossiblyEvaluatedPropertyValue<number>,
    "building-glass-color": PossiblyEvaluatedPropertyValue<Color>,
    "building-glass-opacity": number,
    "building-glass-translate": [number, number],
    "building-glass-translate-anchor": "map" | "viewport",
    "building-glass-fresnel-power": number,
    "building-glass-fresnel-intensity": number,
    "building-glass-ambient": number,
    "building-glass-rim-gain": number,
    "building-glass-xray": boolean,
    "building-glass-edge-color": Color,
    "building-glass-edge-opacity": number,
    "building-glass-edge-width": number,
};

let paint: Properties<BuildingGlassPaintProps>;
const getPaint = () => paint = paint || new Properties({
    "building-glass-height": new DataDrivenProperty(styleSpec["paint_building-glass"]["building-glass-height"] as any as StylePropertySpecification),
    "building-glass-base": new DataDrivenProperty(styleSpec["paint_building-glass"]["building-glass-base"] as any as StylePropertySpecification),
    "building-glass-color": new DataDrivenProperty(styleSpec["paint_building-glass"]["building-glass-color"] as any as StylePropertySpecification),
    "building-glass-opacity": new DataConstantProperty(styleSpec["paint_building-glass"]["building-glass-opacity"] as any as StylePropertySpecification),
    "building-glass-translate": new DataConstantProperty(styleSpec["paint_building-glass"]["building-glass-translate"] as any as StylePropertySpecification),
    "building-glass-translate-anchor": new DataConstantProperty(styleSpec["paint_building-glass"]["building-glass-translate-anchor"] as any as StylePropertySpecification),
    "building-glass-fresnel-power": new DataConstantProperty(styleSpec["paint_building-glass"]["building-glass-fresnel-power"] as any as StylePropertySpecification),
    "building-glass-fresnel-intensity": new DataConstantProperty(styleSpec["paint_building-glass"]["building-glass-fresnel-intensity"] as any as StylePropertySpecification),
    "building-glass-ambient": new DataConstantProperty(styleSpec["paint_building-glass"]["building-glass-ambient"] as any as StylePropertySpecification),
    "building-glass-rim-gain": new DataConstantProperty(styleSpec["paint_building-glass"]["building-glass-rim-gain"] as any as StylePropertySpecification),
    "building-glass-xray": new DataConstantProperty(styleSpec["paint_building-glass"]["building-glass-xray"] as any as StylePropertySpecification),
    "building-glass-edge-color": new DataConstantProperty(styleSpec["paint_building-glass"]["building-glass-edge-color"] as any as StylePropertySpecification),
    "building-glass-edge-opacity": new DataConstantProperty(styleSpec["paint_building-glass"]["building-glass-edge-opacity"] as any as StylePropertySpecification),
    "building-glass-edge-width": new DataConstantProperty(styleSpec["paint_building-glass"]["building-glass-edge-width"] as any as StylePropertySpecification),
});

export default ({ get paint() { return getPaint() } });
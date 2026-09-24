// src/utils/tankVolume.js
//
// Tank geometry helpers. Farmers enter dimensions in feet & inches (the
// unit tank sizes are usually quoted in here); everything is STORED in the
// database as centimeters, so the math stays unit-safe no matter what unit
// a future screen collects in.
//
// V1 can already show total CAPACITY (liters when full) from geometry
// alone, no sensor needed. The CURRENT level in liters needs a continuous
// distance reading (V2, VL53L ToF sensor) - a binary IR sensor only
// reports present/absent, so there is no way to derive a volume from it in
// code; that's a hardware limit, not a software one.

export const TANK_SHAPES = {
  rectangular: { label: 'Rectangular / sump', dims: ['length', 'breadth', 'height'] },
  cylindrical: { label: 'Cylindrical (round)', dims: ['diameter', 'height'] },
};

export const feetInchesToCm = (feet, inches) => {
  const ft = Number(feet) || 0;
  const inch = Number(inches) || 0;
  return (ft * 12 + inch) * 2.54;
};

export const cmToFeetInches = (cm) => {
  const totalInches = (Number(cm) || 0) / 2.54;
  const feet = Math.floor(totalInches / 12 + 1e-9);
  const inches = Math.round(totalInches - feet * 12);
  return inches === 12 ? { feet: feet + 1, inches: 0 } : { feet, inches };
};

const CM3_TO_L = 1 / 1000; // 1 litre = 1000 cm^3

// device: an iot_devices row (or the subset of tank_* fields from it).
export function tankCapacityLiters(device) {
  const { tank_shape, tank_height_cm, tank_length_cm, tank_breadth_cm, tank_diameter_cm } = device || {};
  const h = Number(tank_height_cm);
  if (!h || h <= 0) return null;

  if (tank_shape === 'rectangular') {
    const l = Number(tank_length_cm);
    const b = Number(tank_breadth_cm);
    if (!l || !b) return null;
    return l * b * h * CM3_TO_L;
  }
  if (tank_shape === 'cylindrical') {
    const d = Number(tank_diameter_cm);
    if (!d) return null;
    const r = d / 2;
    return Math.PI * r * r * h * CM3_TO_L;
  }
  return null;
}

export function formatLiters(liters) {
  if (liters === null || liters === undefined || !Number.isFinite(liters)) return null;
  return `${Math.round(liters).toLocaleString('en-IN')} L`;
}
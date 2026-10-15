export function tmForward(latitude: number, longitude: number): { x: number; y: number };
export function tmInverse(x: number, y: number): { latitude: number; longitude: number };
export function makeFrame(lon0: number, lat0: number): { fromLonLat: (lon: number, lat: number, h: number) => [number, number, number]; fromTm: (x: number, y: number, h: number) => [number, number, number] };

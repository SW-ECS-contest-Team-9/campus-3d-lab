// 좌표 변환(앱과 내보내기 공용): EPSG:5186 ↔ 경위도(tracker frontend/src/tm.ts 와 같은 식), 경위도·높이 → 캠퍼스 원점 동·북·위(m).
// 3D 자료의 좌표계: glTF 관례(Y 위)로 x = 동, y = 위(해발 m 그대로), z = −북.
const DEG = Math.PI / 180;
const A = 6378137;
const F = 1 / 298.257222101;
const LAT0 = 38;
const LON0 = 127;
const E2 = F * (2 - F);

function meridianArc(phi) {
  const e4 = E2 * E2, e6 = e4 * E2;
  return A * ((1 - E2 / 4 - (3 * e4) / 64 - (5 * e6) / 256) * phi
    - ((3 * E2) / 8 + (3 * e4) / 32 + (45 * e6) / 1024) * Math.sin(2 * phi)
    + ((15 * e4) / 256 + (45 * e6) / 1024) * Math.sin(4 * phi)
    - ((35 * e6) / 3072) * Math.sin(6 * phi));
}
const M0 = meridianArc(LAT0 * DEG);

export function tmForward(latitude, longitude) {
  const ep2 = E2 / (1 - E2);
  const phi = latitude * DEG, sin = Math.sin(phi), cos = Math.cos(phi), tan = Math.tan(phi);
  const N = A / Math.sqrt(1 - E2 * sin * sin), T = tan * tan, C = ep2 * cos * cos, a = (longitude - LON0) * DEG * cos;
  const x = N * (a + ((1 - T + C) * a ** 3) / 6 + ((5 - 18 * T + T * T + 72 * C - 58 * ep2) * a ** 5) / 120);
  const y = meridianArc(phi) - M0 + N * tan * (a * a / 2 + ((5 - T + 9 * C + 4 * C * C) * a ** 4) / 24 + ((61 - 58 * T + T * T + 600 * C - 330 * ep2) * a ** 6) / 720);
  return { x: 200000 + x, y: 600000 + y };
}

export function tmInverse(x, y) {
  const ep2 = E2 / (1 - E2);
  const M = M0 + y - 600000;
  const mu = M / (A * (1 - E2 / 4 - (3 * E2 * E2) / 64 - (5 * E2 ** 3) / 256));
  const e1 = (1 - Math.sqrt(1 - E2)) / (1 + Math.sqrt(1 - E2));
  const phi1 = mu + ((3 * e1) / 2 - (27 * e1 ** 3) / 32) * Math.sin(2 * mu) + ((21 * e1 * e1) / 16 - (55 * e1 ** 4) / 32) * Math.sin(4 * mu)
    + ((151 * e1 ** 3) / 96) * Math.sin(6 * mu) + ((1097 * e1 ** 4) / 512) * Math.sin(8 * mu);
  const sin = Math.sin(phi1), cos = Math.cos(phi1), tan = Math.tan(phi1);
  const C1 = ep2 * cos * cos, T1 = tan * tan, N1 = A / Math.sqrt(1 - E2 * sin * sin), R1 = (A * (1 - E2)) / (1 - E2 * sin * sin) ** 1.5;
  const D = (x - 200000) / N1;
  const latitude = phi1 - ((N1 * tan) / R1) * (D * D / 2 - ((5 + 3 * T1 + 10 * C1 - 4 * C1 * C1 - 9 * ep2) * D ** 4) / 24
    + ((61 + 90 * T1 + 298 * C1 + 45 * T1 * T1 - 252 * ep2 - 3 * C1 * C1) * D ** 6) / 720);
  const lonOff = (D - ((1 + 2 * T1 + C1) * D ** 3) / 6 + ((5 - 2 * C1 + 28 * T1 - 3 * C1 * C1 + 8 * ep2 + 24 * T1 * T1) * D ** 5) / 120) / cos;
  return { latitude: latitude / DEG, longitude: LON0 + lonOff / DEG };
}

// WGS84 타원체(Cesium 과 같음)
const WA = 6378137, WF = 1 / 298.257223563, WE2 = WF * (2 - WF);
function ecef(lon, lat, h) {
  const l = lon * DEG, p = lat * DEG, s = Math.sin(p), c = Math.cos(p);
  const N = WA / Math.sqrt(1 - WE2 * s * s);
  return [(N + h) * c * Math.cos(l), (N + h) * c * Math.sin(l), (N * (1 - WE2) + h) * s];
}

/** 원점(경위도) 기준 변환기: lonLatH → [x(동), y(위), z(−북)] */
export function makeFrame(lon0, lat0) {
  const o = ecef(lon0, lat0, 0);
  const l = lon0 * DEG, p = lat0 * DEG;
  const east = [-Math.sin(l), Math.cos(l), 0];
  const north = [-Math.sin(p) * Math.cos(l), -Math.sin(p) * Math.sin(l), Math.cos(p)];
  const up = [Math.cos(p) * Math.cos(l), Math.cos(p) * Math.sin(l), Math.sin(p)];
  const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
  const fromLonLat = (lon, lat, h) => { const q = ecef(lon, lat, h); const d = [q[0] - o[0], q[1] - o[1], q[2] - o[2]]; return [dot(d, east), dot(d, up), -dot(d, north)]; };
  const fromTm = (x, y, h) => { const g = tmInverse(x, y); return fromLonLat(g.longitude, g.latitude, h); };
  return { fromLonLat, fromTm };
}

// 걷는 시간 어림(1.2 m/s).
export const WALK_MPS = 1.2;
export const minutes = (m: number) => Math.max(1, Math.round(m / WALK_MPS / 60));
/** 초 → 분(최소 1) */
export const minutesOf = (s: number) => Math.max(1, Math.round(s / 60));

// 3D 지도 기기 등급. 3D 페이지 ready 사건의 gpu(WebGL 렌더러 이름)로 고름(client3d-android.patch 가 보냄).
// tier 1 = 전체 3D(Galaxy S21 급 이상), tier 2 = 가벼운 3D(S10·S20·A5x 급), tier 3 = 평면 지도(WebGL2 없음·연속 실패).
export type Tier = 1 | 2 | 3;

/** S21(Mali-G78 / Adreno 660) 이상: Mali-G78·G710 이후·Immortalis, Xclipse(S22+ Exynos), Adreno 66x·7xx·8xx */
const TIER1 = /Mali-G(78|7[1-9]0|6[2-9]5|9\d\d)|Immortalis|Xclipse|Adreno \(TM\) (6[6-9]\d|[7-9]\d\d)/i;

export function gpuTier(gpu: string | null | undefined, failures = 0): Tier {
  if (failures >= 2) return 3;
  if (!gpu) return 2;
  if (/SwiftShader|llvmpipe|Software/i.test(gpu)) return 2;
  return TIER1.test(gpu) ? 1 : 2;
}

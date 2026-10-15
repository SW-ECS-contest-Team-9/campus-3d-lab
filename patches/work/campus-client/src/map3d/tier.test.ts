import { describe, expect, it } from 'vitest';
import { gpuTier } from './tier';

describe('gpuTier', () => {
  it('S21 급 이상은 1', () => {
    for (const g of ['Mali-G78', 'Adreno (TM) 660', 'Samsung Xclipse 920', 'Adreno (TM) 740', 'Immortalis-G715', 'Mali-G710']) expect(gpuTier(g)).toBe(1);
  });
  it('S10·S20·A5x 급은 2', () => {
    for (const g of ['Mali-G76', 'Mali-G77', 'Adreno (TM) 640', 'Adreno (TM) 650', 'Mali-G68', 'Adreno (TM) 618', 'Android Emulator OpenGL ES Translator (Google SwiftShader)', '']) expect(gpuTier(g)).toBe(2);
  });
  it('연속 두 번 실패하면 3(평면)', () => expect(gpuTier('Mali-G78', 2)).toBe(3));
});

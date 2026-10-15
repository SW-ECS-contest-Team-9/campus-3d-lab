// PC 미리보기 빌드: three 는 앱(native/node_modules) 것을 그대로 씀.
import path from 'node:path';
const three = path.resolve(import.meta.dirname, '../native/node_modules/three');
export default {
  root: 'preview', base: './',
  build: { outDir: '../out/preview', emptyOutDir: true, target: 'es2022' },
  resolve: { alias: [{ find: /^three$/, replacement: three + '/build/three.module.js' }, { find: /^three\/(.*)$/, replacement: three + '/$1' }] },
};

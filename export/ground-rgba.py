# 바닥 그림(out/ground.png) → out/ground.rgba + 크기(json). build-glb.mjs 가 정점 색으로 씀.
import json
from PIL import Image
im = Image.open('out/ground.png').convert('RGBA')
open('out/ground.rgba', 'wb').write(im.tobytes())
json.dump({'w': im.width, 'h': im.height}, open('out/ground.rgba.json', 'w'))
print(im.size)

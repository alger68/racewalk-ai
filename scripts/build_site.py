"""Vendor a pinned SDK and real pose model into the Pages artifact, not Git history."""
from pathlib import Path
import base64,hashlib,io,json,tarfile,time,urllib.request,urllib.error
ROOT=Path(__file__).resolve().parents[1]
SITE=ROOT/'site'
VERSION='0.10.21'
def get(url):
    for attempt in range(3):
        try:
            with urllib.request.urlopen(urllib.request.Request(url,headers={'User-Agent':'RaceWalkLab-CI/3.0.2'}),timeout=90) as response:return response.read()
        except (urllib.error.URLError,TimeoutError):
            if attempt==2:raise
            time.sleep(attempt+1)
old={}
for name,url in {'old_sdk':'https://cdn.jsdelivr.net/npm/@mediapipe/tasks-vision@0.10.22/+esm','old_registry_version':'https://registry.npmjs.org/@mediapipe/tasks-vision/0.10.22'}.items():
    try:
        with urllib.request.urlopen(url,timeout=20) as response:old[name]={'status':response.status,'body_prefix':response.read(120).decode(errors='replace')}
    except urllib.error.HTTPError as e:old[name]={'status':e.code,'body_prefix':e.read(150).decode(errors='replace')}
    except Exception as e:old[name]={'error':str(e)}
print('ORIGINAL_DEPENDENCY_CHECK',json.dumps(old,ensure_ascii=False),flush=True)
metadata=json.loads(get(f'https://registry.npmjs.org/@mediapipe/tasks-vision/{VERSION}'))
archive=get(metadata['dist']['tarball'])
algorithm,expected=metadata['dist']['integrity'].split('-',1)
assert base64.b64encode(hashlib.new(algorithm,archive).digest()).decode()==expected,'SDK integrity mismatch'
vendor=SITE/'vendor/mediapipe';vendor.mkdir(parents=True,exist_ok=True)
with tarfile.open(fileobj=io.BytesIO(archive),mode='r:gz') as tar:
    for item in tar.getmembers():
        path=Path(item.name)
        if not item.isfile() or path.parts[0]!='package' or '..' in path.parts:continue
        rel=Path(*path.parts[1:])
        if str(rel)=='vision_bundle.mjs' or str(rel).startswith('wasm/') or rel.name in ('LICENSE','LICENSE.txt','NOTICE'):
            dest=vendor/rel;dest.parent.mkdir(parents=True,exist_ok=True);dest.write_bytes(tar.extractfile(item).read())
for name in ['vision_bundle.mjs','wasm/vision_wasm_internal.js','wasm/vision_wasm_internal.wasm','wasm/vision_wasm_nosimd_internal.js','wasm/vision_wasm_nosimd_internal.wasm']:assert (vendor/name).is_file(),f'Missing SDK resource: {name}'
if not (vendor/'LICENSE').exists():(vendor/'LICENSE').write_bytes(get('https://www.apache.org/licenses/LICENSE-2.0.txt'))
model_url='https://storage.googleapis.com/mediapipe-models/pose_landmarker/pose_landmarker_full/float16/1/pose_landmarker_full.task'
model=SITE/'models/pose_landmarker_full.task';model.parent.mkdir(exist_ok=True);model.write_bytes(get(model_url));assert model.stat().st_size>1_000_000
manifest={'app':'3.0.2','sdk_version':VERSION,'sdk_integrity':metadata['dist']['integrity'],'model_source':model_url,'files':{}}
for file in sorted([*vendor.rglob('*'),model]):
    if file.is_file():manifest['files'][str(file.relative_to(SITE))]={'bytes':file.stat().st_size,'sha256':hashlib.sha256(file.read_bytes()).hexdigest()}
(SITE/'asset-manifest.json').write_text(json.dumps(manifest,indent=2)+'\n')
(SITE/'THIRD_PARTY_NOTICES.txt').write_text(f'MediaPipe Tasks Vision {VERSION}\nSource: https://github.com/google-ai-edge/mediapipe\nSDK license: Apache-2.0 (vendor/mediapipe/LICENSE)\nPose model: {model_url}\nOriginal input videos are not included in this distribution.\n')
artifacts=ROOT/'test-results';artifacts.mkdir(exist_ok=True);(artifacts/'dependency-check.json').write_text(json.dumps(old,indent=2)+'\n')
print('VENDORED_ASSETS',json.dumps(manifest,indent=2),flush=True)

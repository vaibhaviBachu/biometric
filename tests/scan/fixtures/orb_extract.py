"""Extract production-format ORB descriptor sets for a list of image files, using the project's own service.
usage: python orb_extract.py <python-ai dir> <out.json> <image> [<image> ...]
"""
import json
import sys

root, out_path, *paths = sys.argv[1:]
sys.path.insert(0, root)
from services.computer_vision import computer_vision_service  # noqa: E402

result = {}
for p in paths:
    with open(p, 'rb') as f:
        data = f.read()
    r = computer_vision_service.extract_local_index(data)
    result[p] = r.data.get('orbDescriptors') if r.success else None
with open(out_path, 'w') as f:
    json.dump(result, f)
print('ok', len(paths))

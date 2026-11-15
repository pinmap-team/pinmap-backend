"""Bounded Linux OCR for carousel images and video frames.

Returns the same row shape as the macOS Vision reader in place_server.py.
The collector and AI stages can therefore use source files and frame times
without depending on the host operating system.
"""

import csv
import io
import shutil
import subprocess
import time


def _sample(images, limit):
    if len(images) <= limit:
        return images
    if limit == 1:
        return [images[0]]
    indices = {round(i * (len(images) - 1) / (limit - 1)) for i in range(limit)}
    return [images[index] for index in sorted(indices)]


def _number(value, fallback=0.0):
    try:
        return float(value)
    except (TypeError, ValueError):
        return fallback


def parse_tsv(tsv, image):
    """Group Tesseract word boxes into OCR lines with normalized coordinates."""
    page_width = page_height = 0.0
    lines = {}
    for item in csv.DictReader(io.StringIO(tsv), delimiter='\t'):
        level = item.get('level')
        if level == '1':
            page_width = _number(item.get('width'))
            page_height = _number(item.get('height'))
            continue
        if level != '5':
            continue
        word = ' '.join((item.get('text') or '').split())
        if not word:
            continue
        confidence = _number(item.get('conf'), -1)
        if confidence < 0:
            continue
        key = tuple(item.get(part, '') for part in ('page_num', 'block_num', 'par_num', 'line_num'))
        line = lines.setdefault(key, {'words': [], 'boxes': [], 'confidence': []})
        line['words'].append(word)
        line['confidence'].append(confidence / 100)
        line['boxes'].append((_number(item.get('left')), _number(item.get('top')),
                              _number(item.get('width')), _number(item.get('height'))))
    detections = []
    for line in lines.values():
        left = min(box[0] for box in line['boxes'])
        top = min(box[1] for box in line['boxes'])
        right = max(box[0] + box[2] for box in line['boxes'])
        bottom = max(box[1] + box[3] for box in line['boxes'])
        detection = {'text': ' '.join(line['words']),
                     'confidence': round(sum(line['confidence']) / len(line['confidence']), 3)}
        if page_width > 0 and page_height > 0:
            detection['box'] = [round(left / page_width, 4), round(top / page_height, 4),
                                round((right - left) / page_width, 4),
                                round((bottom - top) / page_height, 4)]
        detections.append(detection)
    return {'source_file': image['source_file'], 'time_seconds': image.get('time_seconds'),
            'lines': [item['text'] for item in detections], 'detections': detections}


def read_tesseract_images(images, *, executable=None, runner=None, clock=None,
                          max_images=60, total_seconds=90):
    """Read a representative, bounded set of images; never run indefinitely."""
    if not images:
        return [], []
    executable = executable or shutil.which('tesseract')
    if not executable:
        return [], ['Tesseract OCR을 사용할 수 없습니다.']
    runner = runner or subprocess.run
    clock = clock or time.monotonic
    selected = _sample(images, max_images)
    notes = []
    if len(selected) < len(images):
        notes.append(f'문자 인식은 {len(images)}장 중 {len(selected)}장을 균등하게 확인했습니다.')
    deadline = clock() + total_seconds
    rows = []
    failed = 0
    for image in selected:
        remaining = deadline - clock()
        if remaining <= 0:
            notes.append('문자 인식 시간 제한으로 일부 이미지를 건너뛰었습니다.')
            break
        try:
            result = runner([executable, image['path'], 'stdout', '-l', 'kor+eng',
                             '--psm', '11', 'tsv'], capture_output=True, text=True,
                            timeout=min(8, remaining))
            if result.returncode:
                failed += 1
                continue
            row = parse_tsv(result.stdout, image)
            if row['detections']:
                rows.append(row)
        except (OSError, subprocess.TimeoutExpired, ValueError):
            failed += 1
    if failed:
        notes.append(f'이미지 {failed}장의 문자 인식에 실패했습니다.')
    return rows, notes

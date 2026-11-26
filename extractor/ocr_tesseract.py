"""Bounded Linux OCR for carousel images and video frames.

Returns the same row shape as the macOS Vision reader in place_server.py.
The collector and AI stages can therefore use source files and frame times
without depending on the host operating system.
"""

import csv
from concurrent.futures import ThreadPoolExecutor
import io
import math
import os
from pathlib import Path
import shutil
import subprocess
import tempfile
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


def parse_tsv(tsv, image, page_num=None):
    """Group Tesseract word boxes into OCR lines with normalized coordinates."""
    page_width = page_height = 0.0
    lines = {}
    for item in csv.DictReader(io.StringIO(tsv), delimiter='\t'):
        if page_num is not None and item.get('page_num') != str(page_num):
            continue
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


def _cpu_worker_budget():
    """Respect the container CPU quota, not the host's reported core count."""
    try:
        quota, period = Path('/sys/fs/cgroup/cpu.max').read_text().split()[:2]
        if quota != 'max':
            return max(1, math.ceil(int(quota) / int(period)))
    except (OSError, ValueError, ZeroDivisionError):
        pass
    return max(1, os.cpu_count() or 1)


def read_tesseract_images(images, *, executable=None, runner=None, clock=None,
                          max_images=60, total_seconds=90, batch_size=None, max_workers=None):
    """Read a representative, bounded set of images; never run indefinitely."""
    if not images:
        return [], []
    executable = executable or shutil.which('tesseract')
    if not executable:
        return [], ['Tesseract OCR을 사용할 수 없습니다.']
    # Tesseract accepts a file containing image paths. Share language-model
    # startup across a small batch without increasing CPU use on 1-vCPU Run.
    if batch_size is None:
        try:
            batch_size = int(os.getenv('PINMAP_OCR_BATCH_SIZE', '8')) if runner is None and clock is None else 1
        except ValueError:
            batch_size = 8
    batch_size = max(1, min(12, batch_size))
    if max_workers is None:
        try:
            max_workers = int(os.getenv('PINMAP_OCR_WORKERS', ''))
        except ValueError:
            max_workers = 1 if runner is not None or clock is not None else min(2, _cpu_worker_budget())
    max_workers = max(1, min(4, max_workers))
    runner = runner or subprocess.run
    clock = clock or time.monotonic
    selected = _sample(images, max_images)
    notes = []
    if len(selected) < len(images):
        notes.append(f'문자 인식은 {len(images)}장 중 {len(selected)}장을 균등하게 확인했습니다.')
    deadline = clock() + total_seconds
    def read_one(image):
        remaining = deadline - clock()
        if remaining <= 0:
            return None, False, True
        try:
            result = runner([executable, image['path'], 'stdout', '-l', 'kor+eng',
                             '--psm', '11', 'tsv'], capture_output=True, text=True,
                            timeout=min(8, remaining))
            if result.returncode:
                return None, True, False
            row = parse_tsv(result.stdout, image)
            return (row if row['detections'] else None), False, False
        except (OSError, subprocess.TimeoutExpired, ValueError):
            return None, True, False
    def read_batch(batch):
        if len(batch) > 1 and deadline - clock() <= 0:
            return [], 0, True
        batched = None
        if len(batch) > 1 and all('\n' not in image['path'] and '\r' not in image['path'] for image in batch):
            with tempfile.TemporaryDirectory(prefix='pinmap-ocr-') as temp:
                listing = Path(temp) / 'images.txt'
                listing.write_text(''.join(image['path'] + '\n' for image in batch), encoding='utf-8')
                try:
                    result = runner([executable, str(listing), 'stdout', '-l', 'kor+eng',
                                     '--psm', '11', 'tsv'], capture_output=True, text=True,
                                    timeout=min(8 * len(batch), max(0.001, deadline - clock())))
                    if result.returncode == 0:
                        pages = {int(item['page_num']) for item in csv.DictReader(io.StringIO(result.stdout), delimiter='\t')
                                 if item.get('level') == '1' and str(item.get('page_num', '')).isdigit()}
                        if pages == set(range(1, len(batch) + 1)):
                            batched = [parse_tsv(result.stdout, image, index)
                                       for index, image in enumerate(batch, 1)]
                except (OSError, subprocess.TimeoutExpired, ValueError):
                    pass
        if batched is not None:
            return [row for row in batched if row['detections']], 0, False
        # An incomplete batch must never silently drop a slide or frame.
        rows, failed = [], 0
        for image in batch:
            row, error, expired = read_one(image)
            if row:
                rows.append(row)
            failed += int(error)
            if expired:
                return rows, failed, True
        return rows, failed, False
    chunks = [selected[start:start + batch_size] for start in range(0, len(selected), batch_size)]
    if max_workers > 1 and len(chunks) > 1:
        with ThreadPoolExecutor(max_workers=max_workers) as pool:
            results = list(pool.map(read_batch, chunks))
    else:
        results = []
        for chunk in chunks:
            outcome = read_batch(chunk)
            results.append(outcome)
            if outcome[2]:
                break
    rows, failed = [], 0
    for batch_rows, batch_failed, expired in results:
        rows.extend(batch_rows)
        failed += batch_failed
        if expired and not any('시간 제한' in note for note in notes):
            notes.append('문자 인식 시간 제한으로 일부 이미지를 건너뛰었습니다.')
    if failed:
        notes.append(f'이미지 {failed}장의 문자 인식에 실패했습니다.')
    return rows, notes

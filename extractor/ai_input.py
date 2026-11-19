"""Keep source evidence while bounding the text sent to a model."""

import re


EVIDENCE_CUE = re.compile(
    r'20\d{2}[.\-/년]|\d{1,2}[.\-/월]\d{1,2}|주소|장소|위치|일정|전시|팝업|행사|'
    r'카페|맛집|주점|바\b|venue|address|location|exhibition|pop.?up|festival',
    re.IGNORECASE)


def compact_text(value, limit):
    text = value.strip() if isinstance(value, str) else ''
    if len(text) <= limit:
        return text
    marker = '\n[중략]\n'
    priority_budget = limit // 4
    snippets = []
    used = 0
    for match in EVIDENCE_CUE.finditer(text):
        if match.start() < limit // 3 or match.end() > len(text) - limit // 3:
            continue
        snippet = text[max(0, match.start() - 45):min(len(text), match.end() + 70)].strip()
        if snippet and snippet not in snippets and used + len(snippet) + 1 <= priority_budget:
            snippets.append(snippet)
            used += len(snippet) + 1
    middle = '\n'.join(snippets)
    remaining = limit - len(middle) - 2 * len(marker)
    head = remaining // 2
    tail = remaining - head
    return text[:head] + marker + middle + marker + text[-tail:]


def compact_analysis_input(caption, rows, transcripts, places, events, need_places, need_events):
    selected_rows = rows[:100]
    row_budget = min(1000, max(180, 24000 // max(1, len(selected_rows))))
    ocr = []
    for row in selected_rows:
        lines = row.get('lines', [])
        text = compact_text('\n'.join(line for line in lines if isinstance(line, str)), row_budget)
        ocr.append({'file': row.get('source_file'), 'time_seconds': row.get('time_seconds'),
                    'lines': text.splitlines()})
    transcript_budget = min(500, max(100, 8000 // max(1, len(transcripts[:80]))))
    audio = [{'file': item.get('source_file'), 'time_seconds': item.get('time_seconds'),
              'text': compact_text(item.get('text'), transcript_budget)}
             for item in transcripts[:80]]
    known_places = [{'name': place.get('name'), 'address': place.get('address'),
                     'evidence': ((place.get('evidence') or {}).get('quote') or '')[:120]}
                    for place in places[:40]]
    known_events = [{'title': event.get('title'), 'date_text': event.get('date_text'),
                     'venue_name': event.get('venue_name'),
                     'evidence': ((event.get('evidence') or {}).get('quote') or '')[:120]}
                    for event in events[:40]]
    return {'need_places': need_places, 'need_events': need_events,
            'caption': compact_text(caption, 8000), 'ocr': ocr, 'transcripts': audio,
            'known_places': known_places, 'known_events': known_events}

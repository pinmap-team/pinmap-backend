"""Conservative evidence coverage for skipping media analysis, without another AI call."""
import re

MEDIA_REFERENCE = re.compile(
    r'(?:사진|이미지|영상|슬라이드|카드|다음\s*장).{0,24}(?:확인|참고|참조|일정|목록|주소|장소)|'
    r'(?:일정|목록|주소|장소).{0,16}(?:사진|이미지|영상|슬라이드|다음\s*장)|'
    r'나머지|일부만|전체\s*목록은|더\s*많은\s*(?:곳|장소)', re.I)
DECLARATION = re.compile(r'^\s*(?:📍\s*|(?:장소|위치|상호|venue|location)\s*[:：])\s*(.+)$', re.I)
ITEM = re.compile(r'^\s*(?:\d{1,2}[.)](?!\d)|\d{1,2}\ufe0f?\u20e3|🔟|[①-⑳])\s*')


def normalized(value):
    return re.sub(r'[^a-z0-9가-힣]', '', (value or '').casefold())


def caption_coverage(caption, places, events, want_places, want_events, has_event_signals):
    """Return (sufficient, reason). Never infer missing names, years, dates or locations."""
    if not caption.strip():
        return False, 'empty_caption'
    if MEDIA_REFERENCE.search(caption):
        return False, 'media_reference'
    named_places = [p for p in places if p.get('name') and p.get('address')]
    if any(not p.get('name') or not p.get('address') for p in places):
        return False, 'incomplete_place'
    for place in named_places:
        name = re.sub(r'^(?:장소|상호|위치)\s*[:：]\s*', '', place['name']).strip()
        if len(name) < 2 or re.search(r'확인|참고|주소|모음|리스트|추천합니다|소개합니다', name):
            return False, 'uncertain_place_name'
    if want_events and has_event_signals:
        if not events:
            return False, 'missing_event'
        for event in events:
            single_day = bool(re.search(r'당일|하루|일시\s*[:：]|one.day', event.get('date_text') or '', re.I))
            if (not event.get('title') or not event.get('start_date') or
                    not (event.get('end_date') or single_day) or
                    not (event.get('venue_name') or event.get('address'))):
                return False, 'incomplete_event'
    elif want_places and not named_places:
        return False, 'missing_place'
    if not named_places and not events:
        return False, 'no_extracted_evidence'
    # More declared/numbered items than parsed items means the caption is not covered.
    available = max(len(named_places), len(events))
    numbered = sum(bool(ITEM.match(line)) for line in caption.splitlines())
    indices = []
    for line in caption.splitlines():
        if ITEM.match(line):
            match = re.match(r'^\s*(\d{1,2})', line)
            if match:
                indices.append(int(match[1]))
            elif line.strip().startswith('🔟'):
                indices.append(10)
            elif line.strip() and '①' <= line.strip()[0] <= '⑳':
                indices.append(ord(line.strip()[0]) - ord('①') + 1)
    if indices and indices != list(range(1, len(indices) + 1)):
        return False, 'incomplete_numbering'
    counts = [int(n) for n in re.findall(r'(?<!\d)(\d{1,2})\s*(?:곳|군데)', caption)]
    counts += [int(n) for n in re.findall(r'TOP\s*(\d{1,2})', caption, re.I)]
    if numbered > available or (counts and max(counts) > available):
        return False, 'incomplete_list'
    targets = [normalized(p.get(k)) for p in named_places for k in ('name', 'address')]
    targets += [normalized(e.get(k)) for e in events for k in ('venue_name', 'address')]
    for line in caption.splitlines():
        match = DECLARATION.match(line)
        if match:
            value = normalized(match[1])
            if not value or not any(t and (t in value or value in t) for t in targets):
                return False, 'uncovered_venue'
    return True, 'complete_caption'

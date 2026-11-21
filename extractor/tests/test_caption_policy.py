import os
from pathlib import Path
import sys
import tempfile
import unittest
from unittest.mock import patch
sys.path.insert(0,str(Path(__file__).resolve().parents[1]))
from place_server import caption_analysis_policy,extract_one,extract_link

PLACE='1. 카페 모래\n서울특별시 마포구 양화로 18\n커피와 빵을 소개합니다.'
EVENT='겨울 전시\n기간: 2026.11.20 ~ 2026.12.10\n장소: 파도 미술관'
ROUNDUP='전시 2곳 추천\n1. 색의 기억\n2026.11.20 ~ 2026.12.10\n장소: 파도미술관\n2. 빛의 정원\n2026.12.01 ~ 2026.12.20\n장소: 별미술관'
class CaptionPolicyTests(unittest.TestCase):
    def test_complete_place_and_event_roundup(self):
        for text,types in ((PLACE,('place',)),(PLACE,('place','event')),(EVENT,('event',)),(ROUNDUP,('place','event'))):
            self.assertEqual(caption_analysis_policy(text,types),(True,'complete_caption'))
    def test_empty_missing_year_dates_or_location_requires_media(self):
        for text in ('','겨울 전시\n장소: 미술관','겨울 전시\n11.20 ~ 12.10\n장소: 미술관',
                     '겨울 전시\n2026.11.20 ~ 2026.12.10',
                     '겨울 전시\n2026.12.20 ~ 2026.11.20\n장소: 미술관'):
            self.assertFalse(caption_analysis_policy(text,('place','event'))[0])
    def test_photo_reference_or_partial_list_keeps_ocr(self):
        for text in (PLACE+'\n나머지는 영상에서 확인',PLACE+'\n일정은 사진 참고',
                     PLACE.replace('1.','추천 3곳\n1.'),ROUNDUP+'\n장소: 추가미술관',
                     PLACE+'\n2. 이름만 있는 카페'):
            self.assertFalse(caption_analysis_policy(text,('place','event'))[0])
    def test_flag_can_restore_legacy_processing(self):
        with patch.dict(os.environ,{'PINMAP_CAPTION_FAST_PATH':'0'}):
            self.assertEqual(caption_analysis_policy(ROUNDUP,('event',)),(False,'disabled'))
    def test_complete_event_skips_prepare_ocr_audio_and_retains_dates(self):
        context={}
        with patch('place_server.media_files',return_value=[Path('video.mp4')]), \
             patch('place_server.prepare_images') as prepare,patch('place_server.ocr_images') as ocr, \
             patch('place_server.transcribe_videos') as audio, \
             patch('place_server.complete_ai_analysis',return_value=('전시','전시 소개')), \
             patch('place_server.classify_content',return_value={'source':'rules'}):
            result=extract_one({'post_id':'ig_Test123','source_url':'https://www.instagram.com/p/Test123/','caption':ROUNDUP},content_types=('event',),analysis_context=context)
        prepare.assert_not_called();ocr.assert_not_called();audio.assert_not_called()
        self.assertEqual(len(result['events']),2)
        self.assertEqual(result['events'][0]['start_date'],'2026-11-20')
        self.assertEqual(context['counts']['ocr_images'],0)
        self.assertEqual(context['ocr_rows'],[])
        self.assertFalse(any('미디어 분석을 완료하지' in note for note in result['notes']))
    def test_incomplete_event_keeps_ocr(self):
        with patch('place_server.media_files',return_value=[]), \
             patch('place_server.prepare_images',return_value=([],[])) as prepare, \
             patch('place_server.ocr_images',return_value=([],[])) as ocr, \
             patch('place_server.transcribe_videos',return_value=([],[])), \
             patch('place_server.complete_ai_analysis',return_value=('전시','소개')), \
             patch('place_server.classify_content',return_value={'source':'rules'}):
            extract_one({'post_id':'ig_Test123','source_url':'https://www.instagram.com/p/Test123/','caption':'겨울 전시\n장소: 미술관'},content_types=('event',))
        prepare.assert_called_once();ocr.assert_called_once()
    def test_link_fast_path_never_collects_full_media_or_runs_image_matching(self):
        def collect(url,mode,root,profile):
            self.assertEqual(mode,'caption')
            (root/'ig_Test123').mkdir(parents=True)
            return {'status':'collected','post_id':'ig_Test123','source_url':url,'caption':ROUNDUP,'notes':[]}
        with patch('place_server.collect_link',side_effect=collect) as collector, \
             patch('place_server.complete_ai_analysis',return_value=('전시','소개')), \
             patch('place_server.classify_content',return_value={'source':'rules'}), \
             patch('place_server.attach_location_images') as photos:
            result=extract_link('https://www.instagram.com/p/Test123/',content_types=['event'])['results'][0]
        self.assertEqual(collector.call_count,1);photos.assert_not_called()
        self.assertEqual(result['analysis_metrics']['counts']['media_skipped_due_caption'],1)
        self.assertEqual(result['analysis_metrics']['timings']['ocr'],0)
    def test_complete_place_caption_still_collects_carousel_for_covers(self):
        calls=[]
        def collect(url,mode,root,profile):
            calls.append(mode)
            folder=root/'ig_Test123';folder.mkdir(parents=True,exist_ok=True)
            if mode=='media':(folder/'link-slide-01.jpg').write_bytes(b'carousel')
            return {'status':'collected','post_id':'ig_Test123','source_url':url,'caption':PLACE,'notes':[]}
        def locate(places,caption):
            for place in places:place['coordinates']={'lat':37.5,'lng':126.9}
            return []
        with patch('place_server.collect_link',side_effect=collect), \
             patch('place_server.resolve_missing_addresses',side_effect=locate), \
             patch('place_server.complete_ai_analysis',return_value=('카페 모래','소개')), \
             patch('place_server.classify_content',return_value={'source':'rules'}), \
             patch('place_server.attach_location_images') as photos:
            result=extract_link('https://www.instagram.com/p/Test123/',content_types=['place'])['results'][0]
        self.assertEqual(calls,['caption','media'])
        photos.assert_called_once()
        self.assertEqual(photos.call_args.kwargs['ocr_rows'],[])
        self.assertEqual(len(result['map_locations']),1)
    def test_ignore_caption_cannot_enable_fast_path(self):
        with patch('place_server.media_files',return_value=[]), \
             patch('place_server.prepare_images',return_value=([],[])), \
             patch('place_server.ocr_images',return_value=([],[])) as ocr, \
             patch('place_server.transcribe_videos',return_value=([],[])), \
             patch('place_server.complete_ai_analysis',return_value=('','')), \
             patch('place_server.classify_content',return_value={'source':'rules'}):
            context={};extract_one({'post_id':'ig_Test123','source_url':'https://www.instagram.com/p/Test123/','caption':ROUNDUP},ignore_caption=True,content_types=('event',),analysis_context=context)
        ocr.assert_called_once();self.assertEqual(context['counts']['caption_fast_path'],0)
if __name__=='__main__':unittest.main()

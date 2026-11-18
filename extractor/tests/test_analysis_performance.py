import json
import os
from pathlib import Path
import tempfile
import threading
import time
from types import SimpleNamespace
import unittest
from unittest.mock import patch

from content_ai import analyze_content
from place_server import (prepare_images, attach_location_images, complete_ai_analysis,
                          resolve_missing_addresses)

SETTINGS = {'MULTIUSER_AI_PROVIDER': 'gemini', 'MULTIUSER_MODEL': 'gemini-2.5-flash', 'GEMINI_API_KEY': 'test-key'}


class AnalysisPerformanceTests(unittest.TestCase):
    def test_duplicate_cover_is_removed_but_video_timestamps_are_retained(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp)
            for name in ['link-cover.jpg', 'link-slide-01.jpg', 'video-frame-000100ms.jpg', 'video-frame-000200ms.jpg']:
                (root / name).write_bytes(b'same picture')
            images, _ = prepare_images(sorted(root.iterdir()), root)
            self.assertEqual([i['source_file'] for i in images], ['link-slide-01.jpg', 'video-frame-000100ms.jpg', 'video-frame-000200ms.jpg'])
            self.assertEqual([i['time_seconds'] for i in images[1:]], [0.1, 0.2])

    def test_location_photo_reuses_ocr_without_another_tesseract_call(self):
        with tempfile.TemporaryDirectory() as temp:
            root = Path(temp);(root / 'link-slide-01.jpg').write_bytes(b'jpeg')
            result = {'map_locations': [{'name': '테스트카페'}]}
            def runner(command, **kwargs):
                self.assertNotEqual(command[0], 'tesseract')
                Path(command[-1]).write_bytes(b'thumbnail')
                return SimpleNamespace(returncode=0)
            with patch('place_server.ffmpeg_bin', return_value='ffmpeg'), \
                 patch('place_server.shutil.which', return_value='tesseract'), \
                 patch('place_server.subprocess.run', side_effect=runner), \
                 patch('place_server.ai_match_location_images') as ai:
                attach_location_images(result, root, ocr_rows=[{'source_file': 'link-slide-01.jpg', 'lines': ['테스트카페'], 'time_seconds': None}])
            ai.assert_not_called()
            self.assertTrue(result['map_locations'][0]['image_data_url'].startswith('data:image/jpeg;'))

    def test_empty_completed_ocr_is_not_repeated(self):
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp);(root/'link-slide-01.jpg').write_bytes(b'image')
            with patch('place_server.ffmpeg_bin', return_value='ffmpeg'), \
                 patch('place_server.shutil.which', return_value='tesseract'), \
                 patch('place_server.subprocess.run') as runner, \
                 patch('place_server.ai_match_location_images', return_value={}):
                attach_location_images({'map_locations':[{'name':'카페'}]},root,ocr_rows=[])
            runner.assert_not_called()

    def test_one_model_request_returns_places_events_and_summary(self):
        caption='겨울 전시\n2026.11.15 ~ 2026.12.20\n장소: 문화관'
        bundle={'title':'겨울 전시 2곳','summary':'문화관의 겨울 전시를 소개해요. 작품을 감상할 수 있어요.',
                'places':[{'name':'문화관','address':'','source':'caption','evidence':'문화관','evidence_file':'','time_seconds':None,'uncertain':True}],
                'events':[{'title':'겨울 전시','event_type':'exhibition','date_text':'2026.11.15 ~ 2026.12.20','time_text':None,'venue_name':'문화관','address':None,'source':'caption','evidence':'겨울 전시','evidence_file':'','start_date':'2026-11-15','end_date':'2026-12-20'}]}
        output={'candidates':[{'finishReason':'STOP','content':{'parts':[{'text':json.dumps(bundle)}]}}]}
        places,events,notes,context=[],[],[],{}
        with patch('place_server.ai_settings',return_value=SETTINGS), \
             patch('place_server.request_json_with_retry',return_value=output) as request, \
             patch('place_server.ai_extract') as legacy, patch('place_server.ai_post_summary') as summary:
            title,text=complete_ai_analysis(caption,[],[],[],[],places,events,True,True,notes,context)
        self.assertEqual(request.call_count,1);legacy.assert_not_called();summary.assert_not_called()
        self.assertEqual(places[0]['name'],'문화관');self.assertEqual(events[0]['start_date'],'2026-11-15')
        self.assertEqual(title,'겨울 전시');self.assertTrue(text);self.assertEqual(context['ai_strategy'],'unified')
        config=json.loads(request.call_args.args[0].data)['generationConfig']
        self.assertEqual(config['thinkingConfig']['thinkingBudget'],0)

    def test_failed_unified_response_preserves_legacy_analysis(self):
        places,events,notes=[],[],[]
        with patch('place_server.analyze_content',return_value=(None,'fallback')), \
             patch('place_server.ai_extract',return_value=([{'name':'카페','address':None}],None)) as legacy, \
             patch('place_server.ai_post_summary',return_value=('카페','설명',None)):
            title,_=complete_ai_analysis('카페',[],[],[],[],places,events,True,False,notes,{})
        self.assertEqual(title,'카페');self.assertEqual(places[0]['name'],'카페');legacy.assert_called_once()

    def test_summary_only_request_does_not_attach_images_or_reextract_complete_events(self):
        seen=[]
        def requester(request):
            seen.append(json.loads(request.data))
            return {'candidates':[{'finishReason':'STOP','content':{'parts':[{'text':json.dumps({'places':[],'events':[],'title':'전시','summary':'설명'})}]}}]}
        with tempfile.TemporaryDirectory()as temp:
            p=Path(temp)/'image.jpg';p.write_bytes(b'image')
            parsed,error=analyze_content('전시',[],[{'path':p,'source_file':p.name}],[],[],[],False,False,SETTINGS,requester)
        self.assertIsNone(error);self.assertTrue(parsed)
        self.assertEqual(len(seen[0]['contents'][0]['parts']),1)

    def test_complete_event_roundup_does_not_create_a_redundant_venue_pipeline(self):
        events=[{'title':'행사'+str(i),'start_date':'2026-11-19','venue_name':'미술관'}for i in range(2)]
        places,notes,context=[],[],{}
        with patch('place_server.ai_settings',return_value=SETTINGS), \
             patch('place_server.ai_post_summary',return_value=('전시','소개',None))as summary, \
             patch('place_server.analyze_content')as unified:
            complete_ai_analysis('전시',[],[],[],[],places,events,True,True,notes,context)
        unified.assert_not_called();summary.assert_called_once()
        self.assertEqual(len(events),2);self.assertEqual(places,[])
        self.assertEqual(context['counts']['complete_event_roundup'],1)
        self.assertEqual(context['ai_strategy'],'summary_only')
        self.assertEqual(context['counts']['ai_pipeline_calls'],1)

    def test_photo_carousel_does_not_skip_the_thirteenth_slide(self):
        calls=[]
        with tempfile.TemporaryDirectory() as temp:
            images=[]
            for i in range(13):
                p=Path(temp)/('slide-%02d.jpg'%i);p.write_bytes(b'image')
                images.append({'path':p,'source_file':p.name,'time_seconds':None})
            def request(req):
                calls.append(json.loads(req.data))
                return {'candidates':[{'finishReason':'STOP','content':{'parts':[{'text':json.dumps({'places':[],'events':[],'title':'카페','summary':'소개'})}]}}]}
            analyze_content('카페',[],images,[],[],[],True,False,SETTINGS,request)
        parts=calls[0]['contents'][0]['parts']
        self.assertEqual(sum('inline_data' in p for p in parts),13)
        self.assertIn('파일: slide-06.jpg',[p.get('text')for p in parts])

    def test_truncated_model_response_falls_back_instead_of_returning_partial_data(self):
        parsed,error=analyze_content('전시',[],[],[],[],[],True,True,SETTINGS,lambda _: {'candidates':[{'finishReason':'MAX_TOKENS'}]})
        self.assertIsNone(parsed);self.assertTrue(error)

    def test_parallel_search_is_bounded_deduplicated_and_keeps_input_order(self):
        lock=threading.Lock();active=0;peak=0;calls=[]
        def lookup(name, **kwargs):
            nonlocal active,peak
            with lock:active+=1;peak=max(peak,active);calls.append(name)
            time.sleep(.03)
            with lock:active-=1
            if name=='failure':raise OSError('provider error')
            return {'status':'not_found','provider':'google_places','candidates':[]}
        places=[{'name':name,'address':None}for name in ['one','two','three','one','failure','four']]
        with patch('place_server.lookup_place_address',side_effect=lookup):
            notes=resolve_missing_addresses(places,max_workers=3)
        self.assertGreater(peak,1);self.assertLessEqual(peak,3);self.assertEqual(calls.count('one'),1)
        self.assertEqual([p['name']for p in places],['one','two','three','one','failure','four'])
        self.assertEqual(places[4]['map_lookup']['status'],'lookup_failed');self.assertTrue(notes)


if __name__=='__main__':unittest.main()

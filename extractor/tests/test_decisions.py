import sys
from pathlib import Path
import unittest
from unittest.mock import patch
sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
import decisions
from place_server import resolve_missing_addresses, lookup_place_address
SETTINGS={'PINMAP_DECISIONS_ENABLED':'1','GEMINI_API_KEY':'test'}
def answer(value,confidence=.95): return {'type':'choice','choice':value,'confidence':confidence}
class DecisionsTests(unittest.TestCase):
    def test_disabled_and_empty_skip_provider(self):
        with patch('decisions.call') as call:
            self.assertEqual(decisions.classify('카페',{})['source'],'rules')
            self.assertEqual(decisions.classify('',SETTINGS)['status'],'no_evidence')
            self.assertEqual(decisions.verify_maps([{'id':'venue_0','candidates':[]}],SETTINGS),{})
        call.assert_not_called()
    def test_classification_validation_and_failure(self):
        with patch('decisions.call',return_value={'kind':answer('place'),'category':answer('food')}):
            self.assertEqual(decisions.classify('칵테일 바',SETTINGS)['category'],'food')
        with patch('decisions.call',return_value={'kind':answer('unknown'),'category':answer('recipe')}):
            self.assertEqual(decisions.classify('바질 파스타 조리법',SETTINGS)['category'],'recipe')
        for response in ({'kind':answer('fake'),'category':answer('food')},
                         {'kind':answer('place'),'category':answer('food',.2)},
                         {'kind':answer('place'),'category':answer('food',float('nan'))}):
            with patch('decisions.call',return_value=response):
                self.assertEqual(decisions.classify('주점',SETTINGS)['source'],'rules')
        with patch('decisions.call',side_effect=TimeoutError):
            self.assertEqual(decisions.classify('주점',SETTINGS)['status'],'unavailable')
    def test_batch_validates_ids_and_abstention(self):
        tasks=[{'id':'venue_'+str(i),'name':'모래','context':'합정 카페',
                'candidates':[{'name':'모래','address':'서울 마포구'}]} for i in range(3)]
        with patch('decisions.call',return_value={'venue_0':answer('p0'),'venue_1':answer('reject'),
                                                'venue_2':answer('p99')}) as call:
            result=decisions.verify_maps(tasks,SETTINGS)
        call.assert_called_once()
        self.assertEqual(result['venue_0']['index'],0)
        self.assertEqual(result['venue_1']['status'],'rejected')
        self.assertEqual(result['venue_2']['status'],'uncertain')
        with patch('decisions.call',side_effect=TimeoutError):
            self.assertEqual(decisions.verify_maps(tasks,SETTINGS)['venue_0']['status'],'unavailable')
    def resolve(self,places,lookup,response):
        with patch('place_server.ai_settings',return_value=SETTINGS), \
             patch('place_server.lookup_place_address',return_value=lookup), \
             patch('decisions.call',return_value=response) as call, \
             patch('place_server.geocode_address',return_value=None):
            resolve_missing_addresses(places,max_workers=1)
        return call
    def test_exact_single_match_does_not_call_ai(self):
        candidate={'name':'모래','address':'서울 마포구 합정동 1','type':'cafe','coordinates':{'lat':37.55,'lng':126.91}}
        places=[{'name':'모래','area_hint':'합정','search_keyword':'카페'}]
        call=self.resolve(places,{'status':'matched','provider':'google_places','candidates':[candidate]}, {})
        call.assert_not_called()
        self.assertEqual(places[0]['coordinates'],candidate['coordinates'])
    def test_alias_uses_only_provider_coordinates(self):
        candidate={'name':'SCARF','address':'서울 성동구 성수동 1','type':'cocktail_bar','coordinates':{'lat':37.54,'lng':127.05}}
        places=[{'name':'스카프','area_hint':'성수','search_keyword':'칵테일 바'}]
        call=self.resolve(places,{'status':'ambiguous','provider':'google_places','candidates':[],
                                 'verification_candidates':[candidate]}, {'venue_0':answer('p0')})
        call.assert_called_once()
        self.assertEqual(places[0]['coordinates'],candidate['coordinates'])
        self.assertEqual(places[0]['map_selection'],'decision_reviewed')
        self.assertTrue(places[0]['needs_review'])
    def test_reject_and_low_confidence_never_publish_pin(self):
        candidate={'name':'모래','address':'서울 마포구 1','coordinates':{'lat':37.55,'lng':126.91}}
        for response in (answer('reject'),answer('p0',.2),answer('p9')):
            places=[{'name':'모래','area_hint':'합정'}]
            self.resolve(places,{'status':'ambiguous','provider':'google_places','candidates':[candidate]}, {'venue_0':response})
            self.assertNotIn('coordinates',places[0])
            self.assertIsNone(places[0].get('address'))
    def test_outage_uses_original_rules(self):
        candidate={'name':'모래','address':'서울 마포구 1','coordinates':{'lat':37.55,'lng':126.91}}
        places=[{'name':'모래','area_hint':'합정'}]
        with patch('place_server.ai_settings',return_value=SETTINGS), \
             patch('place_server.lookup_place_address',return_value={'status':'matched','provider':'google_places','candidates':[candidate]}), \
             patch('decisions.call',side_effect=TimeoutError):
            resolve_missing_addresses(places,max_workers=1)
        self.assertIn('coordinates',places[0])
        self.assertEqual(places[0]['map_validation']['status'],'unavailable')
    def test_explicit_address_conflict_not_overridden(self):
        candidate={'name':'모래','address':'서울 종로구 종로 1','coordinates':{'lat':37.58,'lng':126.98}}
        places=[{'name':'모래','area_hint':'종로','address':'서울 마포구 양화로 1'}]
        self.resolve(places,{'status':'matched','provider':'google_places','candidates':[candidate]}, {'venue_0':answer('p0')})
        self.assertNotIn('coordinates',places[0])
        self.assertEqual(places[0]['address'],'서울 마포구 양화로 1')
    def test_map_provider_alias_is_retained_for_verification(self):
        import io,json
        raw={'places':[{'displayName':{'text':'SCARF'},'formattedAddress':'서울 성동구 성수동 1',
                        'primaryType':'cocktail_bar','location':{'latitude':37.54,'longitude':127.05}}]}
        result=lookup_place_address('스카프',{**SETTINGS,'GOOGLE_MAPS_API_KEY':'test'},
            lambda *args,**kwargs: io.StringIO(json.dumps(raw)),area_hint='성수',search_keyword='칵테일 바')
        self.assertEqual(result['candidates'],[])
        self.assertEqual(result['verification_candidates'][0]['name'],'SCARF')
        self.assertEqual(result['status'],'ambiguous')
if __name__=='__main__': unittest.main()


class CategoryCatalogTests(unittest.TestCase):
    def test_all_24_categories_are_supported(self):
        self.assertEqual(len(decisions.CATEGORIES), 24)
        for category, label in decisions.LABELS.items():
            with patch('decisions.call', return_value={'kind':answer('unknown'),'category':answer(category)}):
                result=decisions.classify('게시물의 핵심 내용', SETTINGS)
                self.assertEqual(result['category'], category)
                self.assertEqual(result['label'], label)

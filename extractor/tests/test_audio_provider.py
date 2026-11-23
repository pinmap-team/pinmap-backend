import io
import json
from pathlib import Path
import tempfile
import unittest
from types import SimpleNamespace
from unittest.mock import patch

from place_server import transcribe_videos


class AudioProviderTests(unittest.TestCase):
    def test_openai_transcribes_video_without_inventing_timestamps(self):
        with tempfile.TemporaryDirectory() as temp:
            video = Path(temp) / 'post.mp4'
            video.write_bytes(b'video')

            def convert(command, **_):
                self.assertIn('48k', command)
                Path(command[-1]).write_bytes(b'mp3-audio')
                return SimpleNamespace(returncode=0)

            response = io.BytesIO(json.dumps({'text': '서울숲에 가요.'}).encode())
            with patch('place_server.ai_settings', return_value={
                'MULTIUSER_AI_PROVIDER': 'openai', 'OPENAI_API_KEY': 'test-key'}), \
                 patch('place_server.ffmpeg_bin', return_value='ffmpeg'), \
                 patch('place_server.subprocess.run', side_effect=convert), \
                 patch('place_server.urllib.request.urlopen', return_value=response) as request:
                transcripts, notes = transcribe_videos([video], Path(temp))
            self.assertEqual(notes, [])
            self.assertEqual(transcripts, [{'source_file': 'post.mp4', 'time_seconds': None,
                                            'end_seconds': None, 'text': '서울숲에 가요.'}])
            sent = request.call_args.args[0]
            self.assertEqual(sent.full_url, 'https://api.openai.com/v1/audio/transcriptions')
            self.assertIn(b'gpt-transcribe', sent.data)
            self.assertIn(b'mp3-audio', sent.data)

    def test_gemini_keeps_local_whisper(self):
        with tempfile.TemporaryDirectory() as temp:
            video = Path(temp) / 'post.mp4'
            video.write_bytes(b'video')
            model = Path(temp) / 'model.bin'
            model.write_bytes(b'model')

            def run(command, **_):
                if command[0] == 'ffmpeg':
                    Path(command[-1]).write_bytes(b'wav')
                else:
                    output = Path(command[command.index('-of') + 1] + '.json')
                    output.write_text(json.dumps({'transcription': [
                        {'offsets': {'from': 1000, 'to': 2000}, 'text': '서울숲'}]}))
                return SimpleNamespace(returncode=0)

            with patch('place_server.ai_settings', return_value={'MULTIUSER_AI_PROVIDER': 'gemini'}), \
                 patch('place_server.ffmpeg_bin', return_value='ffmpeg'), \
                 patch('place_server.shutil.which', return_value='whisper-cli'), \
                 patch('place_server.os.getenv', return_value=str(model)), \
                 patch('place_server.subprocess.run', side_effect=run), \
                 patch('place_server.urllib.request.urlopen') as request:
                transcripts, notes = transcribe_videos([video], Path(temp))
            self.assertEqual(notes, [])
            self.assertEqual(transcripts[0]['text'], '서울숲')
            self.assertEqual(transcripts[0]['time_seconds'], 1)
            request.assert_not_called()


if __name__ == '__main__':
    unittest.main()

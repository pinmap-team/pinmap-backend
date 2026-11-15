import unittest
from types import SimpleNamespace

from ocr_tesseract import parse_tsv, read_tesseract_images


TSV = ("level\tpage_num\tblock_num\tpar_num\tline_num\tword_num\tleft\ttop\twidth\theight\tconf\ttext\n"
       "1\t1\t0\t0\t0\t0\t0\t0\t1000\t500\t-1\t\n"
       "5\t1\t1\t1\t1\t1\t100\t50\t100\t30\t90\t11월\n"
       "5\t1\t1\t1\t1\t2\t210\t50\t100\t30\t80\t15일까지\n"
       "5\t1\t1\t1\t2\t1\t100\t150\t100\t30\t95\t팝업\n")


class TesseractOcrTests(unittest.TestCase):
    def test_tsv_preserves_lines_frame_time_and_normalized_boxes(self):
        image = {'path': '/tmp/frame.jpg', 'source_file': 'video-frame-001000ms.jpg',
                 'time_seconds': 1.0}
        row = parse_tsv(TSV, image)
        self.assertEqual(row['lines'], ['11월 15일까지', '팝업'])
        self.assertEqual(row['time_seconds'], 1.0)
        self.assertEqual(row['detections'][0]['box'], [0.1, 0.1, 0.21, 0.06])

    def test_ocr_samples_long_reels_and_stops_at_time_budget(self):
        images = [{'path': f'/tmp/{i}.jpg', 'source_file': f'{i}.jpg',
                   'time_seconds': i} for i in range(120)]
        called = []
        def runner(command, **kwargs):
            called.append(command[1])
            return SimpleNamespace(returncode=0, stdout=TSV)
        ticks = iter([0, 0, 5, 95])
        rows, notes = read_tesseract_images(images, executable='tesseract', runner=runner,
                                            clock=lambda: next(ticks), max_images=3,
                                            total_seconds=90)
        self.assertEqual(called, ['/tmp/0.jpg', '/tmp/60.jpg'])
        self.assertEqual(len(rows), 2)
        self.assertTrue(any('시간 제한' in note for note in notes))
        self.assertTrue(any('120장 중 3장' in note for note in notes))


if __name__ == '__main__':
    unittest.main()

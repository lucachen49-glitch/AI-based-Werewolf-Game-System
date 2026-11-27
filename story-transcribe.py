"""Local English transcript for generated shots. No credentials or remote speech API."""
import json
import os
import sys
from faster_whisper import WhisperModel

project_dir = os.path.dirname(os.path.abspath(__file__))
legacy_model_dir = os.path.join(project_dir, 'output', 'speech-models')
local_app_data = os.environ.get('LOCALAPPDATA', os.path.join(os.path.expanduser('~'), 'AppData', 'Local'))
default_model_dir = os.path.join(local_app_data, 'NightfallWerewolf', 'speech-models')
model_dir = os.environ.get('NIGHTFALL_SPEECH_MODELS') or default_model_dir
if not os.path.isdir(model_dir) and os.path.isdir(legacy_model_dir):
    model_dir = legacy_model_dir
model = WhisperModel('small.en', device='cpu', compute_type='int8', download_root=model_dir)
segments, info = model.transcribe(sys.argv[1], language='en', beam_size=5, vad_filter=True, word_timestamps=True)
print(json.dumps({'language': info.language, 'segments': [{'start': s.start, 'end': s.end, 'text': s.text.strip(), 'words': [{'start': w.start, 'end': w.end, 'word': w.word} for w in (s.words or [])]} for s in segments]}, ensure_ascii=True))

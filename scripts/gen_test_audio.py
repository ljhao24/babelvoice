"""Generate a realistic English meeting clip with Gemini TTS for listen-mode tests.

Two colleagues, two voices, one multi-speaker call. Play the result in
QuickTime (or any player) and point 收听来源 at that app to exercise the
listen pipeline with natural speech instead of the macOS `say` voice.

Run with audio-studio's interpreter, which owns the Gemini key and helpers:
    ~/developer/audio-studio/.venv/bin/python -I scripts/gen_test_audio.py [--force]

Writes test-audio/<NAME>.wav (Gemini's 24 kHz output), <NAME>.m4a and
<NAME>.txt (the transcript, to check the subtitles against). An existing
WAV is reused unless --force, so re-runs don't spend another TTS call.
"""
import base64, pathlib, subprocess, sys

from studio import voice

ROOT = pathlib.Path(__file__).resolve().parent.parent
OUT = ROOT / 'test-audio'
NAME = 'en-weekly-sync'

SPEAKERS = {'Maya': 'Callirrhoe', 'Daniel': 'Zubenelgenubi'}   # easy-going female / casual male

DIRECTION = (
    '# AUDIO PROFILE: Two colleagues on a weekly team video call.\n'
    "### DIRECTOR'S NOTES\n"
    'Style: Natural, unscripted-sounding workplace conversation. Relaxed and a little '
    'informal, with small hesitations where written. Not an announcer or audiobook read.\n'
    'Pacing: Normal conversational speed, with short natural gaps between turns.\n'
    'Language: American English.\n'
    '#### TRANSCRIPT\n'
)

LINES = [
    ('Maya', "Okay, I think everyone's here. Let's get started. So, quick update on the mobile release first."),
    ('Daniel', "Sure. Um, we pushed the beta to about 300 testers on Monday. The crash rate is down to 0.4 percent, "
               "which is the lowest we've had so far."),
    ('Maya', 'Nice. And what about the login issue people were reporting last week?'),
    ('Daniel', "That one's fixed. It turned out the session token was expiring after 15 minutes instead of 24 hours. "
               'We shipped a patch on Tuesday night.'),
    ('Maya', 'Great. Then the main thing I want to decide today is whether we move the launch to November 12th, '
             'or keep the original date.'),
    ('Daniel', "Honestly, I'd keep the original date. The remaining bugs are minor, and marketing has already "
               'booked the press briefing.'),
    ('Maya', 'Okay, let\'s keep it. But I want a go or no-go check next Thursday. '
             'Can you send me the open bug list by Wednesday?'),
    ('Daniel', "Yep, I'll have it to you by end of day Wednesday."),
]


def main(force):
    wav, m4a, txt = (OUT / f'{NAME}{ext}' for ext in ('.wav', '.m4a', '.txt'))
    OUT.mkdir(exist_ok=True)
    if force or not wav.exists():
        wav.write_bytes(synthesize())
    # 24 kHz mono AAC tops out below 96 kbps; afconvert rejects higher rates.
    subprocess.run(['afconvert', '-f', 'm4af', '-d', 'aac', '-b', '64000', str(wav), str(m4a)], check=True)
    txt.write_text('\n'.join(f'{who}: {text}' for who, text in LINES) + '\n', encoding='utf-8')
    print(f'wrote {m4a} and {txt}')


def synthesize():
    speech = {'multiSpeakerVoiceConfig': {'speakerVoiceConfigs': [
        {'speaker': who, 'voiceConfig': {'prebuiltVoiceConfig': {'voiceName': v}}} for who, v in SPEAKERS.items()
    ]}}
    # Multi-speaker requests tag every text part with its speaker; the
    # director's notes ride on the first part.
    parts = [{'text': (DIRECTION if i == 0 else '') + text, 'speechMetadata': {'speaker': who}}
             for i, (who, text) in enumerate(LINES)]
    r = voice._post(voice.TTS_MODEL, {
        'contents': [{'parts': parts}],
        'generationConfig': {'responseModalities': ['AUDIO'], 'speechConfig': speech},
    })
    part = r['candidates'][0]['content']['parts'][0]['inlineData']
    return voice._to_wav(base64.b64decode(part['data']), part.get('mimeType'))


if __name__ == '__main__':
    main('--force' in sys.argv[1:])

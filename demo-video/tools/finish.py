# Turns Ultrademo's render into the deliverables in demo-video/output/:
#   final-demo.mp4  the render with a quiet music bed under the narration, ducked whenever the voice
#                   speaks, then loudness-normalised to -14 LUFS (two-pass EBU R128), H.264 + AAC
#   narration.wav   the narration alone, as rendered
#   captions.srt    the captions, as rendered
#   review.png      a contact sheet, one frame every few seconds
# and copies the source project (flow, storyboard) into demo-video/project/.
#
#   python3 demo-video/tools/finish.py <ultrademo workspace> <project>
# The music comes from tools/music.py (synthesised here, nothing licensed); PY_AUDIO is a Python with
# numpy and soundfile.
import json, os, re, shutil, subprocess, sys

ws, project = sys.argv[1], sys.argv[2]
HERE = os.path.dirname(os.path.abspath(__file__))
DEMO = os.path.dirname(HERE)
OUT = os.path.join(DEMO, 'output')
SRC = os.path.join(ws, 'projects', project)
render = os.path.join(SRC, 'out', f'{project}.mp4')
stems = os.path.join(SRC, 'out', 'stems')
os.makedirs(OUT, exist_ok=True)
tmp = os.path.join(OUT, '.work'); os.makedirs(tmp, exist_ok=True)

def run(args, capture=False):
    r = subprocess.run(args, check=True, capture_output=capture, text=True)
    return r.stderr if capture else None

def duration(path):
    return float(subprocess.run(['ffprobe', '-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', path], capture_output=True, text=True, check=True).stdout)

total = duration(render)
music = os.path.join(tmp, 'music.wav')
run([os.environ.get('PY_AUDIO', sys.executable), os.path.join(HERE, 'music.py'), f'{total + 1:.2f}', music])

# The bed sits well under the voice and dips further while it speaks; it fades in and out with the
# picture, which already fades from and to black.
bed = (f'[1:a]aformat=sample_rates=48000:channel_layouts=stereo,volume=0.16,afade=t=in:st=0:d=2.5,'
       f'afade=t=out:st={total - 3.5:.2f}:d=3.5[m];'
       '[0:a]aformat=sample_rates=48000:channel_layouts=stereo,asplit=2[v][key];'
       '[m][key]sidechaincompress=threshold=0.015:ratio=10:attack=15:release=450:makeup=1[duck];'
       '[v][duck]amix=inputs=2:duration=first:normalize=0[mix]')

# Pass one measures, pass two applies: a single pass of loudnorm pumps on speech.
log = run(['ffmpeg', '-hide_banner', '-y', '-i', render, '-i', music, '-filter_complex',
           bed + ';[mix]loudnorm=I=-14:TP=-1.5:LRA=11:print_format=json[out]', '-map', '[out]', '-f', 'null', '-'], capture=True)
m = json.loads(re.findall(r'\{[^{}]*"input_i"[^{}]*\}', log, re.S)[-1])
norm = (f"loudnorm=I=-14:TP=-1.5:LRA=11:measured_I={m['input_i']}:measured_TP={m['input_tp']}:"
        f"measured_LRA={m['input_lra']}:measured_thresh={m['input_thresh']}:offset={m['target_offset']}:linear=true")
final = os.path.join(OUT, 'final-demo.mp4')
run(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-y', '-i', render, '-i', music, '-filter_complex',
     bed + f';[mix]{norm},aresample=48000[out]', '-map', '0:v', '-map', '[out]',
     '-c:v', 'copy', '-c:a', 'aac', '-b:a', '192k', '-movflags', '+faststart', final])

# Narration and captions, straight from the render's stems.
run(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-y', '-i', os.path.join(stems, 'narration.mp3'), '-ar', '48000', os.path.join(OUT, 'narration.wav')])
shutil.copy(os.path.join(stems, 'captions.srt'), os.path.join(OUT, 'captions.srt'))

# Contact sheet: sixteen frames across the running time, four by four.
step = total / 16
run(['ffmpeg', '-hide_banner', '-loglevel', 'error', '-y', '-i', final, '-vf',
     f"fps=1/{step:.3f},scale=480:-1,drawtext=text='%{{pts\\:hms}}':x=10:y=10:fontsize=18:fontcolor=white:box=1:boxcolor=black@0.55:boxborderw=6,tile=4x4:padding=6:margin=6:color=white",
     '-frames:v', '1', os.path.join(OUT, 'review.png')])

# The source project travels with the video.
proj = os.path.join(DEMO, 'project'); os.makedirs(proj, exist_ok=True)
shutil.copy(os.path.join(SRC, 'flow.mjs'), os.path.join(proj, 'flow.mjs'))
shutil.copy(os.path.join(SRC, 'assets', 'storyboard.json'), os.path.join(proj, 'storyboard.json'))
shutil.rmtree(tmp)
print(f'final-demo.mp4  {duration(final):.2f}s')

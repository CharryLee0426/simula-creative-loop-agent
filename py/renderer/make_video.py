"""One localized variant end to end: job.json -> <out>.mp4 (H.264 + AAC, loudness-normalized, exact duration).

Replaces rk-pipeline's make_video.sh. Keyframes are generated upstream (TypeScript, cached per layer), so this
step is fully deterministic: audio synth and frame render run in parallel, then ffmpeg muxes and normalizes.

Usage: python make_video.py --job job.json [--workers N]
"""
import argparse, json, os, subprocess, sys

HERE = os.path.dirname(os.path.abspath(__file__))
# "none" is room tone only; normalizing it to -14 LUFS would turn hiss into noise.
LOUDNESS = {"none": -26}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--job", required=True)
    ap.add_argument("--workers", type=int, default=os.cpu_count() or 2)
    a = ap.parse_args()
    job = json.load(open(a.job, encoding="utf-8"))
    out = job["out"]
    work = os.path.dirname(os.path.abspath(out))
    os.makedirs(work, exist_ok=True)
    base = os.path.splitext(os.path.basename(out))[0]
    job["video_out"] = os.path.join(work, f".{base}.video.mp4")
    job["audio_out"] = os.path.join(work, f".{base}.music.wav")
    jp = os.path.join(work, f".{base}.job.json")
    json.dump(job, open(jp, "w", encoding="utf-8"), ensure_ascii=False, indent=1)
    py = sys.executable
    audio = subprocess.Popen([py, os.path.join(HERE, "audio.py"), "--job", jp])
    r = subprocess.run([py, os.path.join(HERE, "render.py"), "--job", jp, "--workers", str(a.workers)])
    if audio.wait() != 0 or r.returncode != 0:
        raise SystemExit("render or audio failed")
    dur = str(job["format"]["duration_s"])
    lufs = LOUDNESS.get(job.get("audio_preset"), -14)
    subprocess.run(["ffmpeg", "-y", "-v", "error", "-i", job["video_out"], "-i", job["audio_out"], "-map", "0:v", "-map", "1:a",
                    "-c:v", "copy", "-af", f"loudnorm=I={lufs}:TP=-1:LRA=11", "-c:a", "aac", "-b:a", "160k", "-ar", "44100",
                    "-t", dur, "-movflags", "+faststart", out], check=True)
    for p in (job["video_out"], job["audio_out"], jp):
        try:
            os.remove(p)
        except OSError:
            pass
    print("done:", out)


if __name__ == "__main__":
    main()

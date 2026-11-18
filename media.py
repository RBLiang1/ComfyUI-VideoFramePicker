"""共用的视频探测 / ffmpeg 定位工具（供节点与路由使用）。"""

import os
import shutil
import subprocess

_CACHE = {}
_VIDEO_EXT = {".mp4", ".mov", ".mkv", ".webm", ".avi", ".m4v", ".flv",
              ".wmv", ".mpg", ".mpeg", ".ts", ".m2ts", ".rmvb"}


def is_video(path: str) -> bool:
    return os.path.splitext(path)[1].lower() in _VIDEO_EXT


def resolve_ffmpeg():
    """优先用 imageio-ffmpeg 自带的 ffmpeg（便携版一定有），其次 PATH 里的。"""
    exe = None
    try:
        import imageio_ffmpeg
        exe = imageio_ffmpeg.get_ffmpeg_exe()
    except Exception:
        exe = None
    if exe and os.path.isfile(exe):
        return exe
    return shutil.which("ffmpeg")


def _probe_av(path):
    import av
    with av.open(path) as c:
        vs = c.streams.video[0]
        cc = vs.codec_context
        fps = 0.0
        for cand in (vs.average_rate, vs.guessed_rate, getattr(cc, "framerate", None)):
            try:
                v = float(cand)
                if v > 0:
                    fps = v
                    break
            except Exception:
                continue
        if fps <= 0:
            fps = 25.0
        dur = 0.0
        try:
            if vs.duration and vs.time_base:
                dur = float(vs.duration * vs.time_base)
        except Exception:
            dur = 0.0
        if dur <= 0 and c.duration:
            dur = float(c.duration) / 1_000_000.0
        frames = 0
        try:
            frames = int(vs.frames or 0)
        except Exception:
            frames = 0
        if frames <= 0 and dur > 0:
            frames = int(round(dur * fps))
        return {
            "fps": fps,
            "frames": frames,
            "duration": dur,
            "width": int(cc.width or 0),
            "height": int(cc.height or 0),
        }


def _probe_ffprobe(path):
    """没有 PyAV 时的后备：用 ffmpeg -i 的 stderr 里解析（不稳定，仅兜底）。"""
    ffmpeg = resolve_ffmpeg()
    if not ffmpeg:
        return None
    try:
        p = subprocess.run([ffmpeg, "-hide_banner", "-i", path],
                           stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=60)
        text = p.stderr.decode("utf-8", "ignore")
    except Exception:
        return None
    fps, w, h, dur = 25.0, 0, 0, 0.0
    import re
    m = re.search(r"(\d+(?:\.\d+)?) fps", text)
    if m:
        fps = float(m.group(1))
    m = re.search(r"Video:.*?(\d{2,5})x(\d{2,5})", text)
    if m:
        w, h = int(m.group(1)), int(m.group(2))
    m = re.search(r"Duration: (\d+):(\d+):(\d+(?:\.\d+)?)", text)
    if m:
        dur = int(m.group(1)) * 3600 + int(m.group(2)) * 60 + float(m.group(3))
    return {"fps": fps, "frames": int(round(dur * fps)), "duration": dur,
            "width": w, "height": h}


def probe_meta(path: str) -> dict:
    """读视频头信息（不解码画面）。按 路径+mtime+size 缓存，避免反复打 NAS。"""
    try:
        st = os.stat(path)
        key = (path, st.st_mtime, st.st_size)
    except Exception:
        key = (path, 0, 0)
    hit = _CACHE.get(key)
    if hit:
        return dict(hit)

    meta = None
    try:
        meta = _probe_av(path)
    except Exception as e:
        print("[视频抽帧] PyAV 读取元数据失败：%s" % e)
        meta = _probe_ffprobe(path)
    if not meta:
        meta = {"fps": 25.0, "frames": 0, "duration": 0.0, "width": 0, "height": 0}

    if len(_CACHE) > 200:  # 简单限容，防止长会话堆积
        _CACHE.clear()
    _CACHE[key] = meta
    return dict(meta)

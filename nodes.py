"""视频抽帧（路径·预览选帧）

按"路径"引用视频（支持本地绝对路径与 SMB / UNC，例如 \\\\NAS\\share\\a.mp4），
节点内嵌 <video> 预览 + 帧滑块，拖动即可看到画面并选定帧号；
执行时只解码选中的那一帧（ffmpeg 定位 seek），不把整段视频读进内存，
因此几个 GB 的素材也能秒级出帧、不占本地空间。

预览用的视频流由 /pathvframe/stream 提供（支持 HTTP Range，浏览器可随意拖动）。
"""

import io
import os
import subprocess

import numpy as np
import torch
from PIL import Image

from .media import probe_meta, resolve_ffmpeg


def _bad(msg: str) -> str:
    return msg


class PathVideoFrame:
    DESCRIPTION = (
        "视频抽帧（路径·预览选帧）：路径引用视频（支持 SMB/UNC），"
        "节点内预览可拖动滑块直接选帧，执行时只解码该帧。"
    )

    @classmethod
    def INPUT_TYPES(cls):
        return {
            "required": {
                "path": ("STRING", {
                    "default": "",
                    "multiline": False,
                    "tooltip": r"视频路径。支持本地绝对路径（D:\v\a.mp4）与 SMB/UNC（\\NAS\share\a.mp4）。"
                               r"点节点上的「选择视频…」可以直接浏览挑选。",
                }),
                "frame": ("INT", {
                    "default": 0, "min": 0, "max": 9999999, "step": 1,
                    "tooltip": "要抽取的帧号（从 0 开始）。也可以在节点预览里拖滑块、播放暂停或按步进跳帧来选。",
                }),
            },
        }

    RETURN_TYPES = ("IMAGE", "INT", "FLOAT", "INT", "INT")
    RETURN_NAMES = ("图像", "总帧数", "fps", "宽", "高")
    FUNCTION = "pick"
    CATEGORY = "video"

    def pick(self, path, frame=0):
        p = (path or "").strip().strip('"')
        if not p:
            raise ValueError("[视频抽帧] 还没有填视频路径：在 path 里粘贴本地绝对路径或 SMB 路径。")
        if not os.path.exists(p):
            raise ValueError("[视频抽帧] 路径不存在或无法访问：%s" % p)

        meta = probe_meta(p)
        fps = float(meta.get("fps") or 0.0) or 25.0
        total = int(meta.get("frames") or 0)
        idx = max(0, int(frame))
        if total > 0:
            idx = min(idx, total - 1)

        arr = grab_frame(p, fps, idx)
        image = torch.from_numpy(arr.astype(np.float32) / 255.0).unsqueeze(0)
        h, w = int(arr.shape[0]), int(arr.shape[1])
        print("[视频抽帧] %s → 帧 %d / %s @ %.3ffps %dx%d" % (
            os.path.basename(p), idx, total - 1 if total > 0 else "?", fps, w, h))
        return (image, total, fps, w, h)

    @classmethod
    def IS_CHANGED(cls, path="", frame=0, **kwargs):
        try:
            st = os.stat((path or "").strip().strip('"'))
            return "%s|%s|%s" % (int(st.st_mtime), st.st_size, int(frame))
        except Exception:
            return float("nan")

    @classmethod
    def VALIDATE_INPUTS(cls, path="", **kwargs):
        p = (path or "").strip().strip('"')
        if not p:
            return True  # 允许先建节点后填路径，执行时再报错
        if not os.path.exists(p):
            return "路径不存在或无法访问：%s" % p
        return True


def grab_frame(path, fps, idx):
    """用 ffmpeg 子进程定位到第 idx 帧并只解码这一帧（-ss 在 -i 前，关键帧后逐帧解到目标时间）。

    子进程方式隔离解码，不会像进程内 libav 解码那样把 ComfyUI 主进程卡死。
    """
    ffmpeg = resolve_ffmpeg()
    if ffmpeg and fps and fps > 0:
        t = max(0.0, float(idx) / float(fps))
        cmd = [
            ffmpeg, "-nostdin", "-loglevel", "error",
            "-ss", "%.6f" % t, "-i", path,
            "-frames:v", "1", "-an",
            "-pix_fmt", "rgb24", "-f", "image2pipe", "-c:v", "png", "-",
        ]
        try:
            proc = subprocess.run(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=180)
            if proc.returncode == 0 and proc.stdout:
                img = Image.open(io.BytesIO(proc.stdout)).convert("RGB")
                return np.asarray(img)
        except Exception as e:  # noqa
            print("[视频抽帧] ffmpeg 抓帧失败，回退 PyAV：%s" % e)

    # 回退：进程内 PyAV 逐帧读到目标帧（慢，但只在 ffmpeg 不可用时走到）
    import av
    with av.open(path) as container:
        stream = container.streams.video[0]
        stream.thread_type = "AUTO"
        for i, frame in enumerate(container.decode(stream)):
            if i >= idx:
                return frame.to_ndarray(format="rgb24")
    raise ValueError("[视频抽帧] 无法解码该视频的帧 %d" % idx)


NODE_CLASS_MAPPINGS = {"PathVideoFrame": PathVideoFrame}
NODE_DISPLAY_NAME_MAPPINGS = {"PathVideoFrame": "视频抽帧（路径·预览选帧）"}

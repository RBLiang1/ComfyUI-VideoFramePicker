"""HTTP 路由：给节点内的 <video> 预览提供视频流（支持 Range）与元数据，并提供目录浏览。

- GET /pathvframe/meta?p=<绝对路径或 UNC>   → {ok, fps, frames, duration, width, height}
- GET /pathvframe/stream?p=<...>             → 视频字节流，支持 Range（206），大文件可随意拖动
- GET /pathvframe/browse?dir=<目录或视频>     → 列目录（只列子目录 + 视频文件），给前端点选路径用

只允许"绝对路径 / UNC 且是视频后缀"，防止被当成任意文件读取接口；目录浏览也只返回
文件夹名与视频文件名，不返回其他类型文件。
"""

import asyncio
import os
import re

from aiohttp import web
from server import PromptServer

from .media import is_video, probe_meta

routes = PromptServer.instance.routes

_MIME = {
    ".mp4": "video/mp4", ".m4v": "video/mp4", ".mov": "video/quicktime",
    ".mkv": "video/x-matroska", ".webm": "video/webm", ".avi": "video/x-msvideo",
    ".flv": "video/x-flv", ".wmv": "video/x-ms-wmv", ".mpg": "video/mpeg",
    ".mpeg": "video/mpeg", ".ts": "video/mp2t", ".m2ts": "video/mp2t",
    ".rmvb": "application/vnd.rn-realmedia-vbr",
}

_CHUNK = 256 * 1024


def clean_path(raw):
    """规范化并校验路径：必须是绝对路径或 UNC，且是视频文件。"""
    p = (raw or "").strip().strip('"').strip("'")
    if not p:
        return None
    p = os.path.expandvars(os.path.expanduser(p))
    if not os.path.isabs(p):
        return None
    if not is_video(p):
        return None
    return os.path.normpath(p)


@routes.get("/pathvframe/meta")
async def pvf_meta(request):
    p = clean_path(request.query.get("p"))
    if not p:
        return web.json_response({"ok": False, "error": "路径无效：需要绝对路径或 UNC，且是视频文件"})

    loop = asyncio.get_event_loop()

    def _work():
        # 文件系统调用（尤其 SMB/UNC 不可达时）会阻塞几十秒，必须丢到线程里，
        # 否则整个 ComfyUI 的事件循环会被卡住、界面跟着假死。
        if not os.path.isfile(p):
            return None
        return probe_meta(p)

    try:
        meta = await loop.run_in_executor(None, _work)
    except Exception as e:  # noqa
        return web.json_response({"ok": False, "error": "读取视频信息失败：%s" % e})
    if meta is None:
        return web.json_response({"ok": False, "error": "文件不存在或无法访问：%s" % p})
    out = {"ok": True, "name": os.path.basename(p)}
    out.update(meta)
    return web.json_response(out)


@routes.get("/pathvframe/stream")
async def pvf_stream(request):
    p = clean_path(request.query.get("p"))
    loop = asyncio.get_event_loop()

    def _stat():
        if not p or not os.path.isfile(p):
            return 0
        try:
            return os.path.getsize(p)
        except OSError:
            return 0

    size = await loop.run_in_executor(None, _stat)
    if size <= 0:
        return web.Response(status=404, text="video not found")
    ctype = _MIME.get(os.path.splitext(p)[1].lower(), "application/octet-stream")

    start, end = 0, size - 1
    status = 200
    rng = request.headers.get("Range")
    if rng:
        m = re.match(r"bytes=(\d*)-(\d*)", rng.strip())
        if m and (m.group(1) or m.group(2)):
            try:
                if m.group(1):
                    start = int(m.group(1))
                    if m.group(2):
                        end = int(m.group(2))
                elif m.group(2):  # bytes=-N 取尾部 N 字节
                    start = max(0, size - int(m.group(2)))
                end = min(end, size - 1)
            except ValueError:
                start, end = 0, size - 1
            if start > end or start >= size:
                return web.Response(status=416, headers={"Content-Range": "bytes */%d" % size})
            status = 206

    length = end - start + 1
    headers = {
        "Content-Type": ctype,
        "Accept-Ranges": "bytes",
        "Content-Length": str(length),
        "Cache-Control": "no-store",
    }
    if status == 206:
        headers["Content-Range"] = "bytes %d-%d/%d" % (start, end, size)

    resp = web.StreamResponse(status=status, headers=headers)
    await resp.prepare(request)
    if request.method == "HEAD":
        return resp

    try:
        with open(p, "rb") as f:
            f.seek(start)
            left = length
            while left > 0:
                # 同样丢线程，SMB 读取慢也不会堵住事件循环
                chunk = await loop.run_in_executor(None, f.read, min(_CHUNK, left))
                if not chunk:
                    break
                await resp.write(chunk)
                left -= len(chunk)
        await resp.write_eof()
    except (ConnectionResetError, asyncio.CancelledError):
        pass  # 拖动进度条时浏览器会主动断开，正常现象
    except Exception as e:  # noqa
        print("[视频抽帧] 视频流中断：%s" % e)
    return resp


# ----------------------------------------------------------------------------
# 目录浏览：给节点上的「选择视频…」按钮用
# ----------------------------------------------------------------------------

_MAX_DIRS = 600
_MAX_FILES = 800
_SKIP_DIRS = {"$recycle.bin", "system volume information", "config.msi",
              "recovery", "windows.old", "msocache", "perflogs"}


def _drives():
    """返回本机所有可用盘符（含已映射的网络驱动器）。"""
    out = []
    if os.name != "nt":
        return ["/"]
    try:
        for d in os.listdrives():  # Python 3.12+
            out.append(d)
        return out
    except Exception:
        pass
    import string
    for ch in string.ascii_uppercase:
        p = ch + ":\\"
        try:
            if os.path.exists(p):
                out.append(p)
        except OSError:
            continue
    return out


def _norm_dir(raw):
    """规范化输入的目录/文件路径；非法（相对路径）返回 None。"""
    p = (raw or "").strip().strip('"').strip("'")
    if not p:
        return ""
    p = os.path.expandvars(os.path.expanduser(p))
    if not os.path.isabs(p):
        return None
    return os.path.normpath(p)


def _parent_of(p):
    """上一级目录；已在根（C:\\ 或 \\\\host）时返回空串表示「此电脑」。"""
    if not p:
        return None
    p = os.path.normpath(p)
    q = p.rstrip("\\/")
    if re.match(r"^\\\\[^\\/]+\\[^\\/]+$", q):      # \\NAS\share → \\NAS
        return "\\\\" + q.lstrip("\\").split("\\")[0]
    if re.match(r"^\\\\[^\\/]+$", q):                # \\NAS → 此电脑
        return ""
    if re.match(r"^[A-Za-z]:$", q):                  # C: → 此电脑
        return ""
    par = os.path.dirname(q)
    if par and os.path.normpath(par) != q:
        return os.path.normpath(par)
    return ""


def _is_hidden(entry):
    try:
        attrs = entry.stat(follow_symlinks=False).st_file_attributes
    except Exception:
        return False
    return bool(attrs & 0x2) or bool(attrs & 0x4)   # HIDDEN | SYSTEM


def _list_dir(d):
    """只列子目录 + 视频文件；目录按名称、视频按修改时间倒序。"""
    dirs, files = [], []
    with os.scandir(d) as it:
        for e in it:
            name = e.name
            if not name or name[0] in "$." or name.lower() in _SKIP_DIRS:
                continue
            try:
                if e.is_dir():
                    if _is_hidden(e):
                        continue
                    dirs.append({"name": name, "path": e.path, "dir": True})
                elif is_video(name) and e.is_file():
                    try:
                        stt = e.stat()
                        size, mt = int(stt.st_size), float(stt.st_mtime)
                    except OSError:
                        size, mt = 0, 0.0
                    files.append({"name": name, "path": e.path, "dir": False,
                                  "size": size, "mtime": mt})
            except OSError:
                continue
    dirs.sort(key=lambda x: x["name"].lower())
    files.sort(key=lambda x: x["mtime"], reverse=True)
    return dirs[:_MAX_DIRS], files[:_MAX_FILES], len(dirs), len(files)


def _browse_work(raw, want_drives=True):
    p = _norm_dir(raw)
    if p is None:
        return {"ok": False, "error": "请填绝对路径，例如 D:\\video 或 \\\\NAS\\share"}

    selected = None
    if p and os.path.isfile(p):
        if not is_video(p):
            return {"ok": False, "error": "这不是视频文件：%s" % p}
        selected = p
        # 注意：本机 Python 的 dirname 会把分隔符变成 "/"，统一 normpath 回反斜杠
        p = os.path.normpath(os.path.dirname(os.path.normpath(p)))

    if not p:  # 空路径 = 此电脑：把盘符当目录列出来
        dirs = [{"name": d, "path": d, "dir": True, "drive": True} for d in _drives()]
        return {"ok": True, "dir": "", "parent": None, "root": True, "drives": dirs,
                "dirs": dirs, "files": [], "n_dirs": len(dirs), "n_files": 0,
                "selected": None}

    if not os.path.isdir(p):
        if not os.path.exists(p):
            drv = [{"name": d, "path": d, "dir": True, "drive": True} for d in _drives()]
            return {"ok": False, "error": "路径不存在或无法访问：%s" % p,
                    "drives": drv, "root": True, "dir": "",
                    "dirs": drv, "files": [], "n_dirs": len(drv), "n_files": 0}
        return {"ok": False, "error": "这不是文件夹：%s" % p}

    dirs, files, nd, nf = _list_dir(p)
    drv = []
    if want_drives:
        try:
            drv = [{"name": d, "path": d, "dir": True, "drive": True} for d in _drives()]
        except Exception:
            drv = []
    return {"ok": True, "dir": p, "parent": _parent_of(p), "root": False, "drives": drv,
            "dirs": dirs, "files": files, "n_dirs": nd, "n_files": nf,
            "selected": selected}


@routes.get("/pathvframe/browse")
async def pvf_browse(request):
    raw = request.query.get("dir") or ""
    want = (request.query.get("d") or "1") != "0"
    loop = asyncio.get_event_loop()
    try:
        # 列 NAS 目录可能卡很久，必须离开事件循环
        data = await loop.run_in_executor(None, _browse_work, raw, want)
    except Exception as e:  # noqa
        return web.json_response({"ok": False, "error": "读取目录失败：%s" % e})
    return web.json_response(data)

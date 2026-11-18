import { app } from "../../scripts/app.js";

/**
 * 视频抽帧（路径·预览选帧）前端
 *
 * - 预览：<video> 走 /pathvframe/stream（支持 Range，大文件随便拖）
 * - 选片：「选择视频…」弹出目录浏览器，支持本地盘 / NAS（SMB、UNC）导航，点一下就填进 path
 * - 播放：▶/⏸ 边看边定，暂停时把当前画面定格成参考帧
 * - 步进：⏪/⏩ 每次前进或后退「步进」里填的帧数
 */

const NODE = "PathVideoFrame";
const enc = (p) => encodeURIComponent(p || "");
const RECENT_KEY = "pvf.recent.v1";

const CSS = {
  wrap: "display:flex;flex-direction:column;gap:5px;width:100%;padding:2px 0 4px;box-sizing:border-box;",
  video: "width:100%;height:230px;background:#0b0b0b;border-radius:6px;object-fit:contain;display:block;cursor:pointer;",
  bar: "display:flex;align-items:center;gap:6px;min-width:0;",
  btn: "flex:0 0 auto;min-width:28px;height:22px;line-height:20px;padding:0 6px;font-size:12px;cursor:pointer;text-align:center;" +
       "border:1px solid var(--border-color,#555);border-radius:4px;white-space:nowrap;" +
       "background:var(--comfy-input-bg,#2a2a2a);color:var(--input-text,var(--fg-color,#ddd));",
  slider: "flex:1 1 auto;min-width:60px;margin:0;",
  readout: "font-size:11px;font-family:ui-monospace,Consolas,monospace;white-space:nowrap;overflow:hidden;" +
           "text-overflow:ellipsis;color:var(--fg-color,#bbb);opacity:.85;",
  fileLabel: "flex:1 1 auto;min-width:0;font-size:11px;overflow:hidden;text-overflow:ellipsis;" +
             "white-space:nowrap;color:var(--fg-color,#bbb);opacity:.8;",
  step: "flex:0 0 auto;width:46px;height:22px;padding:0 4px;font-size:12px;box-sizing:border-box;" +
        "border:1px solid var(--border-color,#555);border-radius:4px;" +
        "background:var(--comfy-input-bg,#2a2a2a);color:var(--input-text,var(--fg-color,#ddd));",
  stepLbl: "flex:0 0 auto;font-size:11px;color:var(--fg-color,#bbb);opacity:.8;",

  /* 浏览弹窗 */
  overlay: "position:fixed;inset:0;z-index:100000;display:none;align-items:center;justify-content:center;" +
           "background:rgba(0,0,0,.55);backdrop-filter:blur(2px);",
  panel: "display:flex;flex-direction:column;gap:8px;box-sizing:border-box;" +
         "width:min(720px,93vw);height:min(580px,88vh);padding:12px;border-radius:10px;" +
         "background:var(--comfy-menu-bg,#1e1e22);color:var(--fg-color,#ddd);" +
         "border:1px solid var(--border-color,#444);box-shadow:0 18px 50px rgba(0,0,0,.45);",
  panelHead: "display:flex;align-items:center;gap:8px;",
  panelTitle: "flex:1 1 auto;font-size:13px;font-weight:600;",
  pathInput: "flex:1 1 auto;min-width:80px;height:24px;padding:0 6px;box-sizing:border-box;font-size:12px;" +
             "border:1px solid var(--border-color,#555);border-radius:4px;" +
             "background:var(--comfy-input-bg,#2a2a2a);color:var(--input-text,var(--fg-color,#ddd));",
  chips: "display:flex;flex-wrap:wrap;gap:5px;",
  chip: "max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;cursor:pointer;" +
        "font-size:11px;padding:2px 8px;border-radius:10px;" +
        "border:1px solid var(--border-color,#555);background:var(--comfy-input-bg,#2a2a2a);" +
        "color:var(--fg-color,#ccc);",
  list: "flex:1 1 auto;min-height:80px;overflow-y:auto;overflow-x:hidden;padding:2px;" +
        "border:1px solid var(--border-color,#444);border-radius:6px;" +
        "background:var(--comfy-input-bg,rgba(0,0,0,.15));",
  row: "display:flex;align-items:center;gap:8px;padding:3px 7px;border-radius:4px;cursor:pointer;" +
       "font-size:12px;line-height:18px;",
  rowName: "flex:1 1 auto;min-width:0;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;",
  rowMeta: "flex:0 0 auto;font-size:11px;opacity:.6;font-family:ui-monospace,Consolas,monospace;",
  status: "font-size:11px;opacity:.75;min-height:14px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;",
};

function el(tag, css, text) {
  const e = document.createElement(tag);
  if (css) e.style.cssText = css;
  if (text != null) e.textContent = text;
  return e;
}

function makeBtn(text, title) {
  const b = document.createElement("button");
  b.type = "button";
  b.textContent = text;
  b.title = title || "";
  b.style.cssText = CSS.btn;
  return b;
}

function fmtSize(n) {
  if (!n) return "";
  const u = ["B", "KB", "MB", "GB", "TB"];
  let i = 0, v = n;
  while (v >= 1024 && i < u.length - 1) { v /= 1024; i++; }
  return (i === 0 ? v : v.toFixed(v >= 100 ? 0 : 1)) + " " + u[i];
}

function getRecent() {
  try {
    const a = JSON.parse(localStorage.getItem(RECENT_KEY) || "[]");
    return Array.isArray(a) ? a.filter((x) => typeof x === "string") : [];
  } catch (e) { return []; }
}

function pushRecent(p) {
  if (!p) return;
  const a = [p].concat(getRecent().filter((x) => x !== p)).slice(0, 8);
  try { localStorage.setItem(RECENT_KEY, JSON.stringify(a)); } catch (e) { /* ignore */ }
}

function dirnameOf(p) {
  const s = String(p || "").replace(/[\\/]+$/, "");
  const i = Math.max(s.lastIndexOf("\\"), s.lastIndexOf("/"));
  return i > 0 ? s.slice(0, i) : s;
}

function setup(node) {
  if (node._pvfBuilt) return;
  const wPath = node.widgets?.find((w) => w.name === "path");
  const wFrame = node.widgets?.find((w) => w.name === "frame");
  if (!wPath || !wFrame) return;
  node._pvfBuilt = true;

  const st = {
    fps: 0, frames: 0, w: 0, h: 0, seekTimer: 0, lastPath: null,
    step: 1, skipCommit: false, raf: 0, lastDir: "",
  };

  /* ---------------- 预览区 ---------------- */
  const wrap = el("div", CSS.wrap);

  const rowTop = el("div", CSS.bar);
  const browseBtn = makeBtn("📁 选择视频…", "浏览文件夹挑视频（本地盘、映射盘、NAS/SMB 网络路径都行）");
  const fileLabel = el("div", CSS.fileLabel, "未选择视频");
  rowTop.append(browseBtn, fileLabel);

  const video = document.createElement("video");
  video.muted = true;
  video.playsInline = true;
  video.preload = "metadata";
  video.dataset.pvf = "video";
  video.style.cssText = CSS.video;
  video.title = "点击画面 = 播放 / 暂停（暂停即定格当前帧）";

  const rowPlay = el("div", CSS.bar);
  const bFirst = makeBtn("|◀", "跳到第 1 帧");
  const bBack = makeBtn("◀◀", "后退「步进」帧数");
  const bPlay = makeBtn("▶", "播放 / 暂停（暂停 = 定格当前帧作为参考帧）");
  const bFwd = makeBtn("▶▶", "前进「步进」帧数");
  const bLast = makeBtn("▶|", "跳到最后一帧");
  const stepLbl = el("span", CSS.stepLbl, "步进");
  const stepIn = document.createElement("input");
  stepIn.type = "number";
  stepIn.min = "1";
  stepIn.max = "9999";
  stepIn.step = "1";
  stepIn.value = "1";
  stepIn.title = "步进帧数：⏪ / ⏩ 每次按这个数前进或后退";
  stepIn.dataset.pvf = "step";
  stepIn.style.cssText = CSS.step;
  rowPlay.append(bFirst, bBack, bPlay, bFwd, bLast, stepLbl, stepIn);

  const slider = document.createElement("input");
  slider.type = "range";
  slider.min = "0";
  slider.max = "0";
  slider.step = "1";
  slider.value = "0";
  slider.style.cssText = CSS.slider;

  const readout = el("div", CSS.readout, "未选择视频：点上面的「选择视频…」，或在 path 里直接填路径");
  readout.dataset.pvf = "readout";
  slider.dataset.pvf = "slider";
  wrap.append(rowTop, video, rowPlay, slider, readout);

  const dom = node.addDOMWidget("pvf_preview", "pvf-preview", wrap, {
    serialize: false,
    hideOnZoom: false,
  });
  dom.computeSize = (width) => [width, 336];

  node._pvfVideo = video;

  /* ---------------- 帧号 / 跳转 ---------------- */
  const frameMax = () => Math.max(0, (st.frames || 1) - 1);
  const clampIdx = (v) => Math.max(0, Math.min(frameMax(), Math.round(+v || 0)));

  function paint(idx) {
    if (!st.frames || !st.fps) {
      readout.textContent = st.lastPath ? "（未读到帧信息）" : "未选择视频：点上面的「选择视频…」，或在 path 里直接填路径";
      return;
    }
    const t = idx / st.fps;
    readout.textContent =
      "帧 " + idx + " / " + frameMax() +
      " · " + st.fps.toFixed(2) + "fps" +
      " · " + (st.w || "?") + "x" + (st.h || "?") +
      " · " + t.toFixed(2) + "s";
  }

  function quietPause() {
    if (!video.paused) {
      st.skipCommit = true;    // 是我们主动打断播放，别把打断瞬间的帧号写回去
      try { video.pause(); } catch (e) { /* ignore */ }
    }
  }

  function applySeek(idx) {
    if (!st.frames || !st.fps) return;
    clearTimeout(st.seekTimer);
    const t = (idx + 0.5) / st.fps;
    st.seekTimer = setTimeout(() => {
      try {
        const dur = video.duration || 0;
        video.currentTime = Math.max(0, dur > 0 ? Math.min(t, dur - 0.001) : t);
      } catch (e) { /* 视频还没就绪 */ }
    }, 40);
  }

  function setFrame(v, doSeek) {
    const idx = clampIdx(v);
    if (+wFrame.value !== idx) {
      wFrame.value = idx;
      try { node.setDirtyCanvas(true, false); } catch (e) { /* ignore */ }
    }
    if (slider.value !== String(idx)) slider.value = String(idx);
    paint(idx);
    if (doSeek) { quietPause(); applySeek(idx); }
  }

  /* ---------------- 播放 ---------------- */
  function startTick() {
    cancelAnimationFrame(st.raf);
    const loop = () => {
      if (video.paused) return;
      if (st.fps) {
        const idx = clampIdx(Math.round(video.currentTime * st.fps - 0.5));
        if (slider.value !== String(idx)) slider.value = String(idx);
        paint(idx);
      }
      st.raf = requestAnimationFrame(loop);
    };
    st.raf = requestAnimationFrame(loop);
  }

  function togglePlay() {
    if (video.paused) {
      if (!video.src) { readout.textContent = "先选择视频再播放"; return; }
      video.play().catch((e) => { readout.textContent = "播放失败：" + e; });
    } else {
      video.pause();
    }
  }

  video.addEventListener("play", () => { bPlay.textContent = "‖"; startTick(); });
  video.addEventListener("pause", () => {
    bPlay.textContent = "▶";
    cancelAnimationFrame(st.raf);
    if (st.skipCommit) { st.skipCommit = false; return; }
    if (st.fps && st.frames) {
      // 暂停 = 定格这一帧
      setFrame(Math.round(video.currentTime * st.fps - 0.5), false);
    }
  });
  video.addEventListener("click", togglePlay);
  bPlay.addEventListener("click", togglePlay);

  bFirst.addEventListener("click", () => setFrame(0, true));
  bLast.addEventListener("click", () => setFrame(frameMax(), true));
  bBack.addEventListener("click", () => setFrame((+wFrame.value || 0) - st.step, true));
  bFwd.addEventListener("click", () => setFrame((+wFrame.value || 0) + st.step, true));

  function readStep() {
    let n = parseInt(stepIn.value, 10);
    if (!Number.isFinite(n) || n < 1) n = 1;
    n = Math.min(9999, n);
    st.step = n;
    return n;
  }
  stepIn.addEventListener("input", readStep);
  stepIn.addEventListener("change", () => { stepIn.value = String(readStep()); });

  slider.addEventListener("pointerdown", quietPause);
  slider.addEventListener("input", () => setFrame(slider.value, true));

  /* ---------------- 载入路径 ---------------- */
  async function reload(force) {
    const p = String(wPath.value || "").trim().replace(/^["']|["']$/g, "");
    if (!force && p === st.lastPath) return;
    st.lastPath = p;
    st.frames = 0;
    st.fps = 0;
    slider.max = "0";
    slider.value = "0";
    clearTimeout(st.seekTimer);
    try { video.pause(); } catch (e) { /* ignore */ }
    try {
      video.removeAttribute("src");
      video.load();
    } catch (e) { /* ignore */ }

    if (!p) {
      fileLabel.textContent = "未选择视频";
      fileLabel.title = "";
      readout.textContent = "未选择视频：点上面的「选择视频…」，或在 path 里直接填路径";
      return;
    }

    fileLabel.textContent = p.split(/[\\/]/).pop() || p;
    fileLabel.title = p;
    readout.textContent = "正在读取视频信息…";

    try {
      const res = await fetch("/pathvframe/meta?p=" + enc(p), { cache: "no-store" });
      const m = await res.json();
      if (!m || !m.ok) {
        readout.textContent = "读取失败：" + ((m && m.error) || "未知错误");
        return;
      }
      st.fps = m.fps || 25;
      st.frames = m.frames || 0;
      st.w = m.width || 0;
      st.h = m.height || 0;
      slider.max = String(frameMax());
      video.src = "/pathvframe/stream?p=" + enc(p) + "&t=" + Date.now();
      setFrame(wFrame.value, true);
      pushRecent(p);
      if (!st.frames) readout.textContent = "已加载，但读到 0 帧：" + (m.name || p);
    } catch (e) {
      readout.textContent = "读取失败：" + e;
    }
  }

  const origFrameCb = wFrame.callback;
  wFrame.callback = function (v) {
    const out = origFrameCb ? origFrameCb.apply(this, arguments) : undefined;
    setFrame(v, true);
    return out;
  };

  const origPathCb = wPath.callback;
  wPath.callback = function (v) {
    const out = origPathCb ? origPathCb.apply(this, arguments) : undefined;
    st.lastPath = null;
    reload(true);
    return out;
  };

  video.addEventListener("loadeddata", () => { applySeek(+wFrame.value || 0); });

  video.addEventListener("loadedmetadata", () => {
    // 少数封装（部分 mkv / 变帧率）读不到精确帧数，用 duration*fps 兜底，滑块才不会卡在 0
    if (!st.frames && video.duration > 0 && st.fps > 0) {
      st.frames = Math.max(1, Math.round(video.duration * st.fps));
      slider.max = String(frameMax());
    }
    applySeek(+wFrame.value || 0);
  });

  /* ---------------- 目录浏览器 ---------------- */
  let modal = null;
  let mPathIn = null;
  let mDrives = null;
  let mRecent = null;
  let mList = null;
  let mStatus = null;
  let mCurDir = "";
  let mSeq = 0;

  function guardKeys(e) {
    if (!modal || modal.style.display === "none") return;
    if (e.key === "Escape") {
      e.preventDefault();
      closeBrowser();
      return;
    }
    // 弹窗开着时不让 ComfyUI 收到快捷键（否则在路径框里按退格会把节点删掉）。
    // 注意：这里必须用冒泡阶段、且只 stopPropagation 不 preventDefault，
    // 否则输入框里根本打不进字。
    e.stopPropagation();
  }

  function buildModal() {
    if (modal) return;
    modal = el("div", CSS.overlay);
    modal.tabIndex = -1;
    modal.style.outline = "none";
    const panel = el("div", CSS.panel);

    const head = el("div", CSS.panelHead);
    const title = el("div", CSS.panelTitle, "选择视频文件");
    const close = makeBtn("✕", "关闭（Esc）");
    head.append(title, close);

    const nav = el("div", CSS.bar);
    const up = makeBtn("⬆ 上级", "回到上一级目录");
    mPathIn = document.createElement("input");
    mPathIn.type = "text";
    mPathIn.spellcheck = false;
    mPathIn.placeholder = "可直接粘贴路径后回车，例如 D:\\video 或 \\\\NAS\\share\\素材";
    mPathIn.dataset.pvf = "pathinput";
    mPathIn.style.cssText = CSS.pathInput;
    const go = makeBtn("转到", "跳转到输入框里的路径");
    nav.append(up, mPathIn, go);

    mDrives = el("div", CSS.chips);
    mDrives.dataset.pvf = "drives";
    mRecent = el("div", CSS.chips);
    mRecent.dataset.pvf = "recent";
    mList = el("div", CSS.list);
    mStatus = el("div", CSS.status, "");
    mStatus.dataset.pvf = "status";

    panel.append(head, nav, mDrives, mRecent, mList, mStatus);
    modal.appendChild(panel);
    document.body.appendChild(modal);

    close.addEventListener("click", closeBrowser);
    modal.addEventListener("mousedown", (e) => { if (e.target === modal) closeBrowser(); });
    modal.addEventListener("keydown", guardKeys);
    up.addEventListener("click", () => navTo(mParent || ""));
    go.addEventListener("click", () => navTo(mPathIn.value.trim()));
    mPathIn.addEventListener("keydown", (e) => {
      if (e.key === "Enter") { e.preventDefault(); navTo(mPathIn.value.trim()); }
    });

    for (const ev of ["wheel", "contextmenu"]) {
      panel.addEventListener(ev, (e) => e.stopPropagation(), { passive: true });
    }
  }

  let mParent = null;

  function openBrowser(start) {
    buildModal();
    modal.style.display = "flex";
    mRecent.replaceChildren();
    const rec = getRecent();
    if (rec.length) {
      rec.forEach((p) => {
        const c = el("div", CSS.chip, "🕘 " + (p.split(/[\\/]/).pop() || p));
        c.title = p;
        c.addEventListener("click", () => usePath(p));
        mRecent.appendChild(c);
      });
    }
    navTo(start || st.lastDir || String(wPath.value || "").trim());
    // 把焦点收进弹窗，键盘事件才会经由 modal 冒泡、被我们拦住
    try { modal.focus({ preventScroll: true }); } catch (e) { /* ignore */ }
  }

  function closeBrowser() {
    if (!modal) return;
    modal.style.display = "none";
    try { modal.blur(); } catch (e) { /* ignore */ }
  }

  function usePath(p) {
    st.lastPath = null;
    st.lastDir = dirnameOf(p);
    wPath.value = p;
    pushRecent(p);
    try { node.setDirtyCanvas(true, true); } catch (e) { /* ignore */ }
    try { app.graph.setDirtyCanvas(true, true); } catch (e) { /* ignore */ }
    closeBrowser();
    if (wPath.callback) wPath.callback(p);
    else reload(true);
  }

  async function navTo(dir) {
    const seq = ++mSeq;
    mStatus.textContent = "正在读取目录…";
    mList.replaceChildren();
    try {
      const r = await fetch("/pathvframe/browse?d=1&dir=" + enc(dir), { cache: "no-store" });
      const d = await r.json();
      if (seq !== mSeq) return;   // 连点太快，丢掉过期响应
      if (!d || !d.ok) {
        mStatus.textContent = (d && d.error) || "无法打开该路径";
        if (d && d.dirs && d.dirs.length) render(d);   // 出错时至少把盘符留给人点
        return;
      }
      render(d);
    } catch (e) {
      if (seq === mSeq) mStatus.textContent = "读取失败：" + e;
    }
  }

  function render(d) {
    mCurDir = d.dir || "";
    mParent = d.parent;
    mPathIn.value = mCurDir;
    st.lastDir = mCurDir;

    // 处在「此电脑」时，下面的列表里已经全是盘符了，上面的盘符条就不重复画了
    if (d.root) {
      mDrives.replaceChildren();
    } else if (d.drives && d.drives.length) {
      mDrives.replaceChildren();
      d.drives.forEach((dv) => {
        const c = el("div", CSS.chip, "💽 " + dv.name.replace(/\\$/, ""));
        c.title = dv.path;
        c.addEventListener("click", () => navTo(dv.path));
        mDrives.appendChild(c);
      });
    }

    mList.replaceChildren();
    const rows = [];
    (d.dirs || []).forEach((e2) => {
      const row = el("div", CSS.row);
      row.dataset.pvfPath = e2.path;
      const icon = el("span", null, e2.drive ? "💽" : "📁");
      const nm = el("div", CSS.rowName, e2.name);
      nm.title = e2.path;
      row.append(icon, nm);
      row.addEventListener("click", () => navTo(e2.path));
      mList.appendChild(row);
      rows.push(row);
    });
    (d.files || []).forEach((f) => {
      const row = el("div", CSS.row);
      row.dataset.pvfPath = f.path;
      row.dataset.pvfFile = "1";
      const icon = el("span", null, "🎬");
      const nm = el("div", CSS.rowName, f.name);
      nm.title = f.path;
      const mt = el("div", CSS.rowMeta, fmtSize(f.size));
      row.append(icon, nm, mt);
      row.addEventListener("mouseenter", () => { row.style.background = "rgba(127,127,127,.18)"; });
      row.addEventListener("mouseleave", () => {
        row.style.background = f.path === d.selected ? "rgba(90,160,255,.20)" : "";
      });
      row.addEventListener("click", () => usePath(f.path));
      if (f.path === d.selected || f.path === String(wPath.value || "").trim()) {
        row.style.background = "rgba(90,160,255,.20)";
      }
      mList.appendChild(row);
      rows.push(row);
    });

    const nd = d.n_dirs ?? (d.dirs || []).length;
    const nf = d.n_files ?? (d.files || []).length;
    mStatus.textContent = mCurDir
      ? mCurDir + "　·　" + nd + " 个文件夹 / " + nf + " 个视频"
      : "此电脑：点一个磁盘或网络位置开始";
    if (!nd && !nf && mCurDir) {
      mStatus.textContent = mCurDir + "　·　这里没有子文件夹，也没有视频文件";
    }
    mList.scrollTop = 0;
  }

  browseBtn.addEventListener("click", () => {
    openBrowser(st.lastDir || String(wPath.value || "").trim());
  });

  node._pvfReload = () => { st.lastPath = null; reload(true); };
  node._pvfCloseBrowser = closeBrowser;

  if (node.size[1] < 500) {
    node.setSize([Math.max(node.size[0], 470), 500]);
  }
  if (String(wPath.value || "").trim()) reload(true);
}

app.registerExtension({
  name: "PathVideoFrame.UI",
  async beforeRegisterNodeDef(nodeType, nodeData) {
    if (nodeData.name !== NODE) return;

    const onNodeCreated = nodeType.prototype.onNodeCreated;
    nodeType.prototype.onNodeCreated = function () {
      const r = onNodeCreated ? onNodeCreated.apply(this, arguments) : undefined;
      try {
        setup(this);
      } catch (e) {
        console.error("[PathVideoFrame] 初始化预览失败", e);
      }
      return r;
    };

    const onConfigure = nodeType.prototype.onConfigure;
    nodeType.prototype.onConfigure = function () {
      const r = onConfigure ? onConfigure.apply(this, arguments) : undefined;
      const self = this;
      setTimeout(() => {
        try {
          if (self._pvfReload) self._pvfReload();
          else setup(self);
        } catch (e) { /* ignore */ }
      }, 30);
      return r;
    };

    const onRemoved = nodeType.prototype.onRemoved;
    nodeType.prototype.onRemoved = function () {
      try { if (this._pvfCloseBrowser) this._pvfCloseBrowser(); } catch (e) { /* ignore */ }
      if (this._pvfVideo) {
        try {
          this._pvfVideo.pause();
          this._pvfVideo.removeAttribute("src");
          this._pvfVideo.load();
        } catch (e) { /* ignore */ }
      }
      return onRemoved ? onRemoved.apply(this, arguments) : undefined;
    };
  },
});

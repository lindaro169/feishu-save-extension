/* 飞书文档转存 - content script
 * 零配置：全部请求走用户自己的飞书登录态（同源 + credentials）。
 * 管线：滚动收集正文块 → 图片转 base64 内嵌 → parse_html 提交 → 轮询结果。
 */
(() => {
  'use strict';

  const CLIP_VERSION = '1.0.39';
  const REQ_SOURCE = 'feishu-clipper';
  const COVER = '//lf-package-cn.feishucdn.com/obj/feishu-static/ccm-vmok/web/feishu.ico';
  const MAX_HTML_BYTES = 60 * 1024 * 1024;
  const MAX_IMG_BYTES = 8 * 1024 * 1024;
  const MAX_MEDIA_BYTES = 200 * 1024 * 1024;      // 单个视频/附件上限，超过直接跳过（不下载）

  const SCROLL_SEL = '.bear-web-x-container';

  const sleep = (ms) => new Promise(r => setTimeout(r, ms));
  const randId = (n = 32) => Array.from({ length: n }, () => Math.floor(Math.random() * 16).toString(16)).join('');
  const docTitle = () => {
    let t = (document.title || '').trim();
    t = t.replace(ZERO_WIDTH_RE, '');
    t = t.replace(/\s*[-–—|]\s*(Feishu Docs|Lark Docs|飞书云文档|飞书文档|飞书)\s*$/i, '');
    t = t.replace(/\.html$/i, '').trim();
    return t || '转存文档';
  };


  const ZERO_WIDTH_RE = /[\u200b-\u200f\u202a-\u202e\u2060-\u2064\ufeff]/g;
  const esc = (s) => String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  const stripInvisible = (s) => String(s == null ? '' : s).replace(ZERO_WIDTH_RE, '');

  /* 从元素里找媒体 token（飞书把 token 放在 cover/download 链接里） */
  function findMediaToken(el) {
    const html = el.outerHTML || '';
    const m = html.match(/\/download\/(?:v2\/)?(?:cover|all|preview)\/([A-Za-z0-9]{20,32})/);
    return m ? m[1] : '';
  }

  /* 表格等内嵌滚动容器：把它们的内部也滚一遍，否则单元格内容不渲染 */
  async function scrollInnerContainers() {
    const inner = [...document.querySelectorAll('.docx-table-block .scrollable-container, .docx-table-block .scrollable-wrapper, .grid-view .scrollable-container')];
    for (const el of inner) {
      try {
        if (el.scrollHeight > el.clientHeight + 20) {
          el.scrollTop = Math.min(el.scrollHeight, el.scrollTop + Math.max(120, Math.floor(el.clientHeight * 0.8)));
        }
        if (el.scrollWidth > el.clientWidth + 20) {
          el.scrollLeft = Math.min(el.scrollWidth, el.scrollLeft + Math.max(200, Math.floor(el.clientWidth * 0.8)));
        }
      } catch (e) { }
    }
  }

  /* 采集当刻就把图片取成 base64（飞书图片多是 blob: 临时地址，块卸载后即失效） */
  async function inlineBlockImages(el, html) {
    const imgs = [...el.querySelectorAll('img')];
    if (!imgs.length) return html;
    let out = html;
    for (const im of imgs) {
      const src = im.currentSrc || im.getAttribute('src') || '';
      if (!src || src.startsWith('data:') || src.startsWith('chrome')) continue;
      try {
        const r = await fetch(src, src.startsWith('blob:') ? {} : { credentials: 'include' });
        if (!r.ok) continue;
        const bl = await r.blob();
        if (!bl.size || bl.size > MAX_IMG_BYTES) continue;
        if (bl.type && !/^image\//.test(bl.type) && !src.startsWith('blob:')) continue;
        const d = await new Promise(res => { const fr = new FileReader(); fr.onload = () => res(fr.result); fr.onerror = () => res(null); fr.readAsDataURL(bl); });
        if (d) out = out.split('src="' + src + '"').join('src="' + d + '"');
      } catch (e) { }
    }
    return out;
  }

  /* 媒体块取名：视频块的 innerText 是播放器 UI 文本，只从中提取真正的文件名 */
  function mediaName(e) {
    const t = stripInvisible((e.innerText || '').replace(/\s+/g, ' ').trim());
    const m = t.match(/([^\s\\/]+?\.(?:mp4|mov|m4v|webm|avi|mkv|txt|md|csv|json|pdf|docx?|xlsx?|pptx?|zip|rar|png|jpe?g|gif))\s*$/i)
      || t.match(/([^\s\\/]+?\.(?:mp4|mov|m4v|webm|avi|mkv|txt|md|csv|json|pdf|docx?|xlsx?|pptx?|zip|rar|png|jpe?g|gif))/i);
    if (m) return m[1].slice(0, 120);
    const cleaned = t.replace(/\d{1,2}:\d{2}(:\d{2})?/g, ' ').replace(/Unable to print|Picture-in-Picture|Replay|Play|Live|Fullscreen|PIP|Original|Click and hold to drag/gi, ' ').replace(/\s+/g, ' ').trim();
    return cleaned.slice(0, 80) || '附件';
  }

  /* 块内嵌套媒体（view/file，常见于表格单元格里）：登记 token 并替换成占位 */
  function extractNestedMedia(clone, register) {
    const nodes = [...clone.querySelectorAll('[data-block-type="view"],[data-block-type="file"],.docx-view-block,.docx-file-block')];
    for (const n of nodes) {
      if (!n.parentNode) continue;
      const html = n.outerHTML || '';
      const rec = n.getAttribute('data-record-id') || '';
      const tok = (html.match(/\/download\/(?:v2\/)?(?:cover|all|preview)\/([A-Za-z0-9]{20,32})/) || [])[1] || rec;
      if (!tok) { n.remove(); continue; }
      const name = mediaName(n);
      const mid = n.getAttribute('data-block-id') || ('m' + Math.floor(Math.random() * 1e6));
      register(mid, tok, name);                       // 去重只决定"是否新建登记"，位置必须保留
      const ph = clone.ownerDocument.createElement('div');
      ph.setAttribute('data-fxfer-media', mid);
      n.replaceWith(ph);
    }
  }

  /* 飞书表格是 div 网格，导入器认不出；按单元格位置聚类成标准 <table> */
  function buildTableHtml(tableEl, cellHtml) {
    const cells = [...tableEl.querySelectorAll('[data-block-type="table_cell"], .docx-table_cell-block')];
    if (!cells.length) return null;
    const info = [];
    for (const c of cells) {
      const r = c.getBoundingClientRect();
      if (r.width === 0 && r.height === 0) continue;
      info.push({ el: c, top: Math.round(r.top), left: Math.round(r.left), html: cellHtml(c) });
    }
    if (!info.length) return null;
    info.sort((a, b) => a.top - b.top || a.left - b.left);
    const rows = [];
    for (const it of info) {
      const row = rows.find(x => Math.abs(x.top - it.top) < 24);
      if (row) row.cells.push(it); else rows.push({ top: it.top, cells: [it] });
    }
    let out = '<table>';
    for (const r of rows) {
      r.cells.sort((a, b) => a.left - b.left);
      out += '<tr>' + r.cells.map(c => '<td>' + (c.html || '') + '</td>').join('') + '</tr>';
    }
    return out + '</table>';
  }

  /* 清理块 HTML：去掉飞书 UI 占位/隐藏层等垃圾 */
  const JUNK_SEL = '.gpf-biz-action-manager-forbidden-placeholder,[data-type="print-forbidden-placeholder"],.docx-block-zero-space,[data-zero-space="true"],.layer-popup,.suspension-comment-area,.docx-block-loading-container';
  function cleanBlockHtml(el, register) {
    const clone = el.cloneNode(true);
    if (register) extractNestedMedia(clone, register);
    clone.querySelectorAll(JUNK_SEL).forEach(n => n.remove());
    clone.querySelectorAll('*').forEach(n => {
      const st = (n.getAttribute && n.getAttribute('style')) || '';
      if (/display\s*:\s*none|visibility\s*:\s*hidden/i.test(st)) n.remove();
    });
    clone.querySelectorAll('[contenteditable]').forEach(n => n.removeAttribute('contenteditable'));
    return clone.outerHTML;
  }

  /* 分片(Range)下载 + 每片重试：弱网/代理掐连接也能续着下完 */
  async function fetchMediaBytes(url, onProgress, label) {
    const CHUNK = 2 * 1024 * 1024;
    const tryFetch = async (headers) => {
      let last = null;
      for (let a = 1; a <= 4; a++) {
        try { return await fetchWithTimeout(url, { credentials: 'include', headers }, 180000); }
        catch (e) { last = e; if (a < 4) await sleep(1200 * a); }
      }
      throw last || new Error('网络错误');
    };
    let r = await tryFetch({ Range: 'bytes=0-1048575' });
    if (r.status !== 200 && r.status !== 206) throw new Error('HTTP ' + r.status);
    const ct = (r.headers.get('content-type') || '').toLowerCase();
    const first = new Uint8Array(await r.arrayBuffer());
    if (r.status === 200) return { ct, bytes: first };            // 服务端不支持 Range
    const m = /\/(\d+)\s*$/.exec(r.headers.get('content-range') || '');
    const total = m ? parseInt(m[1], 10) : 0;
    if (total && total > MAX_MEDIA_BYTES) {
      await r.arrayBuffer().catch(() => { });
      throw new Error('素材 ' + (total / 1048576).toFixed(0) + 'MB 超过上限（' + (MAX_MEDIA_BYTES / 1048576) + 'MB），已跳过');
    }
    if (!total || first.length >= total) return { ct, bytes: first };
    const out = new Uint8Array(total);
    out.set(first.subarray(0, total), 0);
    let off = Math.min(first.length, total);
    while (off < total) {
      const end = Math.min(total - 1, off + CHUNK - 1);
      const rr = await tryFetch({ Range: 'bytes=' + off + '-' + end });
      if (rr.status !== 200 && rr.status !== 206) throw new Error('HTTP ' + rr.status + ' @' + off);
      const part = new Uint8Array(await rr.arrayBuffer());
      if (!part.length) throw new Error('空分片 @' + off);
      const n = Math.min(part.length, total - off);
      out.set(part.subarray(0, n), off);
      off += n;
      if (label) onProgress && onProgress(label + ' ' + Math.round(off / total * 100) + '%');
    }
    return { ct, bytes: out };
  }

  /* 把字节上传到用户自己的云空间根目录（mount_point=explorer），返回 file_token */
  async function uploadToDrive(bytes, name, onProgress) {
    const H = () => ({ 'Request-Id': randId(), 'X-Request-Source': REQ_SOURCE });
    const blockSize = 4194304;
    let pj = null, msg = '';
    for (let attempt = 1; attempt <= 3 && !pj; attempt++) {
      try {
        const H1 = H();
        const pr = await fetchWithTimeout('/space/api/box/upload/prepare/', {
          method: 'POST', credentials: 'include',
          headers: { ...H1, 'Content-Type': 'application/json' },
          body: JSON.stringify({ mount_node_token: '', mount_point: 'explorer', name, size: bytes.length })
        }, 60000);
        const j = await pr.json();
        if (j && j.code === 0 && j.data && j.data.upload_id) pj = { data: j.data, H1 };
        else msg = 'HTTP ' + pr.status + ' ' + ((j && j.msg) || '');
      } catch (e) { msg = e.message; }
      if (!pj && attempt < 3) await sleep(2000 * attempt);
    }
    if (!pj) throw new Error('云空间上传初始化失败：' + msg);
    const uid = pj.data.upload_id, bs = pj.data.block_size || blockSize, nb = pj.data.num_blocks || Math.ceil(bytes.length / bs);
    for (let i = 0; i < nb; i++) {
      const blk = bytes.subarray(i * bs, Math.min(bytes.length, (i + 1) * bs));
      let ok = false, last = '';
      for (let a = 1; a <= 3 && !ok; a++) {
        try {
          const r = await fetchWithTimeout('/space/api/box/stream/upload/merge_block/?upload_id=' + uid, {
            method: 'POST', credentials: 'include',
            headers: { ...pj.H1, 'Content-Type': 'application/octet-stream', 'x-seq-list': String(i), 'x-block-list-checksum': String(adler32(blk)), 'x-block-origin-size': String(bs) },
            body: blk
          }, 180000);
          const t = await r.text();
          if (r.status === 200 && t.indexOf('"code":0') >= 0) ok = true; else last = r.status + ' ' + t.slice(0, 60);
        } catch (e) { last = e.message; }
        if (!ok && a < 3) await sleep(2000 * a);
      }
      if (!ok) throw new Error('云空间上传分块失败（' + (i + 1) + '/' + nb + '）：' + last);
      onProgress && onProgress('上传到云空间 ' + (i + 1) + '/' + nb + '…');
    }
    const fr = await fetchWithTimeout('/space/api/box/upload/finish/', {
      method: 'POST', credentials: 'include',
      headers: { ...pj.H1, 'Content-Type': 'application/json' },
      body: JSON.stringify({ upload_id: uid, num_blocks: nb })
    }, 60000);
    const fj = await fr.json();
    if (!fj || fj.code !== 0 || !fj.data || !fj.data.file_token) throw new Error('云空间上传完成失败：' + ((fj && fj.msg) || fr.status));
    return fj.data.file_token;
  }

  /* 素材块统一处理：文本类内联为代码块；视频存到用户云空间并给链接；其它只标注 */
  async function resolveMediaBlocks(html, mediaMap, onProgress) {
    const ids = [...new Set([...html.matchAll(/data-fxfer-media="(\d+)"/g)].map(x => x[1]))];
    const uploadedVideos = [];
    if (!ids.length) return { html, videos: uploadedVideos };
    let i = 0;
    for (const id of ids) {
      i++;
      const m = mediaMap.get(id);
      if (!m) { html = html.split('<div data-fxfer-media="' + id + '"></div>').join(''); continue; }
      const previewUrl = '/space/api/box/stream/download/preview/' + m.token + '/?preview_type=16';
      let block = '';
      onProgress && onProgress('读取素材 ' + i + '/' + ids.length + '…', 42);
      try {
        const dl = await fetchMediaBytes(previewUrl, (t, p) => onProgress && onProgress(t, 46), '下载' + (/\.(mp4|mov|webm)$/i.test(m.name) ? '视频' : '素材'));
        const ct = dl.ct, bytes = dl.bytes;
        const isText = /^text\/|json|xml|csv|javascript|x-markdown/.test(ct) || /\.(txt|md|csv|json|log|srt|yaml|yml|html?|xml)$/i.test(m.name);
        const isVideo = /^video\//.test(ct) || /\.(mp4|mov|m4v|webm|avi|mkv)$/i.test(m.name);
        if (isText) {
          const txt = new TextDecoder('utf-8', { fatal: false }).decode(bytes);
          block = '<p><b>【文件】' + esc(m.name) + '</b></p><pre><code>' + esc(txt) + '</code></pre>';
        } else if (isVideo) {
          if (bytes.length > 200 * 1024 * 1024) throw new Error('视频超过 200MB，已跳过');
          onProgress && onProgress('保存视频到你的云空间（' + (bytes.length / 1048576).toFixed(1) + 'MB）…', 46);
          const vname = /\.[a-z0-9]{2,5}$/i.test(m.fileName) ? m.fileName : m.fileName + '.mp4';
          const ft = await uploadToDrive(bytes, vname, (t) => onProgress && onProgress(t, 47));
          uploadedVideos.push({ fileToken: ft, name: m.name });
          block = '<p>【视频】<a href="' + location.origin + '/file/' + ft + '">' + esc(m.name) + '</a>（'
            + (bytes.length / 1048576).toFixed(1) + 'MB，已保存到你的云空间并会尝试插入本文档）</p>';
        } else {
          const mb = bytes ? (bytes.length / 1048576).toFixed(1) : '?';
          block = '<p>【附件】' + esc(m.name) + '（约 ' + mb + 'MB，非文本/视频素材，未随转存带出）</p>';
        }
      } catch (e) {
        block = '<p>【素材】' + esc(m.name) + '（获取失败：' + esc(e.message) + '。多为网络/代理中断，可稍后重试；原文档链接：<a href="' + previewUrl + '">点此打开</a>）</p>';
      }
      html = html.split('<div data-fxfer-media="' + id + '"></div>').join(block);
    }
    return { html, videos: uploadedVideos };
  }

  const isDocUrl = () => /\/(wiki|docx)\//.test(location.pathname);
  const getScroller = () => document.querySelector(SCROLL_SEL);

  /* ---------------- UI ---------------- */

  let btnEl = null;
  let panelEl = null;
  let running = false;

  function ensureButton() {
    if (!btnEl) {
      btnEl = document.createElement('div');
      btnEl.className = 'fxfer-btn';
      btnEl.textContent = '⬇ 转存此文档';
      btnEl.addEventListener('click', onButtonClick);
      document.documentElement.appendChild(btnEl);
    }
    const ok = isDocUrl();
    btnEl.style.display = ok ? 'flex' : 'none';
    if (!ok) hidePanel();
  }

  function hidePanel() { if (panelEl) panelEl.remove(); panelEl = null; }

  function openPanel() {
    hidePanel();
    panelEl = document.createElement('div');
    panelEl.className = 'fxfer-panel';
    panelEl.innerHTML = `
      <div class="fxfer-head">
        <span class="fxfer-title">转存到我的飞书</span>
        <span class="fxfer-cancel" title="中止本次转存" style="cursor:pointer;color:#d83931;font-size:12px;margin-left:auto;margin-right:8px;">中止</span>
        <span class="fxfer-close" title="收起">×</span>
      </div>
      <div class="fxfer-status">准备中…</div>
      <div class="fxfer-bar"><div class="fxfer-bar-inner"></div></div>
      <div class="fxfer-detail"></div>
      <div class="fxfer-result"></div>`;
    panelEl.querySelector('.fxfer-close').addEventListener('click', hidePanel);
    panelEl.querySelector('.fxfer-cancel').addEventListener('click', () => { window.__fxferAbort = true; });
    document.documentElement.appendChild(panelEl);
    return {
      status(t, pct) {
        const s = panelEl.querySelector('.fxfer-status');
        if (typeof t === 'string') s.textContent = t;
        if (typeof pct === 'number') {
          panelEl.querySelector('.fxfer-bar-inner').style.width = Math.max(0, Math.min(100, pct)) + '%';
        }
      },
      detail(t) { panelEl.querySelector('.fxfer-detail').textContent = t || ''; },
      result(html) { panelEl.querySelector('.fxfer-result').innerHTML = html || ''; }
    };
  }

  async function onButtonClick() {
    if (running) return;
    if (!isDocUrl()) { alert('此页面不是飞书文档'); return; }
    running = true;
    btnEl.classList.add('fxfer-disabled');
    const ui = openPanel();
    try {
      const res = await transfer({
        progress: (t, pct) => ui.status(t, pct),
        detail: (t) => ui.detail(t)
      });
      const url = res.docUrl;
      ui.status('✅ 转存成功', 100);
      ui.result(`新文档：<a href="${url}" target="_blank">${url}</a>`);
      if (res.videos && res.videos.length) {
        ui.detail('正在打开新文档，把视频注入到文档里…');
        try {
          chrome.runtime.sendMessage({ type: 'fxfer-open-and-insert', docUrl: url, items: res.videos }, () => void chrome.runtime.lastError);
        } catch (e) { }
      }
    } catch (e) {
      ui.status('❌ ' + (e && e.message ? e.message : '转存失败'), 0);
      ui.detail(e && e.detail ? e.detail : '');
    } finally {
      running = false;
      btnEl.classList.remove('fxfer-disabled');
    }
  }

  /* ---------------- 1. 滚动收集正文块 ---------------- */

  async function waitForImgs(maxMs = 2500) {
    const pend = [...document.querySelectorAll(`${SCROLL_SEL} [data-block-id] img`)]
      .filter(im => !im.complete && im.getAttribute('src'));
    const t0 = Date.now();
    while (Date.now() - t0 < maxMs && pend.some(im => !im.complete)) await sleep(200);
  }

  async function collectDoc(onProgress) {
    const sc = getScroller();
    if (!sc) { const e = new Error('未找到文档容器（.bear-web-x-container）'); e.detail = '请确认当前是文档正文页，且已加载完成。'; throw e; }

    onProgress('等待文档加载…', 5);
    let prevSh = -1, stable = 0;
    for (let i = 0; i < 40; i++) {
      await sleep(1200);
      if (sc.scrollHeight === prevSh) { if (++stable >= 3) break; } else { stable = 0; prevSh = sc.scrollHeight; }
    }

    const store = new Map();
    const mediaSeen = new Set();
    const mediaMap = new Map();
    const tableOrder = new Map();                    // 表格块 → Y 顺序
    const cellStore = new Map();                     // 单元格 → {top,left,html}（跨快照累积）
    const cellOwner = new Map();                     // 单元格 → 所属表格 id
    const registerMedia = (mid, tok, name) => {
      if (mediaSeen.has(tok)) return false;
      mediaSeen.add(tok);
      mediaMap.set(String(mid), { token: tok, name: name, fileName: (name || 'file').replace(/[\\/:*?"<>|]/g, '_') });
      return true;
    };
    const orderY = new Map();                        // 块 → 文档内绝对 Y（用于按文档顺序合并）
    const imgDone = new Set();
    const grab = async () => {
      for (const e of [...document.querySelectorAll(`${SCROLL_SEL} [data-block-id]`)]) {
      const id = e.getAttribute('data-block-id');
      const type = e.getAttribute('data-block-type');
      if (type === 'page') continue;                    // 页面容器：含标题栏/作者/评论等 UI，整块丢弃
      if (type === 'table_cell') continue;               // 单元格由"表格分支"统一处理，避免重复
      if (e.closest && e.closest('[data-block-type="table_cell"]')) continue;   // 单元格内的块同理
      const cls = (e.className || '').toString();
      const rawLen = (e.outerHTML || '').length;
      if (rawLen > 400000) continue;                    // 异常巨大的块（通常是整页容器）跳过
      if (!orderY.has(id)) {
        try { orderY.set(id, Math.round(e.getBoundingClientRect().top + sc.scrollTop)); } catch (err) { }
      }

      const isMedia = type === 'view' || type === 'file' || /docx-view-block|docx-file-block/.test(cls);
      if (isMedia) {
        const token = findMediaToken(e) || (e.getAttribute('data-record-id') || '');
        if (!token) continue;                          // 素材还没渲染出 token，等下一轮滚动
        const name = mediaName(e);
        if (!registerMedia(id, token, name)) continue;  // 同一素材只处理一次（含 view/file 两层）
        store.set(id, '<div data-fxfer-media="' + id + '"></div>');
        continue;
      }

      let h;
      const isTable = type === 'table' || /docx-table-block/.test(cls);
      if (isTable) {
        if (!tableOrder.has(id)) tableOrder.set(id, orderY.has(id) ? orderY.get(id) : 0);
        for (const cell of e.querySelectorAll('[data-block-type="table_cell"], .docx-table_cell-block')) {
          const cid = cell.getAttribute('data-block-id');
          const r = cell.getBoundingClientRect();
          if (!cid || (r.width === 0 && r.height === 0)) continue;
          const cl = cell.cloneNode(true);
          extractNestedMedia(cl, registerMedia);
          cl.querySelectorAll(JUNK_SEL).forEach(n => n.remove());
          const html = cl.innerHTML;
          cellOwner.set(cid, id);
          const prev = cellStore.get(cid);
          if (!prev || html.length > prev.html.length) cellStore.set(cid, { top: Math.round(r.top), left: Math.round(r.left), html });
        }
        h = '<div data-fxfer-table="' + id + '"></div>';
      } else {
        h = cleanBlockHtml(e, registerMedia);
      }
      if (!imgDone.has(id) && /<img[^>]+src="(?!data:)/.test(h)) {
        h = await inlineBlockImages(e, h);
        if (!/<img[^>]+src="(?!data:)/.test(h)) imgDone.add(id);
      }
      const prev = store.get(id);
      if (!prev || h.length > prev.length) store.set(id, h);
      }
    };

    onProgress('采集正文（第 1 遍）…', 12);
    await grab();
    let lastTop = -1, stuck = 0, bottomStreak = 0;
    const t0 = Date.now();
    for (let i = 0; i < 420; i++) {
      if (window.__fxferAbort) throw new Error('已中止');
      if (Date.now() - t0 > 12 * 60 * 1000) break;          // 第一遍最多 12 分钟
      const prevSh = sc.scrollHeight;
      sc.scrollTop = Math.min(sc.scrollHeight, sc.scrollTop + Math.max(220, Math.floor(sc.clientHeight * 0.6)));
      await sleep(550);
      await scrollInnerContainers();
      await waitForImgs();
      await grab();
      onProgress('采集正文（滚动中）…', 12 + Math.min(28, 12 + (i / 600) * 28));
      const grew = sc.scrollHeight > prevSh;
      const atBottom = sc.scrollTop + sc.clientHeight >= sc.scrollHeight - 4;
      if (grew) { bottomStreak = 0; } else if (atBottom) { bottomStreak++; }
      if (sc.scrollTop === lastTop && !grew) stuck++; else stuck = 0;
      lastTop = sc.scrollTop;
      if (bottomStreak >= 4) { await sleep(800); await waitForImgs(); await grab(); break; }
      if (stuck > 14) break;
    }

    onProgress('补漏（第 2 遍）…', 42);
    sc.scrollTop = 0;
    await sleep(600);
    let b2 = 0;
    const t1 = Date.now();
    for (let i = 0; i < 320; i++) {
      if (window.__fxferAbort) throw new Error('已中止');
      if (Date.now() - t1 > 8 * 60 * 1000) break;            // 第二遍最多 8 分钟
      const prevSh2 = sc.scrollHeight;
      sc.scrollTop = Math.min(sc.scrollHeight, sc.scrollTop + Math.max(180, Math.floor(sc.clientHeight * 0.4)));
      await sleep(700);
      await scrollInnerContainers();
      await sleep(300);
      await waitForImgs();
      await grab();
      const grew2 = sc.scrollHeight > prevSh2;
      const atB2 = sc.scrollTop + sc.clientHeight >= sc.scrollHeight - 4;
      if (grew2) b2 = 0; else if (atB2) b2++;
      if (b2 >= 3) { await sleep(800); await waitForImgs(); await grab(); break; }
    }

    // 第三遍：逐个表格单元格强制滚入视口渲染（懒渲染的单元格/媒体块靠这一步补齐）
    onProgress('补漏（第 3 遍 · 单元格）…', 44);
    {
      const seenCells = new Set();
      const t2 = Date.now();
      for (let round = 0; round < 6; round++) {
        if (window.__fxferAbort) throw new Error('已中止');
        if (Date.now() - t2 > 4 * 60 * 1000) break;
        const cells = [...document.querySelectorAll('[data-block-type="table_cell"], .docx-table_cell-block')];
        let progressed = false;
        for (const cell of cells) {
          const cid = cell.getAttribute('data-block-id');
          if (!cid || seenCells.has(cid)) continue;
          seenCells.add(cid);
          progressed = true;
          try { cell.scrollIntoView({ block: 'center' }); } catch (e) { }
          await sleep(260);
          const cl = cell.cloneNode(true);
          extractNestedMedia(cl, registerMedia);
          cl.querySelectorAll(JUNK_SEL).forEach(n => n.remove());
          const html = cl.innerHTML;
          const r = cell.getBoundingClientRect();
          const ownerTbl = cell.closest('[data-block-type="table"]');
          if (ownerTbl) cellOwner.set(cid, ownerTbl.getAttribute('data-block-id'));
          const prev = cellStore.get(cid);
          if (!prev || html.length > prev.html.length) cellStore.set(cid, { top: Math.round(r.top), left: Math.round(r.left), html });
        }
        if (!progressed) break;
        await scrollInnerContainers();
        await sleep(400);
      }
    }

    const ids = [...store.keys()].sort((a, b) => {
      const ya = orderY.has(a) ? orderY.get(a) : 1e12;
      const yb = orderY.has(b) ? orderY.get(b) : 1e12;
      if (ya !== yb) return ya - yb;
      return (Number(a) || 0) - (Number(b) || 0);
    });
    const covered = new Set();
    let html = '';
    for (const id of ids) {
      if (covered.has(String(id))) continue;
      const h = store.get(String(id));
      html += h;
      const re = /data-block-id="(\d+)"/g; let m;
      while ((m = re.exec(h))) covered.add(m[1]);
      covered.add(String(id));
    }
    // 用跨快照累积的单元格组装表格
    const tableHtml = {};
    for (const [tid] of tableOrder) {
      const cells = [...cellStore.entries()].filter(([cid]) => (cellOwner.get(cid) || tid) === tid);
      if (!cells.length) { tableHtml[tid] = ''; continue; }
      const info = cells.map(([cid, c]) => ({ cid: cid, top: c.top, left: c.left, html: c.html }));
      info.sort((a, b) => a.top - b.top || a.left - b.left);
      const rows = [];
      for (const it of info) {
        const row = rows.find(x => Math.abs(x.top - it.top) < 24);
        if (row) row.cells.push(it); else rows.push({ top: it.top, cells: [it] });
      }
      // B 方案：单元格内的素材占位挪到表格外（飞书编辑器不接受拖入单元格，挪出来才能自动插入原生块）
      const mediaAfter = [];
      let out = '<table>';
      for (const r of rows) {
        r.cells.sort((a, b) => a.left - b.left);
        out += '<tr>' + r.cells.map(c => {
          let h = c.html || '';
          const ids = [...h.matchAll(/data-fxfer-media="(\d+)"/g)].map(x => x[1]);
          if (ids.length) {
            ids.forEach(id => mediaAfter.push(id));
            h = h.replace(/<div data-fxfer-media="\d+"><\/div>/g, '');
          }
          return '<td>' + h + '</td>';
        }).join('') + '</tr>';
      }
      out += '</table>';
      if (mediaAfter.length) {
        out += mediaAfter.map(id => '<div data-fxfer-media="' + id + '"></div>').join('');
      }
      tableHtml[tid] = out;
    }
    if (!html) { const e = new Error('未采集到文档内容'); e.detail = '页面可能尚未加载完成，请稍后重试。'; throw e; }
    for (const [tid, th] of Object.entries(tableHtml)) {
      html = html.split('<div data-fxfer-table="' + tid + '"></div>').join(th);
    }
    html = stripInvisible(html)
      .replace(/This document hasn't been mentioned by others yet\.?/gi, '')
      .replace(/本文档?尚未被他人提及。?/g, '');
    return { html, mediaMap };
  }

  /* ---------------- 2. 图片转 base64 内嵌 ---------------- */

  async function fetchAsDataURL(src) {
    const r = await fetch(src, src.startsWith('blob:') ? {} : { credentials: 'include' });
    if (!r.ok) { const e = new Error('HTTP ' + r.status); e.skip = true; throw e; }
    const bl = await r.blob();
    if (!bl.size || bl.size > MAX_IMG_BYTES) { const e = new Error('图片大小超限(' + bl.size + ')'); e.skip = true; throw e; }
    if (bl.type && !/^image\//.test(bl.type) && !src.startsWith('blob:')) { const e = new Error('非图片类型 ' + bl.type); e.skip = true; throw e; }
    return await new Promise((res, rej) => {
      const fr = new FileReader();
      fr.onload = () => res(fr.result);
      fr.onerror = () => rej(new Error('读取失败'));
      fr.readAsDataURL(bl);
    });
  }

  async function embedImages(html, onProgress) {
    const srcs = [...new Set([...html.matchAll(/<img[^>]+src="([^"]+)"/g)].map(x => x[1]))];
    const total = srcs.length;
    let ok = 0, fail = 0, i = 0;
    const map = {};
    for (const s of srcs) {
      i++;
      onProgress(`下载图片 ${i}/${total}…`, 45 + Math.round((i / Math.max(1, total)) * 25));
      if (s.startsWith('data:')) { map[s] = s; ok++; continue; }
      try {
        map[s] = await fetchAsDataURL(s);
        ok++;
      } catch (e1) {
        // 对 drive-stream 图片再试同源路径
        let done = false;
        if (s.includes('internal-api-drive-stream.feishu.cn')) {
          try { map[s] = await fetchAsDataURL(s.replace('https://internal-api-drive-stream.feishu.cn', '')); ok++; done = true; } catch (e2) { }
        }
        if (!done) { fail++; console.warn('[转存] 图片跳过:', s.slice(0, 80), e1.message); }
      }
    }
    let out = html;
    for (const [k, v] of Object.entries(map)) out = out.split('src="' + k + '"').join('src="' + v + '"');
    onProgress(`图片处理完成（成功 ${ok} / 跳过 ${fail}）`, 72);
    return { html: out, ok, fail };
  }

  /* ---------------- 3. 提交 + 轮询 ---------------- */

  function adler32(u8) {
    let a = 1, b = 0;
    for (let i = 0; i < u8.length; i++) { a = (a + u8[i]) % 65521; b = (b + a) % 65521; }
    return ((b << 16) | a) >>> 0;
  }

  async function fetchWithTimeout(url, opts, ms) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), ms);
    try {
      return await fetch(url, { ...opts, signal: ctl.signal });
    } finally {
      clearTimeout(timer);
    }
  }

  async function readCookie(name) {
    const m = document.cookie.match(new RegExp('(?:^|;)\\s*' + name + '=([^;]+)'));
    return m ? decodeURIComponent(m[1]) : '';
  }

  /* 分块上传：prepare → 逐块 merge_block(每块可独立重试) → finish → file_token */
  async function chunkedUpload(bytes, name, onProgress) {
    const requestId = randId();
    const H = { 'Request-Id': requestId, 'X-Request-Source': REQ_SOURCE };

    let pj = null, lastMsg = '';
    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const pr = await fetchWithTimeout('/space/api/box/upload/prepare/', {
          method: 'POST', credentials: 'include',
          headers: { ...H, 'Content-Type': 'application/json' },
          body: JSON.stringify({ mount_node_token: '', mount_point: 'wiki_confluence', name, size: bytes.length })
        }, 60000);
        pj = await pr.json();
        if (pj && pj.code === 0 && pj.data && pj.data.upload_id) break;
        lastMsg = 'HTTP ' + pr.status + ' code=' + (pj && pj.code) + ' ' + ((pj && pj.msg) || '');
        pj = null;
      } catch (e) { lastMsg = e.message; }
      if (attempt < 3) await sleep(2000 * attempt);
    }
    if (!pj) { const e = new Error('初始化上传失败：' + lastMsg); e.detail = '请检查网络后重试'; throw e; }
    const uploadId = pj.data.upload_id;
    const blockSize = pj.data.block_size || 4194304;
    const numBlocks = pj.data.num_blocks || Math.ceil(bytes.length / blockSize);

    for (let i = 0; i < numBlocks; i++) {
      const blk = bytes.subarray(i * blockSize, Math.min(bytes.length, (i + 1) * blockSize));
      let done = false, lastE = '';
      for (let attempt = 1; attempt <= 3 && !done; attempt++) {
        try {
          const r = await fetchWithTimeout('/space/api/box/stream/upload/merge_block/?upload_id=' + uploadId, {
            method: 'POST', credentials: 'include',
            headers: { ...H, 'Content-Type': 'application/octet-stream', 'x-seq-list': String(i), 'x-block-list-checksum': String(adler32(blk)), 'x-block-origin-size': String(blockSize) },
            body: blk
          }, 120000);
          const rj = await r.json();
          if (rj && rj.code === 0) done = true;
          else lastE = 'HTTP ' + r.status + ' ' + ((rj && rj.msg) || '');
        } catch (e) { lastE = e.message; }
        if (!done && attempt < 3) await sleep(2000 * attempt);
      }
      if (!done) {
        const e = new Error('分块上传失败（第 ' + (i + 1) + '/' + numBlocks + ' 块）：' + lastE);
        e.detail = '网络不稳定导致。可直接重试，会从当前进度继续。';
        throw e;
      }
      onProgress('上传分块 ' + (i + 1) + '/' + numBlocks + '…', 74 + Math.round(((i + 1) / numBlocks) * 12));
    }

    let fileToken = null, lastMsg2 = '';
    for (let attempt = 1; attempt <= 3 && !fileToken; attempt++) {
      try {
        const fr = await fetchWithTimeout('/space/api/box/upload/finish/', {
          method: 'POST', credentials: 'include',
          headers: { ...H, 'Content-Type': 'application/json' },
          body: JSON.stringify({ upload_id: uploadId, num_blocks: numBlocks })
        }, 60000);
        const fj = await fr.json();
        if (fj && fj.code === 0 && fj.data && fj.data.file_token) fileToken = fj.data.file_token;
        else lastMsg2 = 'HTTP ' + fr.status + ' code=' + (fj && fj.code) + ' ' + ((fj && fj.msg) || '');
      } catch (e) { lastMsg2 = e.message; }
      if (!fileToken && attempt < 3) await sleep(2000 * attempt);
    }
    if (!fileToken) { const e = new Error('完成上传失败：' + lastMsg2); e.detail = '请重试'; throw e; }
    return fileToken;
  }

  async function submitParseHtml(fullHtml, title, onProgress) {
    const bytes = new TextEncoder().encode(fullHtml);
    if (bytes.length > MAX_HTML_BYTES) {
      const e = new Error('文档过大（' + (bytes.length / 1048576).toFixed(1) + 'MB），暂不支持');
      e.detail = '可以试试删掉部分大图后再转存。';
      throw e;
    }
    onProgress('上传文件（分块）…', 73);
    const fileToken = await chunkedUpload(bytes, title + '.html', onProgress);

    const fd = new FormData();
    fd.append('description', '');
    fd.append('cover', COVER);
    fd.append('docType', 'docx');
    fd.append('originUrl', location.href);
    fd.append('clipVersion', CLIP_VERSION);
    fd.append('lang', 'zh-CN');
    fd.append('fileToken', fileToken);
    fd.append('title', title);

    let lastErr = null;
    for (let attempt = 1; attempt <= 3; attempt++) {
      const headers = { 'X-Request-Source': REQ_SOURCE };
      try {
        const csrf = await readCookie('_csrf_token');
        if (attempt > 1 && csrf) headers['X-CSRFToken'] = csrf;
        const r = await fetchWithTimeout('/space/api/parser/wiki/parse_html/', {
          method: 'POST', credentials: 'include', headers, body: fd
        }, 60000);
        const t = await r.text();
        if (r.status === 403 && /csrf/i.test(t)) continue;
        let j = null;
        try { j = JSON.parse(t); } catch (e) { }
        if (j && j.ticket) return j.ticket;
        if ((r.status === 502 || r.status === 504 || r.status === 429) && attempt < 3) {
          lastErr = new Error('HTTP ' + r.status);
        } else {
          const e = new Error('提交转存失败：' + (j && j.msg ? j.msg : 'HTTP ' + r.status));
          e.detail = t.slice(0, 300);
          throw e;
        }
      } catch (e) {
        if (e && e.detail) throw e;
        lastErr = e;
      }
      if (attempt < 3) { onProgress && onProgress('网络波动，自动重试…', 88); await sleep(2000 * attempt); }
    }
    const e = new Error('提交失败：网络多次中断，请检查网络后重试');
    e.detail = String(lastErr && (lastErr.message || lastErr)).slice(0, 200);
    throw e;
  }
  async function pollResult(ticket, onProgress) {
    for (let i = 0; i < 60; i++) {
      await sleep(2000);
      onProgress('等待飞书生成文档…', 88 + Math.min(10, i));
      const r = await fetch('/space/api/parser/wiki/clip/result?_r=' + Date.now() + '&ticket=' + ticket, { credentials: 'include' });
      const t = await r.text();
      if (!t || t.trim() === 'null' || t.trim() === '') continue;
      let j = null;
      try { j = JSON.parse(t); } catch (e) { throw new Error('结果解析失败：' + t.slice(0, 200)); }
      if (j.docUrl) return j.docUrl;
      throw new Error('转存未成功：' + (j.msg || j.status || t.slice(0, 200)));
    }
    throw new Error('等待超时：飞书生成文档时间过长，请稍后在「我的空间」查看是否已生成。');
  }

  /* ---------------- 主流程 ---------------- */

  async function transfer({ progress, detail }) {
    window.__fxferAbort = false;
    const sc = getScroller();
    if (!sc) { const e = new Error('未找到文档容器'); e.detail = '请刷新页面后重试。'; throw e; }

    const collected = await collectDoc((t, p) => progress(t, p));
    let html = collected.html;
    const title = docTitle();

    const tableCount = (html.match(/<table/g) || []).length;
    const imgCount = (html.match(/<img/g) || []).length;
    const mediaCount = (collected.mediaMap || new Map()).size;
    const failMedia = (html.match(/【素材】/g) || []).length;
    const mr = await resolveMediaBlocks(html, collected.mediaMap || new Map(), (t, p) => progress(t, p));
    html = mr.html;
    const uploadedVideos = mr.videos || [];

    const ie = await embedImages(html, (t, p) => progress(t, p));
    html = ie.html;

    const full = '<html><head><meta charset="utf-8"><title>' + title + '</title></head><body>' + html + '</body></html>';
    detail('HTML ' + (new Blob([full]).size / 1048576).toFixed(2) + 'MB（分块上传）…');

    const ticket = await submitParseHtml(full, title, (t, p) => progress(t, p));

    const docUrl = await pollResult(ticket, (t, p) => progress(t, p));
    try {
      detail('本次统计：图片 ' + imgCount + ' 张 / 表格 ' + tableCount + ' 个 / 视频附件 ' + mediaCount + ' 个'
        + (uploadedVideos.length ? '（视频 ' + uploadedVideos.length + ' 个将自动插入）' : '')
        + (failMedia ? '｜⚠️ ' + failMedia + ' 个素材抓取失败，建议重试' : ''));
    } catch (e) { }
    return { docUrl, videos: uploadedVideos };
  }

  /* ---------------- 视频注入配合（新文档页 / 后台 CDP 执行） ---------------- */

  async function locatePlaceholder(index) {
    const idx = (typeof index === 'number' && index >= 0) ? index : 0;
    // 只取"承载【视频】文字的小块"：大容器整篇文本里也含这三个字，会把坐标算飞
    const find = () => [...document.querySelectorAll('[data-block-id]')].filter(x => {
      const t = (x.innerText || '').replace(/\s+/g, ' ');
      return t.includes('【视频】') && t.trim().length < 160;
    });
    let els = [];
    for (let i = 0; i < 40; i++) {
      els = find();
      if (els.length > idx) break;
      const sc = document.querySelector('.bear-web-x-container');
      if (!sc) break;
      sc.scrollTop = Math.min(sc.scrollHeight, sc.scrollTop + Math.floor(sc.clientHeight * 0.7));
      await sleep(400);
    }
    const el = els[idx] || els[0];
    if (!el) {
      const sc = document.querySelector('.bear-web-x-container');
      if (!sc) return { found: false };
      sc.scrollTop = sc.scrollHeight;                 // 兜底：滚到文末，视频落在结尾
      await sleep(900);
      const blocks = [...document.querySelectorAll('[data-block-id]')];
      const last = blocks[blocks.length - 1];
      if (!last) return { found: false };
      const lr = last.getBoundingClientRect();
      return { found: false, x: Math.round(lr.left + lr.width / 2), y: Math.round(lr.top + lr.height / 2) };
    }
    // 飞书用自定义滚动容器，scrollIntoView 无效，直接设置容器的 scrollTop
    const sc = document.querySelector('.bear-web-x-container');
    try {
      if (sc) {
        const absTop = el.getBoundingClientRect().top + sc.scrollTop;
        sc.scrollTop = Math.max(0, Math.round(absTop - sc.clientHeight / 2));
      } else {
        el.scrollIntoView({ block: 'center' });
      }
    } catch (e) { }
    await sleep(1000);                      // 等滚动稳定后再量坐标
    const r = el.getBoundingClientRect();
    if (r.top < 40 || r.top > (window.innerHeight - 40)) {
      return { found: false, x: Math.round(r.left + r.width / 2), y: Math.max(60, Math.round(r.top + 10)) };
    }
    // 落点取段落左边缘内侧（占位段落里可能含链接，点在链接上编辑器不落光标）
    return { found: true, x: Math.round(r.left + 4), y: Math.round(r.top + Math.min(18, Math.max(8, r.height / 2))) };
  }

  function showInsertResult(count) {
    const ui = openPanel();
    ui.status('✅ 视频已作为播放块插入本文档（' + (count || 1) + ' 个）', 100);
    ui.result('视频已落在原文档对应位置附近；如需微调可直接拖动该视频块。');
  }

  try {
    chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
      if (!msg) return;
      if (msg.type === 'fxfer-locate') { locatePlaceholder(msg.index).then(r => sendResponse(r || { found: false })); return true; }
      if (msg.type === 'fxfer-inserted') { showInsertResult(msg.count); }
    });
  } catch (e) { }

  /* ---------------- 启动 ---------------- */

  const boot = () => ensureButton();
  boot();
  // 飞书是 SPA：轮询监听路由变化，切换页面时更新按钮状态
  setInterval(boot, 1500);
})();

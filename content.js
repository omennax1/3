(() => {
  'use strict';
  if (window.__videoGrabContentLoaded) return;
  window.__videoGrabContentLoaded = true;

  let enabled = true;
  let host = null;
  let shadow = null;
  let mutationObserver = null;
  let positionTimer = null;
  const buttons = new Map();
  const iconSvg = '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 3v11m0 0 4.5-4.5M12 14l-4.5-4.5M5 17v3h14v-3" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/></svg>';

  function createHost() {
    if (host && host.isConnected) return;
    host = document.createElement('div');
    host.id = 'videograb-overlay-root';
    host.style.cssText = 'all:initial!important;position:fixed!important;inset:0!important;width:0!important;height:0!important;z-index:2147483647!important;pointer-events:none!important;';
    shadow = host.attachShadow({ mode: 'open' });
    const style = document.createElement('style');
    style.textContent = `
      :host { all: initial; }
      .vg-btn { all: initial; box-sizing:border-box; position:fixed; display:flex; align-items:center; justify-content:center;
        width:30px; height:30px; border:1px solid rgba(255,255,255,.26); border-radius:8px;
        background:rgba(18,20,24,.88); color:#fff; box-shadow:0 2px 10px rgba(0,0,0,.42);
        cursor:pointer; pointer-events:auto; opacity:.88; transition:opacity .12s, transform .12s, background .12s;
        font:12px/1 Arial,sans-serif; padding:0; margin:0; outline:none; }
      .vg-btn:hover { opacity:1; background:#1267db; transform:scale(1.06); }
      .vg-btn:focus-visible { outline:2px solid white; outline-offset:2px; }
      .vg-btn svg { width:17px; height:17px; display:block; }
      .vg-btn[data-busy="1"] { background:#7a4b00; }
      .vg-btn[data-error="1"] { background:#a32626; }
      .vg-btn .vg-label { display:none; }
    `;
    shadow.appendChild(style);
    (document.documentElement || document.body).appendChild(host);
  }

  function setButtonStatus(button, text, kind = '') {
    if (!button) return;
    button.title = text;
    if (kind === 'busy') {
      button.dataset.busy = '1';
      delete button.dataset.error;
      button.innerHTML = '<span style="font:700 11px Arial,sans-serif;color:#fff">…</span>';
    } else if (kind === 'error') {
      delete button.dataset.busy;
      button.dataset.error = '1';
      button.innerHTML = '<span style="font:700 14px Arial,sans-serif;color:#fff">!</span>';
    } else if (kind === 'ok') {
      delete button.dataset.busy;
      delete button.dataset.error;
      button.innerHTML = '<span style="font:700 14px Arial,sans-serif;color:#fff">✓</span>';
    } else {
      delete button.dataset.busy;
      delete button.dataset.error;
      button.innerHTML = iconSvg;
    }
  }

  function candidateFrom(rawUrl, extra = {}) {
    if (!rawUrl || typeof rawUrl !== 'string') return null;
    let url;
    try { url = new URL(rawUrl, document.baseURI); } catch (_) { return null; }
    if (!/^https?:$/.test(url.protocol)) return null;
    return {
      url: url.href,
      type: extra.type || '',
      width: Number(extra.width) || 0,
      height: Number(extra.height) || 0,
      explicit: !!extra.explicit,
      observedAt: Number(extra.observedAt) || 0
    };
  }

  function collectCandidates(video) {
    const out = [];
    const add = item => { if (item && !out.some(x => x.url === item.url)) out.push(item); };
    add(candidateFrom(video.currentSrc, { explicit: true, width: video.videoWidth, height: video.videoHeight }));
    add(candidateFrom(video.src, { explicit: true, width: video.videoWidth, height: video.videoHeight }));
    for (const source of Array.from(video.querySelectorAll('source[src]'))) {
      add(candidateFrom(source.src, { type: source.type || '', explicit: true, width: Number(source.getAttribute('width')) || video.videoWidth, height: Number(source.getAttribute('height')) || video.videoHeight }));
    }
    // Some players keep media URLs only in resource timing, not in <video src>.
    try {
      for (const entry of performance.getEntriesByType('resource')) {
        const u = entry.name;
        // Page-wide timing data may contain the previous video's MP4 URLs on
        // SPA sites. The clicked <video> supplies its own direct source above;
        // retain only timestamped manifests as a fallback for blob: players.
        if (/\.(m3u8|mpd)(?:$|[?#])/i.test(u)) {
          const observedAt = (Number(performance.timeOrigin) || Date.now()) + Number(entry.startTime || 0);
          add(candidateFrom(u, { observedAt }));
        }
      }
    } catch (_) {}
    return out.slice(0, 180);
  }

  function positionOne(video, button) {
    if (!video.isConnected) {
      button.remove(); buttons.delete(video); return;
    }
    const r = video.getBoundingClientRect();
    const cs = getComputedStyle(video);
    const visible = cs.display !== 'none' && cs.visibility !== 'hidden' && Number(cs.opacity || 1) > 0 &&
      r.width >= 90 && r.height >= 50 && r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth;
    button.style.display = visible && enabled ? 'flex' : 'none';
    if (visible) {
      button.style.left = Math.max(2, Math.min(innerWidth - 34, r.left + 8)) + 'px';
      button.style.top = Math.max(2, Math.min(innerHeight - 34, r.top + 8)) + 'px';
    }
  }

  function updatePositions() {
    for (const [video, button] of buttons) positionOne(video, button);
  }

  function attachVideo(video) {
    if (!enabled || !(video instanceof HTMLVideoElement) || buttons.has(video)) return;
    createHost();
    const button = document.createElement('button');
    button.className = 'vg-btn';
    button.type = 'button';
    button.setAttribute('aria-label', 'Скачать видео');
    button.title = 'VideoGrab: скачать видео';
    button.innerHTML = iconSvg;
    button.addEventListener('pointerdown', event => {
      event.preventDefault(); event.stopPropagation();
    }, true);
    button.addEventListener('click', event => {
      event.preventDefault(); event.stopPropagation();
      if (event.stopImmediatePropagation) event.stopImmediatePropagation();
      if (button.dataset.busy === '1') return;
      setButtonStatus(button, 'Ищем лучший доступный источник…', 'busy');
      const requestId = (crypto && crypto.randomUUID) ? crypto.randomUUID() : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
      button.dataset.taskId = requestId;
      const payload = {
        action: 'vgStartDownload',
        requestId,
        pageUrl: location.href,
        pageTitle: document.title || 'video',
        videoInfo: { width: video.videoWidth || 0, height: video.videoHeight || 0 },
        candidates: collectCandidates(video)
      };
      try {
        chrome.runtime.sendMessage(payload, response => {
          const lastError = chrome.runtime.lastError;
          if (lastError) {
            setButtonStatus(button, 'Не удалось связаться с VideoGrab. Перезагрузите вкладку.', 'error');
            return;
          }
          if (response && response.accepted) setButtonStatus(button, response.message || 'Обработка источника…', 'busy');
          else setButtonStatus(button, (response && response.message) || 'Не удалось начать загрузку', 'error');
        });
      } catch (error) {
        setButtonStatus(button, 'Ошибка запуска загрузки', 'error');
      }
    }, true);
    shadow.appendChild(button);
    buttons.set(video, button);
    positionOne(video, button);
  }

  function scan(root = document) {
    if (!enabled) return;
    if (root instanceof HTMLVideoElement) attachVideo(root);
    if (root.querySelectorAll) root.querySelectorAll('video').forEach(attachVideo);
  }

  function setEnabled(next) {
    enabled = !!next;
    if (enabled) {
      createHost();
      scan();
      updatePositions();
      if (!mutationObserver) {
        mutationObserver = new MutationObserver(records => {
          for (const record of records) {
            for (const node of record.addedNodes) if (node.nodeType === 1) scan(node);
          }
        });
        mutationObserver.observe(document.documentElement || document, { childList: true, subtree: true });
      }
      if (!positionTimer) positionTimer = setInterval(updatePositions, 500);
    } else {
      for (const button of buttons.values()) button.remove();
      buttons.clear();
      if (host) host.remove();
      host = null; shadow = null;
      if (mutationObserver) { mutationObserver.disconnect(); mutationObserver = null; }
      if (positionTimer) { clearInterval(positionTimer); positionTimer = null; }
    }
  }

  chrome.runtime.onMessage.addListener(message => {
    if (message && message.type === 'vgEnabled') setEnabled(message.enabled);
    if (message && message.type === 'vgStatus') {
      // Route progress only to the button which started this exact task.
      for (const button of buttons.values()) {
        if (button.dataset.taskId === message.requestId) {
          const status = message.message || '';
          if (message.state === 'error') setButtonStatus(button, status, 'error');
          else if (message.state === 'complete') setButtonStatus(button, status, 'ok');
          else setButtonStatus(button, status, 'busy');
          if (message.state === 'complete' || message.state === 'error') {
            setTimeout(() => { if (button.isConnected && button.dataset.taskId === message.requestId) { setButtonStatus(button, 'VideoGrab: скачать видео'); delete button.dataset.taskId; } }, 3500);
          }
          break;
        }
      }
    }
  });

  chrome.storage.onChanged.addListener((changes, areaName) => {
    if (areaName === 'local' && changes.enabled) setEnabled(changes.enabled.newValue !== false);
  });

  chrome.runtime.sendMessage({ action: 'vgGetEnabled' }, response => {
    if (chrome.runtime.lastError) { setEnabled(true); return; }
    setEnabled(!response || response.enabled !== false);
  });
  window.addEventListener('scroll', updatePositions, true);
  window.addEventListener('resize', updatePositions, true);
  document.addEventListener('loadedmetadata', event => { if (event.target instanceof HTMLVideoElement) scan(event.target); }, true);
})();

'use strict';

const MAX_CANDIDATES = 180;
const MAX_SEGMENTS = 4000;
const MAX_TOTAL_BYTES = 1500 * 1024 * 1024;
const MAX_SEGMENT_BYTES = 180 * 1024 * 1024;
const MIN_DIRECT_BYTES = 512 * 1024;
const DIRECT_EXTS = new Set(['mp4', 'm4v', 'mov', 'webm', 'mkv', 'avi', 'ogv', 'mpg', 'mpeg']);
const SEGMENT_EXTS = new Set(['ts', 'm4s', 'cmfv', 'cfmv', 'cmfa', 'cfma', 'ismv', 'isma', 'mp4s']);
const observedByTab = new Map();
// Successful downloads establish a boundary: on the next click, non-explicit
// candidates captured before that boundary belong to an earlier playback.
const lastSuccessfulDownloadAt = new Map();
const successfulSourceUrlsByTab = new Map();
const downloadTasks = new Map();
const objectUrlsByDownload = new Map();
let isEnabled = true;

chrome.storage.local.get({ enabled: true }, result => {
  isEnabled = result.enabled !== false;
  updateActionIcon();
});

chrome.browserAction.onClicked.addListener(() => {
  isEnabled = !isEnabled;
  chrome.storage.local.set({ enabled: isEnabled });
  updateActionIcon();
  chrome.tabs.query({}, tabs => {
    for (const tab of tabs) {
      if (tab.id == null) continue;
      chrome.tabs.sendMessage(tab.id, { type: 'vgEnabled', enabled: isEnabled }, () => void chrome.runtime.lastError);
    }
  });
});

function updateActionIcon() {
  const path = isEnabled
    ? { 16: 'icons/on16.png', 32: 'icons/on32.png' }
    : { 16: 'icons/off16.png', 32: 'icons/off32.png' };
  chrome.browserAction.setIcon({ path });
  chrome.browserAction.setTitle({ title: `VideoGrab — ${isEnabled ? 'ВКЛ: нажмите, чтобы выключить' : 'ВЫКЛ: нажмите, чтобы включить'}` });
  chrome.browserAction.setBadgeText({ text: isEnabled ? 'ON' : 'OFF' });
  chrome.browserAction.setBadgeBackgroundColor({ color: isEnabled ? '#16803c' : '#777777' });
}

chrome.tabs.onRemoved.addListener(tabId => {
  observedByTab.delete(tabId);
  lastSuccessfulDownloadAt.delete(tabId);
  successfulSourceUrlsByTab.delete(tabId);
});

function mediaUrlLikely(url) {
  return /\.(m3u8|mpd|mp4|m4v|mov|webm|mkv|avi|ts|m4s|cmfv|cfmv|cmfa|cfma|ismv|isma|aac|mp3|m4a|mp4v)(?:$|[?#])/i.test(url || '');
}
function getHeader(headers, name) {
  const header = (headers || []).find(h => h.name && h.name.toLowerCase() === name.toLowerCase());
  return header ? String(header.value || '') : '';
}
function rememberRequest(details, responseHeaders) {
  if (details.tabId < 0 || !details.url || !/^https?:/i.test(details.url)) return;
  const contentType = getHeader(responseHeaders, 'content-type').split(';')[0].trim().toLowerCase();
  const mediaType = /^video\//.test(contentType) || /^audio\//.test(contentType) ||
    /mpegurl|dash\+xml|mp2t|iso\.segment|mp4/i.test(contentType);
  if (!mediaUrlLikely(details.url) && details.type !== 'media' && !mediaType) return;
  if (!observedByTab.has(details.tabId)) observedByTab.set(details.tabId, []);
  const list = observedByTab.get(details.tabId);
  const old = list.findIndex(x => x.url === details.url && x.frameId === details.frameId);
  const record = { url: details.url, type: details.type || '', contentType, contentLength: Number(getHeader(responseHeaders, 'content-length') || 0), contentRange: getHeader(responseHeaders, 'content-range'), statusCode: Number(details.statusCode || 0), frameId: details.frameId || 0, time: Date.now() };
  if (old >= 0) list.splice(old, 1);
  list.push(record);
  while (list.length > 1000) list.shift();
}
try {
  chrome.webRequest.onHeadersReceived.addListener(
    details => rememberRequest(details, details.responseHeaders),
    { urls: ['<all_urls>'] }, ['responseHeaders']
  );
  chrome.webRequest.onCompleted.addListener(
    details => rememberRequest(details, details.responseHeaders),
    { urls: ['<all_urls>'] }, ['responseHeaders']
  );
} catch (_) {}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!message) return;
  if (message.action === 'vgGetEnabled') {
    sendResponse({ enabled: isEnabled });
    return;
  }
  if (message.action === 'vgStartDownload') {
    if (!isEnabled) { sendResponse({ accepted: false, message: 'VideoGrab выключен — нажмите на иконку расширения.' }); return; }
    const tabId = sender.tab && sender.tab.id;
    if (tabId == null) { sendResponse({ accepted: false, message: 'Не удалось определить вкладку.' }); return; }
    const frameId = sender.frameId || 0;
    const payload = {
      tabId, frameId, requestId: String(message.requestId || ''),
      pageUrl: String(message.pageUrl || ''),
      pageTitle: String(message.pageTitle || 'video'),
      videoInfo: message.videoInfo || {},
      candidates: Array.isArray(message.candidates) ? message.candidates.slice(0, MAX_CANDIDATES) : []
    };
    sendResponse({ accepted: true, message: 'Ищем прямой файл и плейлисты…' });
    startTask(payload).catch(error => notify(payload, 'error', `Ошибка: ${shortError(error)}`));
    return;
  }
});

function notify(task, state, message) {
  if (!task || task.tabId == null) return;
  chrome.tabs.sendMessage(task.tabId, { type: 'vgStatus', requestId: task.requestId || '', state, message }, { frameId: task.frameId || 0 }, () => void chrome.runtime.lastError);
}
function shortError(error) {
  const s = error && error.message ? error.message : String(error || 'неизвестная ошибка');
  return s.length > 160 ? s.slice(0, 157) + '…' : s;
}
function safeBaseName(value) {
  return String(value || 'video').replace(/[\\/:*?"<>|\x00-\x1F]/g, '_').replace(/[. ]+$/g, '').trim().slice(0, 120) || 'video';
}
function pathExt(url) {
  try { return (new URL(url)).pathname.match(/\.([a-z0-9]{2,5})$/i)?.[1]?.toLowerCase() || ''; }
  catch (_) { return ''; }
}
function urlLooksLikeSegment(candidate) {
  const raw = String(candidate && candidate.url || '');
  let u;
  try { u = new URL(raw); } catch (_) { return true; }
  const ext = pathExt(raw);
  if (SEGMENT_EXTS.has(ext)) return true;
  if (/^bytes\s+\d+-\d+\/\d+$/i.test(String(candidate.contentRange || '').trim())) return true;
  const queryKeys = new Set(Array.from(u.searchParams.keys()).map(k => k.toLowerCase()));
  if (['range', 'sq', 'segment', 'seg', 'chunk', 'part', 'offset', 'startbyte', 'endbyte', 'fragment', 'frag', '_hls_msn', '_hls_part'].some(k => queryKeys.has(k))) return true;
  if (/\/(?:segment|segments|chunk|chunks|fragment|fragments)[/_-]?\d+(?:\.|\/|$)/i.test(u.pathname)) return true;
  const ct = String(candidate.contentType || '').toLowerCase();
  if (/video\/(?:mp2t|iso\.segment|mp4\.segment)|application\/(?:mp2t|iso\.segment)/i.test(ct)) return true;
  return false;
}
function looksLikeVideoFileType(contentType, ext) {
  const ct = String(contentType || '').split(';')[0].trim().toLowerCase();
  if (!ct || ct === 'application/octet-stream' || ct === 'binary/octet-stream') return DIRECT_EXTS.has(ext);
  if (/^(?:audio\/|application\/(?:vnd\.apple\.mpegurl|x-mpegurl|dash\+xml))/.test(ct)) return false;
  if (/^(?:video\/(?:mp4|webm|quicktime|x-matroska|ogg|mpeg|x-msvideo)|application\/(?:mp4|ogg|x-matroska))$/.test(ct)) return true;
  return false;
}
function classify(candidate) {
  const url = candidate.url || '';
  const ext = pathExt(url);
  const ct = String(candidate.contentType || candidate.type || '').toLowerCase();
  if (ext === 'm3u8' || /mpegurl|x-mpegurl/.test(ct)) return 'hls';
  if (ext === 'mpd' || /dash\+xml/.test(ct)) return 'dash';
  if (urlLooksLikeSegment(candidate)) return 'segment';
  if (DIRECT_EXTS.has(ext)) return 'direct';
  if (/^video\/(?:mp4|webm|quicktime|x-matroska|ogg|mpeg|x-msvideo)(?:;|$)/.test(ct)) return 'direct';
  return 'other';
}
function qualityScore(candidate, videoInfo) {
  const w = Number(candidate.width || videoInfo.width || 0);
  const h = Number(candidate.height || videoInfo.height || 0);
  let score = w * h;
  const u = candidate.url || '';
  const match = u.match(/(?:^|[^0-9])(4320|2160|1440|1080|720|576|480|360|240)p?(?:[^0-9]|$)/i);
  if (match) score = Math.max(score, Number(match[1]) * Number(match[1]) * 1.2);
  if (candidate.explicit) score += 500;
  return score;
}
function combineCandidates(payload) {
  const out = [];
  const successfulUrls = successfulSourceUrlsByTab.get(payload.tabId) || new Set();
  const lastSuccessAt = lastSuccessfulDownloadAt.get(payload.tabId) || 0;
  const push = item => {
    if (!item || typeof item.url !== 'string' || !/^https?:/i.test(item.url)) return;
    const explicit = !!item.explicit;
    // Non-explicit URLs come from page-wide timing/network observations. Never
    // re-use those from a completed earlier download; current video element URLs
    // remain eligible because the clicked element is the strongest signal.
    if (!explicit && (successfulUrls.has(item.url) || (Number(item.observedAt || item.time || 0) > 0 && Number(item.observedAt || item.time || 0) <= lastSuccessAt))) return;
    const existingIndex = out.findIndex(x => x.url === item.url);
    if (existingIndex >= 0) {
      const old = out[existingIndex];
      out[existingIndex] = {
        ...old, ...item,
        type: item.type || old.type || '',
        contentType: item.contentType || old.contentType || '',
        width: Number(item.width || old.width || 0),
        height: Number(item.height || old.height || 0),
        contentLength: Number(item.contentLength || old.contentLength || 0),
        contentRange: item.contentRange || old.contentRange || '',
        observedAt: Math.max(Number(item.observedAt || item.time || 0), Number(old.observedAt || old.time || 0)),
        explicit: !!(item.explicit || old.explicit)
      };
      return;
    }
    out.push({ ...item, contentType: item.contentType || '', observedAt: Number(item.observedAt || item.time || 0) });
  };
  (payload.candidates || []).forEach(push);
  const observed = observedByTab.get(payload.tabId) || [];
  // A short freshness window avoids accidentally selecting the previous
  // playback's requests on single-page apps where the tab URL never changes.
  const now = Date.now();
  const fresh = observed.filter(x => now - x.time < 5 * 60 * 1000 && x.time > lastSuccessAt && !successfulUrls.has(x.url));
  const sameFrame = fresh.filter(x => x.frameId === payload.frameId);
  const base = (sameFrame.length ? sameFrame : fresh).sort((a, b) => b.time - a.time);
  base.forEach(x => push({
    url: x.url, contentType: x.contentType, type: x.type, explicit: false,
    contentLength: x.contentLength, contentRange: x.contentRange, statusCode: x.statusCode,
    observedAt: x.time
  }));
  return out.slice(0, MAX_CANDIDATES);
}
function rememberSuccessfulSource(payload, url) {
  const tabId = payload && payload.tabId;
  if (tabId == null) return;
  lastSuccessfulDownloadAt.set(tabId, Date.now());
  if (url) {
    if (!successfulSourceUrlsByTab.has(tabId)) successfulSourceUrlsByTab.set(tabId, new Set());
    const set = successfulSourceUrlsByTab.get(tabId);
    set.add(url);
    while (set.size > 400) set.delete(set.values().next().value);
  }
}
async function startTask(payload) {
  if (!isEnabled) throw new Error('VideoGrab выключен');
  notify(payload, 'busy', 'Проверяем источники видео…');
  const candidates = combineCandidates(payload);
  if (!candidates.length) throw new Error('источник видео не найден. Запустите видео и нажмите кнопку ещё раз.');

  const allDirect = candidates.filter(c => classify(c) === 'direct' && !urlLooksLikeSegment(c));
  const explicitDirect = allDirect.filter(c => c.explicit);
  // If the clicked video exposes its own direct URL, do not let a larger stale
  // URL from the page-wide request cache override it.
  const direct = explicitDirect.length ? explicitDirect : allDirect;
  const playlists = candidates.filter(c => classify(c) === 'hls').sort((a,b) => Number(b.explicit) - Number(a.explicit) || Number(b.observedAt || 0) - Number(a.observedAt || 0) || qualityScore(b, payload.videoInfo) - qualityScore(a, payload.videoInfo));
  const dashes = candidates.filter(c => classify(c) === 'dash').sort((a,b) => Number(b.explicit) - Number(a.explicit) || Number(b.observedAt || 0) - Number(a.observedAt || 0) || qualityScore(b, payload.videoInfo) - qualityScore(a, payload.videoInfo));
  notify(payload, 'busy', `Проверяем до ${Math.min(direct.length, 24)} прямых ссылок на полноразмерный файл…`);
  const probes = await mapLimit(direct.slice(0, 24), 4, async (item, index) => {
    const probe = await probeDirectCandidate(item, payload.pageUrl);
    return probe ? { ...probe, item, index } : null;
  });
  const validDirect = probes.filter(Boolean).sort((a,b) => {
    const explicitDelta = Number(!!b.item.explicit) - Number(!!a.item.explicit);
    if (explicitDelta) return explicitDelta;
    // Within URLs tied to the clicked element, prefer the largest full file.
    // When only page-wide observations exist, prefer the newest media request
    // first so a previous SPA playback cannot win solely by being larger.
    if (!a.item.explicit && !b.item.explicit) {
      const freshDelta = Number(b.item.observedAt || 0) - Number(a.item.observedAt || 0);
      if (freshDelta) return freshDelta;
    }
    return (b.bytes || 0) - (a.bytes || 0) || qualityScore(b.item, payload.videoInfo) - qualityScore(a.item, payload.videoInfo) || a.index - b.index;
  });

  // Prefer master HLS playlists; media playlists may be video-only renditions of a master.
  const rankedPlaylists = await rankHlsPlaylists(playlists.slice(0, 12), payload);
  const fallback = {
    payload,
    directCandidates: validDirect,
    playlists: rankedPlaylists,
    dashes: dashes.slice(0, 8),
    tried: new Set()
  };
  await runFallback(fallback, 0);
}
async function mapLimit(items, limit, worker) {
  const results = new Array(items.length);
  let next = 0;
  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (true) {
      const index = next++;
      if (index >= items.length) return;
      try { results[index] = await worker(items[index], index); }
      catch (_) { results[index] = null; }
    }
  });
  await Promise.all(runners);
  return results;
}
async function rankHlsPlaylists(items, payload) {
  const ranked = await mapLimit(items, 4, async (item, index) => {
    try {
      const result = await fetchText(item.url, payload.pageUrl);
      const isMaster = /#EXT-X-STREAM-INF:/i.test(result.text);
      const hasAudioGroup = /#EXT-X-MEDIA:[^\r\n]*TYPE=AUDIO/i.test(result.text);
      const variantCount = (result.text.match(/#EXT-X-STREAM-INF:/ig) || []).length;
      return { item, index, isMaster, hasAudioGroup, variantCount };
    } catch (_) { return { item, index, isMaster: false, hasAudioGroup: false, variantCount: 0 }; }
  });
  ranked.sort((a,b) => Number(b.isMaster) - Number(a.isMaster) || b.variantCount - a.variantCount || Number(a.hasAudioGroup) - Number(b.hasAudioGroup) || a.index - b.index);
  return ranked.map(x => x.item);
}
function extensionForType(type) {
  const t = String(type || '').toLowerCase();
  if (t.includes('webm')) return 'webm';
  if (t.includes('quicktime')) return 'mov';
  if (t.includes('matroska')) return 'mkv';
  if (t.includes('ogg')) return 'ogv';
  if (t.includes('mpeg')) return 'mpg';
  return 'mp4';
}
async function probeDirectCandidate(candidate, referrer) {
  const url = candidate.url;
  if (urlLooksLikeSegment(candidate)) return null;
  let headMeta = null;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 7000);
  try {
    const response = await fetch(url, {
      method: 'HEAD', credentials: 'include', redirect: 'follow',
      referrer: safeReferrer(referrer), signal: controller.signal
    });
    headMeta = {
      status: response.status,
      bytes: Number(response.headers.get('content-length') || 0),
      contentType: (response.headers.get('content-type') || candidate.contentType || '').split(';')[0].trim().toLowerCase(),
      contentRange: response.headers.get('content-range') || ''
    };
  } catch (_) {
    headMeta = null;
  } finally { clearTimeout(timeout); }

  const ext = pathExt(url);
  if (headMeta && headMeta.status >= 200 && headMeta.status < 300 && !headMeta.contentRange &&
      !/^(?:video\/mp2t|video\/iso\.segment|video\/mp4\.segment|application\/vnd\.apple\.mpegurl|application\/dash\+xml)/i.test(headMeta.contentType) &&
      looksLikeVideoFileType(headMeta.contentType || candidate.contentType, ext) && headMeta.bytes >= MIN_DIRECT_BYTES) {
    return { bytes: headMeta.bytes, contentType: headMeta.contentType || candidate.contentType || '', ext };
  }
  // Some servers reject HEAD but correctly implement byte ranges. Ask for only one byte;
  // never use this probe to decide that a 100–200 KB segment is a complete media file.
  const probeController = new AbortController();
  const probeTimeout = setTimeout(() => probeController.abort(), 7000);
  try {
    const response = await fetch(url, {
      method: 'GET', headers: { Range: 'bytes=0-0' }, credentials: 'include',
      redirect: 'follow', referrer: safeReferrer(referrer), signal: probeController.signal
    });
    const contentType = (response.headers.get('content-type') || (headMeta && headMeta.contentType) || candidate.contentType || '').split(';')[0].trim().toLowerCase();
    const contentRange = response.headers.get('content-range') || '';
    const contentLength = Number(response.headers.get('content-length') || 0);
    const totalMatch = contentRange.match(/^bytes\s+0-\d+\/(\d+)$/i);
    const total = totalMatch ? Number(totalMatch[1]) : (response.status === 200 ? contentLength : 0);
    const mediaTypeOk = !/^(?:video\/mp2t|video\/iso\.segment|video\/mp4\.segment|application\/vnd\.apple\.mpegurl|application\/dash\+xml|audio\/)/i.test(contentType) &&
      looksLikeVideoFileType(contentType, ext);
    // Cancel the stream immediately in case a server ignores Range.
    try {
      if (response.body && response.body.getReader) {
        const reader = response.body.getReader();
        await reader.read();
        await reader.cancel();
      } else { await response.arrayBuffer(); }
    } catch (_) {}
    if (mediaTypeOk && total >= MIN_DIRECT_BYTES && !urlLooksLikeSegment(candidate) &&
        ((response.status === 206 && totalMatch) || (response.status === 200 && contentLength >= MIN_DIRECT_BYTES))) {
      return { bytes: total, contentType, ext };
    }
  } catch (_) {
    // An unprobeable URL is not assumed to be a complete video; manifests are tried instead.
  } finally { clearTimeout(probeTimeout); }
  return null;
}
function safeReferrer(value) {
  try { const u = new URL(value); return /^https?:$/.test(u.protocol) ? u.href : undefined; }
  catch (_) { return undefined; }
}
function startUrlDownload(url, filename, taskInfo) {
  return new Promise(resolve => {
    try {
      chrome.downloads.download({ url, filename, conflictAction: 'uniquify', saveAs: false }, downloadId => {
        if (chrome.runtime.lastError || downloadId == null) {
          notify(taskInfo.payload, 'busy', `Прямая загрузка не сработала: ${chrome.runtime.lastError?.message || 'ошибка'}. Пробуем плейлист…`);
          resolve(false); return;
        }
        downloadTasks.set(downloadId, taskInfo);
        notify(taskInfo.payload, 'busy', 'Загрузка добавлена в список загрузок…');
        resolve(true);
      });
    } catch (_) { resolve(false); }
  });
}

chrome.downloads.onChanged.addListener(delta => {
  if (!delta || delta.id == null) return;
  if (delta.state && delta.state.current === 'complete') {
    const task = downloadTasks.get(delta.id);
    if (task && task.direct && task.fallback) {
      chrome.downloads.search({ id: delta.id }, items => {
        const item = items && items[0];
        const actual = Number(item && (item.bytesReceived || item.fileSize) || 0);
        if (isUndersizedDownload(actual, Number(task.expectedBytes || 0))) {
          downloadTasks.delete(delta.id);
          // Remove the broken fragment instead of leaving a misleading .mp4/.cfmv file.
          chrome.downloads.removeFile(delta.id, () => {
            void chrome.runtime.lastError;
            chrome.downloads.erase({ id: delta.id }, () => void chrome.runtime.lastError);
          });
          notify(task.payload, 'busy', `Получился неполный фрагмент (${formatBytes(actual)}); удаляем его и пробуем другой источник…`);
          runFallback(task.fallback, Number(task.candidateIndex || 0) + 1)
            .catch(err => notify(task.payload, 'error', shortError(err)));
          return;
        }
        rememberSuccessfulSource(task.payload, task.candidateUrl || '');
        notify(task.payload, 'complete', 'Видео скачано');
        downloadTasks.delete(delta.id);
      });
    } else if (task) {
      rememberSuccessfulSource(task.payload, task.candidateUrl || '');
      notify(task.payload, 'complete', 'Видео скачано');
      downloadTasks.delete(delta.id);
    }
    const blobUrl = objectUrlsByDownload.get(delta.id);
    if (blobUrl) { setTimeout(() => URL.revokeObjectURL(blobUrl), 30000); objectUrlsByDownload.delete(delta.id); }
  }
  if (delta.state && delta.state.current === 'interrupted') {
    const task = downloadTasks.get(delta.id);
    if (task) {
      downloadTasks.delete(delta.id);
      const blobUrl = objectUrlsByDownload.get(delta.id);
      if (blobUrl) { URL.revokeObjectURL(blobUrl); objectUrlsByDownload.delete(delta.id); }
      if (task.direct && task.fallback) {
        runFallback(task.fallback, Number(task.candidateIndex || 0) + 1).catch(err => notify(task.payload, 'error', shortError(err)));
      } else {
        notify(task.payload, 'error', 'Загрузка прервана браузером или сервером');
      }
    }
  }
});
async function runFallback(fallback, firstDirectIndex = 0) {
  const payload = fallback.payload;
  const directItems = fallback.directCandidates || [];
  for (let i = firstDirectIndex; i < directItems.length; i++) {
    const probe = directItems[i];
    const item = probe.item;
    const ext = directExtension(item, probe.contentType || item.contentType || item.type);
    const filename = `${safeBaseName(payload.pageTitle)}.${ext}`;
    notify(payload, 'busy', `Пробуем полноразмерный файл ${i + 1}/${directItems.length} (${formatBytes(probe.bytes)})…`);
    const started = await startUrlDownload(item.url, filename, {
      fallback, payload, direct: true, candidateIndex: i, expectedBytes: probe.bytes || 0, candidateUrl: item.url
    });
    if (started) return true;
  }

  const all = [
    ...fallback.playlists.map(item => ({ type: 'hls', item })),
    ...fallback.dashes.map(item => ({ type: 'dash', item }))
  ];
  for (const entry of all) {
    if (fallback.tried.has(entry.item.url)) continue;
    fallback.tried.add(entry.item.url);
    try {
      notify(payload, 'busy', entry.type === 'hls' ? 'Прямой файл не найден — разбираем HLS-плейлист…' : 'Пробуем DASH-плейлист…');
      payload.activeSourceUrl = entry.item.url;
      if (entry.type === 'hls') await downloadHls(entry.item.url, payload, fallback);
      else await downloadDash(entry.item.url, payload, fallback);
      return true;
    } catch (err) {
      notify(payload, 'busy', `Этот источник не подошёл, пробуем следующий… (${shortError(err)})`);
    }
  }
  throw new Error('не найден целый видеофайл или подходящий плейлист. Маленькие сегменты отсеяны; поток может быть защищён или раздавать аудио/видео раздельно.');
}
function directExtension(candidate, contentType) {
  const ext = pathExt(candidate && candidate.url || '');
  if (DIRECT_EXTS.has(ext)) return ext === 'm4v' ? 'mp4' : ext;
  return extensionForType(contentType || candidate && candidate.contentType || candidate && candidate.type);
}
function isUndersizedDownload(actual, expected) {
  if (!Number.isFinite(actual) || actual < MIN_DIRECT_BYTES) return true;
  if (expected > MIN_DIRECT_BYTES && actual < expected * 0.70) return true;
  return false;
}

function parseAttributes(text) {
  const attrs = {};
  const re = /([A-Z0-9-]+)=((?:"[^"]*")|[^,]*)/gi;
  let match;
  while ((match = re.exec(text))) attrs[match[1].toUpperCase()] = match[2].replace(/^"|"$/g, '');
  return attrs;
}
async function fetchText(url, referrer) {
  const response = await fetch(url, { credentials: 'include', redirect: 'follow', referrer: safeReferrer(referrer) });
  if (!response.ok) throw new Error(`сервер вернул HTTP ${response.status}`);
  return { text: await response.text(), url: response.url || url };
}
async function resolveHlsMedia(url, payload, depth = 0) {
  if (depth > 4) throw new Error('слишком много вложенных HLS-плейлистов');
  const result = await fetchText(url, payload.pageUrl);
  const lines = result.text.replace(/^\uFEFF/, '').split(/\r?\n/).map(x => x.trim()).filter(Boolean);
  if (!lines.some(x => x === '#EXTM3U')) throw new Error('это не HLS-плейлист');
  const variants = [];
  const audioRenditions = [];
  for (let i=0;i<lines.length;i++) {
    if (lines[i].startsWith('#EXT-X-MEDIA:')) {
      const attrs = parseAttributes(lines[i].slice(lines[i].indexOf(':') + 1));
      if ((attrs.TYPE || '').toUpperCase() === 'AUDIO') {
        audioRenditions.push({
          groupId: attrs['GROUP-ID'] || '', uri: attrs.URI ? new URL(attrs.URI, result.url).href : '',
          isDefault: (attrs.DEFAULT || '').toUpperCase() === 'YES',
          autoselect: (attrs.AUTOSELECT || '').toUpperCase() === 'YES',
          name: attrs.NAME || ''
        });
      }
    }
    if (lines[i].startsWith('#EXT-X-STREAM-INF:')) {
      const attrs = parseAttributes(lines[i].slice(lines[i].indexOf(':') + 1));
      let j = i + 1;
      while (j < lines.length && lines[j].startsWith('#')) j++;
      if (j < lines.length) {
        const resolution = (attrs.RESOLUTION || '').match(/(\d+)x(\d+)/i);
        variants.push({
          url: new URL(lines[j], result.url).href,
          bandwidth: Number(attrs['AVERAGE-BANDWIDTH'] || attrs.BANDWIDTH || 0),
          pixels: resolution ? Number(resolution[1])*Number(resolution[2]) : 0,
          audioGroup: attrs.AUDIO || ''
        });
      }
    }
  }
  if (variants.length) {
    // Prefer the highest quality first, including variants with separate audio.
    // The downloader can mux common fMP4 audio/video tracks and will fall back to
    // lower variants if the best rendition uses an unsupported segment layout.
    variants.sort((a,b) => (b.pixels || 0) - (a.pixels || 0) || b.bandwidth - a.bandwidth || Number(!!a.audioGroup) - Number(!!b.audioGroup));
    const resolvedVariants = [];
    for (const chosen of variants.slice(0, 8)) {
      try {
        const media = await resolveHlsMedia(chosen.url, payload, depth + 1);
        const audioOptions = chosen.audioGroup ? audioRenditions.filter(a => a.groupId === chosen.audioGroup) : [];
        audioOptions.sort((a,b) => Number(b.isDefault) - Number(a.isDefault) || Number(b.autoselect) - Number(a.autoselect));
        if (audioOptions.length && audioOptions[0].uri) media.separateAudioUrl = audioOptions[0].uri;
        else if (chosen.audioGroup && !audioOptions.length) media.separateAudioUrl = true;
        resolvedVariants.push(media);
      } catch (_) {
        // Keep trying the next advertised quality variant.
      }
    }
    if (!resolvedVariants.length) throw new Error('не удалось открыть ни один вариант HLS-плейлиста');
    resolvedVariants[0].alternatives = resolvedVariants.slice(1);
    return resolvedVariants[0];
  }
  if (/#EXT-X-KEY:/.test(result.text) && /#EXT-X-KEY:[^\r\n]*METHOD=(?!NONE\b)/i.test(result.text)) {
    throw new Error('плейлист зашифрован; защищённые потоки не обходятся');
  }
  const segments = [];
  let init = null;
  let pendingRange = null;
  const rangeOffsets = new Map();
  for (const line of lines) {
    if (line.startsWith('#EXT-X-MAP:')) {
      const a = parseAttributes(line.slice(line.indexOf(':') + 1));
      if (!a.URI) throw new Error('неполная карта HLS');
      const mapUrl = new URL(a.URI, result.url).href;
      init = { url: mapUrl, range: parseRange(a.BYTERANGE, mapUrl, rangeOffsets) };
    } else if (line.startsWith('#EXT-X-BYTERANGE:')) {
      pendingRange = line.slice(line.indexOf(':') + 1).trim();
    } else if (!line.startsWith('#')) {
      const segUrl = new URL(line, result.url).href;
      const range = pendingRange ? parseRange(pendingRange, segUrl, rangeOffsets) : null;
      segments.push({ url: segUrl, range });
      pendingRange = null;
    }
  }
  if (!segments.length) throw new Error('в плейлисте нет медиасегментов');
  if (segments.length > MAX_SEGMENTS) throw new Error(`слишком много сегментов (${segments.length})`);
  return { url: result.url, init, segments, isLive: !/#EXT-X-ENDLIST\b/.test(result.text), playlistText: result.text };
}
function parseRange(spec, url, offsets) {
  if (!spec) return null;
  const m = String(spec).match(/^(\d+)(?:@(\d+))?$/);
  if (!m) return null;
  const length = Number(m[1]);
  const start = m[2] != null ? Number(m[2]) : (offsets.get(url) || 0);
  offsets.set(url, start + length);
  return { start, end: start + length - 1 };
}
async function fetchBytes(url, referrer, range, counter) {
  const headers = {};
  if (range) headers.Range = `bytes=${range.start}-${range.end}`;
  const response = await fetch(url, { headers, credentials: 'include', redirect: 'follow', referrer: safeReferrer(referrer) });
  if (!response.ok && response.status !== 206) throw new Error(`сегмент недоступен: HTTP ${response.status}`);
  const declared = Number(response.headers.get('content-length') || 0);
  if (declared > MAX_SEGMENT_BYTES) throw new Error('один сегмент слишком большой');
  const data = new Uint8Array(await response.arrayBuffer());
  if (data.byteLength > MAX_SEGMENT_BYTES) throw new Error('один сегмент слишком большой');
  counter.bytes += data.byteLength;
  if (counter.bytes > MAX_TOTAL_BYTES) throw new Error('сборка остановлена: общий размер больше 1.5 ГБ (ограничение памяти браузера)');
  return data;
}
async function collectParts(items, payload, label, counter, initialParts = []) {
  const results = new Array(items.length);
  let next = 0;
  let done = 0;
  let firstError = null;
  const worker = async () => {
    while (true) {
      const index = next++;
      if (index >= items.length || firstError) return;
      try {
        results[index] = await fetchBytes(items[index].url, payload.pageUrl, items[index].range, counter);
        done++;
        if (done === items.length || done % 8 === 0) notify(payload, 'busy', `${label}: ${done}/${items.length} сегментов (${formatBytes(counter.bytes)})…`);
      } catch (e) { firstError = e; }
    }
  };
  await Promise.all(Array.from({ length: Math.min(4, items.length) }, worker));
  if (firstError) throw firstError;
  return [...initialParts, ...results];
}
// Lightweight fragmented-MP4 muxer. It preserves encoded samples; no transcoding is done.
function mp4Boxes(bytes, start = 0, end = bytes.length) {
  const out = [];
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  let pos = start;
  while (pos + 8 <= end) {
    let size = view.getUint32(pos, false);
    const type = String.fromCharCode(bytes[pos+4], bytes[pos+5], bytes[pos+6], bytes[pos+7]);
    let headerSize = 8;
    if (size === 1) {
      if (pos + 16 > end) throw new Error('Неполный 64-битный MP4-бокс');
      size = view.getUint32(pos + 8, false) * 4294967296 + view.getUint32(pos + 12, false);
      headerSize = 16;
    } else if (size === 0) size = end - pos;
    if (!Number.isSafeInteger(size) || size < headerSize || pos + size > end) throw new Error(`Повреждённая структура MP4 (${type})`);
    out.push({ type, start: pos, size, headerSize, payloadStart: pos + headerSize, end: pos + size });
    pos += size;
  }
  return out;
}
function mp4Child(bytes, box, type) {
  return mp4Boxes(bytes, box.payloadStart, box.end).find(item => item.type === type) || null;
}
function mp4Top(bytes, type) { return mp4Boxes(bytes).find(item => item.type === type) || null; }
function mp4U32(bytes, offset) { return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(offset, false); }
function mp4SetU32(bytes, offset, value) { new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).setUint32(offset, value >>> 0, false); }
function mp4Join(parts) {
  const size = parts.reduce((sum, part) => sum + part.length, 0);
  const output = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) { output.set(part, offset); offset += part.length; }
  return output;
}
function mp4Raw(bytes, box) { return bytes.slice(box.start, box.end); }
function mp4MakeBox(type, payload) {
  const output = new Uint8Array(payload.length + 8);
  mp4SetU32(output, 0, output.length);
  for (let i = 0; i < 4; i++) output[4+i] = type.charCodeAt(i);
  output.set(payload, 8);
  return output;
}
function mp4TrackBoxes(init) {
  const moov = mp4Top(init, 'moov');
  if (!moov) throw new Error('MP4 init-сегмент не содержит moov');
  return mp4Boxes(init, moov.payloadStart, moov.end).filter(item => item.type === 'trak');
}
function mp4TrackId(init, track) {
  const tkhd = mp4Child(init, track, 'tkhd');
  if (!tkhd) throw new Error('MP4-дорожка не содержит tkhd');
  return mp4U32(init, tkhd.payloadStart + (init[tkhd.payloadStart] === 1 ? 20 : 12));
}
function mp4TrackHandler(init, track) {
  const mdia = mp4Child(init, track, 'mdia');
  const hdlr = mdia && mp4Child(init, mdia, 'hdlr');
  if (!hdlr) return '';
  return String.fromCharCode(...init.slice(hdlr.payloadStart + 8, hdlr.payloadStart + 12));
}
function mp4TrackTimescale(init, track) {
  const mdia = mp4Child(init, track, 'mdia');
  const mdhd = mdia && mp4Child(init, mdia, 'mdhd');
  if (!mdhd) return 1;
  return mp4U32(init, mdhd.payloadStart + (init[mdhd.payloadStart] === 1 ? 20 : 12)) || 1;
}
function mp4PatchTrackId(init, track, newId) {
  const raw = mp4Raw(init, track);
  const tkhd = mp4Child(init, track, 'tkhd');
  mp4SetU32(raw, tkhd.payloadStart - track.start + (init[tkhd.payloadStart] === 1 ? 20 : 12), newId);
  return raw;
}
function mp4PatchTrex(init, trex, newId) {
  const raw = mp4Raw(init, trex);
  mp4SetU32(raw, trex.payloadStart - trex.start + 4, newId);
  return raw;
}
function mp4MergeInit(videoInit, audioInit) {
  const videoMoov = mp4Top(videoInit, 'moov'), audioMoov = mp4Top(audioInit, 'moov');
  if (!videoMoov || !audioMoov) throw new Error('Не найден moov в аудио/видео init-сегменте');
  const videoChildren = mp4Boxes(videoInit, videoMoov.payloadStart, videoMoov.end);
  const audioChildren = mp4Boxes(audioInit, audioMoov.payloadStart, audioMoov.end);
  const videoTracks = videoChildren.filter(item => item.type === 'trak');
  const audioTracks = audioChildren.filter(item => item.type === 'trak');
  const videoTrack = videoTracks.find(item => mp4TrackHandler(videoInit, item) === 'vide') || videoTracks[0];
  const audioTrack = audioTracks.find(item => mp4TrackHandler(audioInit, item) === 'soun') || audioTracks[0];
  if (!videoTrack || !audioTrack) throw new Error('Не найдены видео- и аудиодорожки в init-сегментах');
  const videoIds = videoTracks.map(item => mp4TrackId(videoInit, item));
  const audioTrackId = Math.max(1, ...videoIds) + 1;
  const patchedAudioTrack = mp4PatchTrackId(audioInit, audioTrack, audioTrackId);
  const videoMvex = videoChildren.find(item => item.type === 'mvex');
  const audioMvex = audioChildren.find(item => item.type === 'mvex');
  if (!videoMvex || !audioMvex) throw new Error('Нет mvex в одном из init-сегментов; объединение невозможно');
  const mvexParts = [];
  for (const child of mp4Boxes(videoInit, videoMvex.payloadStart, videoMvex.end)) {
    if (child.type !== 'trex') mvexParts.push(mp4Raw(videoInit, child));
  }
  for (const child of mp4Boxes(videoInit, videoMvex.payloadStart, videoMvex.end)) {
    if (child.type === 'trex') mvexParts.push(mp4Raw(videoInit, child));
  }
  const audioTrex = mp4Boxes(audioInit, audioMvex.payloadStart, audioMvex.end).filter(item => item.type === 'trex');
  if (!audioTrex.length) throw new Error('В аудио init-сегменте отсутствует trex');
  for (const child of audioTrex) mvexParts.push(mp4PatchTrex(audioInit, child, audioTrackId));
  const mergedMvex = mp4MakeBox('mvex', mp4Join(mvexParts));
  const maxTrackId = Math.max(audioTrackId, ...videoIds);
  const moovParts = [];
  let insertedAudio = false, insertedMvex = false;
  for (let i = 0; i < videoChildren.length; i++) {
    const child = videoChildren[i];
    if (child.type === 'mvex') {
      if (!insertedAudio) { moovParts.push(patchedAudioTrack); insertedAudio = true; }
      moovParts.push(mergedMvex); insertedMvex = true;
    } else if (child.type === 'trak') {
      moovParts.push(mp4Raw(videoInit, child));
      const laterTrack = videoChildren.slice(i + 1).some(item => item.type === 'trak');
      if (!laterTrack && !insertedAudio) { moovParts.push(patchedAudioTrack); insertedAudio = true; }
    } else if (child.type === 'mvhd') {
      const raw = mp4Raw(videoInit, child);
      mp4SetU32(raw, child.payloadStart - child.start + (videoInit[child.payloadStart] === 1 ? 108 : 96), maxTrackId + 1);
      moovParts.push(raw);
    } else moovParts.push(mp4Raw(videoInit, child));
  }
  if (!insertedAudio) moovParts.push(patchedAudioTrack);
  if (!insertedMvex) moovParts.push(mergedMvex);
  const mergedMoov = mp4MakeBox('moov', mp4Join(moovParts));
  const ftyp = mp4Top(videoInit, 'ftyp') || mp4Top(audioInit, 'ftyp');
  if (!ftyp) throw new Error('Нет ftyp в init-сегментах');
  return {
    init: mp4Join([mp4Raw(videoInit, ftyp), mergedMoov]),
    videoTrackId: mp4TrackId(videoInit, videoTrack), audioTrackId,
    videoTimescale: mp4TrackTimescale(videoInit, videoTrack), audioTimescale: mp4TrackTimescale(audioInit, audioTrack)
  };
}
function mp4ExtractFragments(segment, trackId, firstSequence) {
  const boxes = mp4Boxes(segment), parts = [];
  let sequence = firstSequence;
  for (const moof of boxes.filter(item => item.type === 'moof')) {
    const mdat = boxes.find(item => item.type === 'mdat' && item.start >= moof.end);
    if (!mdat) throw new Error('В MP4-сегменте нет mdat после moof');
    const raw = segment.subarray(moof.start, mdat.end);
    const localMoof = mp4Top(raw, 'moof');
    const mfhd = mp4Child(raw, localMoof, 'mfhd');
    if (mfhd) mp4SetU32(raw, mfhd.payloadStart + 4, sequence++);
    for (const traf of mp4Boxes(raw, localMoof.payloadStart, localMoof.end).filter(item => item.type === 'traf')) {
      const tfhd = mp4Child(raw, traf, 'tfhd');
      if (!tfhd) throw new Error('MP4 traf без tfhd');
      const flags = (raw[tfhd.payloadStart + 1] << 16) | (raw[tfhd.payloadStart + 2] << 8) | raw[tfhd.payloadStart + 3];
      if (flags & 0x000001) throw new Error('Фрагмент использует абсолютный base_data_offset; объединение этого варианта не поддерживается');
      mp4SetU32(raw, tfhd.payloadStart + 4, trackId);
    }
    parts.push(raw);
  }
  if (!parts.length) throw new Error('В сегменте не найдены пары moof/mdat');
  return { parts, nextSequence: sequence };
}
function mp4FragmentTime(segment, timescale, fallback) {
  try {
    const moof = mp4Top(segment, 'moof');
    for (const traf of mp4Boxes(segment, moof.payloadStart, moof.end).filter(item => item.type === 'traf')) {
      const tfdt = mp4Child(segment, traf, 'tfdt');
      if (!tfdt) continue;
      const time = segment[tfdt.payloadStart] === 1
        ? mp4U32(segment, tfdt.payloadStart + 4) * 4294967296 + mp4U32(segment, tfdt.payloadStart + 8)
        : mp4U32(segment, tfdt.payloadStart + 4);
      return time / (timescale || 1);
    }
  } catch (_) {}
  return fallback;
}
function muxFmp4Tracks(videoInit, audioInit, videoSegments, audioSegments) {
  if (!videoInit || !audioInit || !videoSegments.length || !audioSegments.length) throw new Error('Не хватает init-сегмента или медиасегментов аудио/видео');
  const merged = mp4MergeInit(videoInit, audioInit);
  const items = [];
  videoSegments.forEach((segment, index) => items.push({ segment, index, track: 'video', time: mp4FragmentTime(segment, merged.videoTimescale, index) }));
  audioSegments.forEach((segment, index) => items.push({ segment, index, track: 'audio', time: mp4FragmentTime(segment, merged.audioTimescale, index) }));
  items.sort((a, b) => a.time - b.time || (a.track === 'video' ? -1 : 1) || a.index - b.index);
  const fragments = [];
  let sequence = 1;
  for (const item of items) {
    const result = mp4ExtractFragments(item.segment, item.track === 'video' ? merged.videoTrackId : merged.audioTrackId, sequence);
    fragments.push(...result.parts);
    sequence = result.nextSequence;
  }
  // Keep media segments as typed-array views to avoid a second full-size copy in memory.
  return [merged.init, ...fragments];
}

async function downloadHls(url, payload, fallback) {
  notify(payload, 'busy', 'Читаем HLS-плейлист и выбираем максимальное качество…');
  const first = await resolveHlsMedia(url, payload);
  const alternatives = [first, ...(first.alternatives || [])];
  let lastError = null;
  for (let index = 0; index < alternatives.length; index++) {
    try {
      if (index > 0) notify(payload, 'busy', `Вариант не подошёл — пробуем следующий уровень качества (${index + 1}/${alternatives.length})…`);
      await downloadHlsMedia(alternatives[index], payload);
      return;
    } catch (error) {
      lastError = error;
      notify(payload, 'busy', `HLS-вариант не подошёл, пробуем следующий… (${shortError(error)})`);
    }
  }
  throw lastError || new Error('не удалось собрать доступные HLS-варианты');
}
async function downloadHlsMedia(media, payload) {
  const counter = { bytes: 0 };
  if (media.separateAudioUrl) {
    if (typeof media.separateAudioUrl !== 'string') throw new Error('В HLS указана отдельная аудиодорожка, но её URL не раскрыт.');
    notify(payload, 'busy', 'HLS разделяет звук и видео — загружаем обе дорожки и объединяем их без перекодирования…');
    const audioMedia = await resolveHlsMedia(media.separateAudioUrl, payload);
    if (audioMedia.separateAudioUrl) throw new Error('Сложная вложенная схема HLS-аудио не поддерживается.');
    if (!media.init || !audioMedia.init) throw new Error('Для объединения HLS-дорожек нужны fMP4 init-сегменты; этот поток использует другой формат.');
    const videoInit = await fetchBytes(media.init.url, payload.pageUrl, media.init.range, counter);
    const videoSegments = await collectParts(media.segments, payload, 'HLS видео', counter);
    const audioInit = await fetchBytes(audioMedia.init.url, payload.pageUrl, audioMedia.init.range, counter);
    const audioSegments = await collectParts(audioMedia.segments, payload, 'HLS звук', counter);
    const muxed = muxFmp4Tracks(videoInit, audioInit, videoSegments, audioSegments);
    await saveBlob(new Blob(muxed, { type: 'video/mp4' }), `${safeBaseName(payload.pageTitle)}.mp4`, payload);
    if (media.isLive || audioMedia.isLive) notify(payload, 'busy', 'Собраны доступные сегменты live-потока; запись может быть неполной.');
    return;
  }
  const firstSegment = media.segments[0] && media.segments[0].url || '';
  if (/\.(?:cfmv|cmfv)(?:$|[?#])/i.test(firstSegment)) throw new Error('HLS содержит CMAF-видеосегменты, но отдельная аудиодорожка не найдена.');
  const initialParts = [];
  let hasFmp4 = false;
  if (media.init) {
    initialParts.push(await fetchBytes(media.init.url, payload.pageUrl, media.init.range, counter));
    hasFmp4 = true;
  }
  const parts = await collectParts(media.segments, payload, 'HLS', counter, initialParts);
  if (!hasFmp4) hasFmp4 = /\.(m4s|mp4|cmfv|cfmv)(?:$|[?#])/i.test(firstSegment);
  const ext = hasFmp4 ? 'mp4' : 'ts';
  const blob = new Blob(parts, { type: hasFmp4 ? 'video/mp4' : 'video/mp2t' });
  await saveBlob(blob, `${safeBaseName(payload.pageTitle)}.${ext}`, payload);
  if (media.isLive) notify(payload, 'complete', 'Скачаны доступные сегменты live-потока (неполное видео)');
}

// Minimal DASH support: static MPD with SegmentTemplate/SegmentTimeline and unencrypted fMP4.
function buildDashTrack(selected, root, period, result, periodDuration) {
  const adaptation = selected.adaptation, rep = selected.rep;
  const inheritedTemplate = adaptation.querySelector(':scope > SegmentTemplate');
  const template = rep.querySelector(':scope > SegmentTemplate') || inheritedTemplate;
  if (!template) throw new Error('DASH SegmentList/BaseURL без SegmentTemplate не поддерживается');
  const attr = name => template.getAttribute(name) || (inheritedTemplate && inheritedTemplate.getAttribute(name)) || '';
  const baseTexts = [root.querySelector(':scope > BaseURL'), period.querySelector(':scope > BaseURL'), adaptation.querySelector(':scope > BaseURL'), rep.querySelector(':scope > BaseURL')]
    .filter(Boolean).map(item => item.textContent.trim()).filter(Boolean);
  let base = result.url;
  for (const value of baseTexts) base = new URL(value, base).href;
  const representationId = rep.getAttribute('id') || '';
  const bandwidth = rep.getAttribute('bandwidth') || String(selected.bandwidth || 0);
  const startNumber = Number(attr('startNumber') || 1);
  const timescale = Number(attr('timescale') || 1);
  const initTemplate = attr('initialization');
  const mediaTemplate = attr('media');
  if (!mediaTemplate) throw new Error('В DASH не указан шаблон media');
  const replaceTemplate = (templateString, number, time) => templateString
    .replace(/\$RepresentationID\$/g, representationId)
    .replace(/\$Bandwidth\$/g, bandwidth)
    .replace(/\$Number%0(\d+)d\$/g, (_, n) => String(number).padStart(Number(n), '0'))
    .replace(/\$Number\$/g, String(number))
    .replace(/\$Time\$/g, String(time))
    .replace(/\$\$/g, '$');
  const segments = [];
  const timeline = template.querySelector(':scope > SegmentTimeline') || (inheritedTemplate && inheritedTemplate.querySelector(':scope > SegmentTimeline'));
  if (timeline) {
    let time = 0, number = startNumber;
    const nodes = Array.from(timeline.querySelectorAll(':scope > S'));
    for (let i = 0; i < nodes.length; i++) {
      const node = nodes[i];
      const duration = Number(node.getAttribute('d') || 0);
      if (!duration) throw new Error('Неполный DASH SegmentTimeline');
      if (node.hasAttribute('t')) time = Number(node.getAttribute('t'));
      let repeat = Number(node.getAttribute('r') || 0);
      if (repeat < 0) {
        const next = nodes[i + 1];
        if (next && next.hasAttribute('t')) repeat = Math.max(0, Math.ceil((Number(next.getAttribute('t')) - time) / duration) - 1);
        else if (periodDuration > 0) repeat = Math.max(0, Math.ceil((periodDuration * timescale - time) / duration) - 1);
        else throw new Error('Неограниченный DASH SegmentTimeline');
      }
      if (segments.length + repeat + 1 > MAX_SEGMENTS) throw new Error('Слишком много DASH-сегментов');
      for (let j = 0; j <= repeat; j++) {
        const n = number++;
        segments.push({ url: new URL(replaceTemplate(mediaTemplate, n, time), base).href, range: null });
        time += duration;
      }
    }
  } else {
    const duration = Number(attr('duration') || 0);
    if (!duration || !periodDuration) throw new Error('DASH без SegmentTimeline: не хватает duration');
    const count = Math.ceil(periodDuration * timescale / duration);
    if (count > MAX_SEGMENTS) throw new Error('Слишком много DASH-сегментов');
    for (let i = 0; i < count; i++) segments.push({ url: new URL(replaceTemplate(mediaTemplate, startNumber + i, i * duration), base).href, range: null });
  }
  if (!segments.length) throw new Error('В DASH нет медиасегментов');
  const initTemplateValue = initTemplate ? replaceTemplate(initTemplate, startNumber, 0) : '';
  return { initUrl: initTemplateValue ? new URL(initTemplateValue, base).href : null, segments };
}
async function downloadDash(url, payload, fallback) {
  notify(payload, 'busy', 'Читаем DASH-манифест и выбираем дорожки…');
  const result = await fetchText(url, payload.pageUrl);
  if (/<ContentProtection\b/i.test(result.text)) throw new Error('DASH содержит ContentProtection; защищённые потоки не обходятся');
  const xml = new DOMParser().parseFromString(result.text, 'application/xml');
  if (xml.querySelector('parsererror')) throw new Error('Ошибка разбора MPD');
  const root = xml.documentElement;
  if ((root.getAttribute('type') || 'static').toLowerCase() === 'dynamic') throw new Error('Динамический/live DASH пока не поддержан');
  const period = xml.querySelector('Period');
  if (!period) throw new Error('В MPD нет Period');
  const periodDuration = parseIsoDuration(period.getAttribute('duration') || root.getAttribute('mediaPresentationDuration') || 'PT0S');
  const adaptations = Array.from(period.querySelectorAll(':scope > AdaptationSet'));
  const videoChoices = [], audioChoices = [];
  for (const adaptation of adaptations) {
    const adaptationMime = (adaptation.getAttribute('mimeType') || '').toLowerCase();
    const adaptationContent = (adaptation.getAttribute('contentType') || '').toLowerCase();
    for (const rep of Array.from(adaptation.querySelectorAll(':scope > Representation'))) {
      const mime = adaptationMime || (rep.getAttribute('mimeType') || '').toLowerCase();
      const content = adaptationContent || (rep.getAttribute('contentType') || '').toLowerCase();
      const width = Number(rep.getAttribute('width') || 0), height = Number(rep.getAttribute('height') || 0);
      const bandwidth = Number(rep.getAttribute('bandwidth') || 0);
      if (content === 'video' || mime.startsWith('video/')) videoChoices.push({ adaptation, rep, width, height, bandwidth, score: width * height * 1000 + bandwidth });
      else if (content === 'audio' || mime.startsWith('audio/')) audioChoices.push({ adaptation, rep, width, height, bandwidth, score: bandwidth });
    }
  }
  videoChoices.sort((a,b) => b.score - a.score);
  audioChoices.sort((a,b) => b.score - a.score);
  const videoChoice = videoChoices[0];
  if (!videoChoice) throw new Error('В MPD не найдено видео-представление');
  const videoTrack = buildDashTrack(videoChoice, root, period, result, periodDuration);
  const counter = { bytes: 0 };
  const videoInit = videoTrack.initUrl ? await fetchBytes(videoTrack.initUrl, payload.pageUrl, null, counter) : null;
  const videoSegments = await collectParts(videoTrack.segments, payload, 'DASH видео', counter);

  if (audioChoices.length) {
    const audioTrack = buildDashTrack(audioChoices[0], root, period, result, periodDuration);
    if (!videoInit || !audioTrack.initUrl) throw new Error('Для объединения DASH-аудио нужны fMP4 init-сегменты');
    const audioInit = await fetchBytes(audioTrack.initUrl, payload.pageUrl, null, counter);
    const audioSegments = await collectParts(audioTrack.segments, payload, 'DASH звук', counter);
    const muxed = muxFmp4Tracks(videoInit, audioInit, videoSegments, audioSegments);
    await saveBlob(new Blob(muxed, { type: 'video/mp4' }), `${safeBaseName(payload.pageTitle)}.mp4`, payload);
    return;
  }
  if (videoTrack.segments.some(item => /\.(?:cfmv|cmfv)(?:$|[?#])/i.test(item.url))) {
    throw new Error('DASH раскрыл только CMAF-видеосегменты, аудиодорожка в MPD не найдена; беззвучный файл не сохраняется. Ищем другой источник.');
  }
  const parts = [...(videoInit ? [videoInit] : []), ...videoSegments];
  await saveBlob(new Blob(parts, { type: 'video/mp4' }), `${safeBaseName(payload.pageTitle)}.mp4`, payload);
}
function parseIsoDuration(value) {
  const m = String(value).match(/^P(?:(\d+(?:\.\d+)?)D)?(?:T(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?)?$/i);
  if (!m) return 0;
  return Number(m[1]||0)*86400 + Number(m[2]||0)*3600 + Number(m[3]||0)*60 + Number(m[4]||0);
}
function saveBlob(blob, filename, payload) {
  return new Promise((resolve, reject) => {
    if (!blob || !blob.size) { reject(new Error('собран пустой файл')); return; }
    const blobUrl = URL.createObjectURL(blob);
    try {
      chrome.downloads.download({ url: blobUrl, filename, conflictAction: 'uniquify', saveAs: false }, id => {
        if (chrome.runtime.lastError || id == null) {
          URL.revokeObjectURL(blobUrl);
          reject(new Error(chrome.runtime.lastError?.message || 'браузер не принял собранный файл'));
          return;
        }
        objectUrlsByDownload.set(id, blobUrl);
        downloadTasks.set(id, { payload, direct: false, candidateUrl: payload.activeSourceUrl || '' });
        notify(payload, 'busy', `Файл собран (${formatBytes(blob.size)}), сохраняем…`);
        resolve(id);
      });
    } catch (e) {
      URL.revokeObjectURL(blobUrl);
      reject(e);
    }
  });
}
function formatBytes(bytes) {
  if (!bytes || bytes <= 0) return 'размер неизвестен';
  const units = ['Б','КБ','МБ','ГБ'];
  let n = bytes, i = 0;
  while (n >= 1024 && i < units.length - 1) { n /= 1024; i++; }
  return `${n.toFixed(i === 0 ? 0 : 1)} ${units[i]}`;
}

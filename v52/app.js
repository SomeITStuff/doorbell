window.__appStarted = true;
if (window.__bootLog) window.__bootLog('app.js запущен');
setTimeout(function () {
    var el = document.getElementById('boot');
    if (el && !window.__bootError) el.classList.remove('show');
}, 2500);

const params = new URLSearchParams(location.search);
const SRC = params.get('src') || 'cam';
const DEFAULT_DB = 'https://doorbell-b1bda-default-rtdb.europe-west1.firebasedatabase.app';
const START_PARAM = params.get('tgWebAppStartParam') || '';
const START_PARTS = START_PARAM.split('_');
const ROOM = params.get('room') || START_PARTS[0] || 'view';
let KEY = params.get('k') || START_PARTS[1] || '';
const DB = (params.get('db') || DEFAULT_DB).replace(/\/$/, '');
const MODE = params.get('local') ? 'local' : 'rtdb';
const API = (params.get('go2rtc') || location.origin).replace(/\/$/, '');

const video = document.getElementById('video');
const statusEl = document.getElementById('status');
const logEl = document.getElementById('log');
const headerEl = document.getElementById('header');
const btnMic = document.getElementById('btnMic');
const btnDoor = document.getElementById('btnDoor');
const btnToggle = document.getElementById('btnToggle');
const btnSound = document.getElementById('btnSound');
const btnScroll = document.getElementById('btnScroll');
const logHead = document.getElementById('logHead');
const sheetEl = document.getElementById('sheet');
const handleEl = document.getElementById('handle');
const videoWrap = document.getElementById('videoWrap');
const btnShot = document.getElementById('btnShot');
const btnRec = document.getElementById('btnRec');
const recDot = document.getElementById('recDot');
const btnLogOpen = document.getElementById('btnLogOpen');
const logOverlay = document.getElementById('logOverlay');
const logArea = document.getElementById('logArea');
const btnLogPause = document.getElementById('btnLogPause');
const btnLogCopy = document.getElementById('btnLogCopy');
const btnLogClose = document.getElementById('btnLogClose');
const btnQuality = document.getElementById('btnQuality');

let autoScroll = true;
let logFrozen = false;
let recording = false;
let recTimer = null;
let recT0 = 0;
let shotTimer = null;

function showVideoBadge(text) {
    const wrap = document.getElementById('badges');
    if (!wrap) return;
    const el = document.createElement('div');
    el.className = 'vbadge temp';
    el.textContent = text;
    wrap.appendChild(el);
    const temps = wrap.querySelectorAll('.temp');
    if (temps.length > 3) temps[0].remove();
    setTimeout(() => {
        el.classList.add('remove');
        setTimeout(() => { try { el.remove(); } catch (e) {} }, 300);
    }, 2400);
}

function updateResolution() {
    const el = document.getElementById('qualityInfo');
    if (!el) return;
    const w = video.videoWidth, h = video.videoHeight;
    if (w && h) {
        el.textContent = w + '×' + h;
        el.classList.remove('hidden');
    } else {
        el.classList.add('hidden');
    }
}

video.addEventListener('loadedmetadata', updateResolution);
video.addEventListener('resize', updateResolution);

function recStartTimer() {
    recT0 = Date.now();
    if (recTimer) clearInterval(recTimer);
    recTimer = setInterval(() => {
        const s = Math.floor((Date.now() - recT0) / 1000);
        const mm = String(Math.floor(s / 60)).padStart(2, '0');
        const ss = String(s % 60).padStart(2, '0');
        const el = document.getElementById('recTime');
        if (el) el.textContent = mm + ':' + ss;
    }, 500);
}

function recStopTimer() {
    if (recTimer) {
        clearInterval(recTimer);
        recTimer = null;
    }
    const el = document.getElementById('recTime');
    if (el) el.textContent = '00:00';
}
let quality = 'sd';
try { quality = localStorage.getItem('vidQuality2') || 'sd'; } catch (e) {}
let soundAutoTried = false;
let lastFrameTotal = -1;
let lastFrameTs = 0;
let sawBright = false;
let blackStrikes = 0;
let recoveries = 0;
let stableTs = 0;

let pc = null;
let pendingCands = [];
let ws = null;
let micTrack = null;
let streams = [];
let gotAnswer = false;      // получен ли answer (для подсказки про устаревшую ссылку)
let staleHintTimer = null;
let roomBase = '';

function lineClass(line) {
    const s = line.toLowerCase();
    if (/(error|err:|fail|ошибк|не уд|отказ|timeout|таймаут|denied|refused|rejected|unavailable)/.test(s)) return 'l-err';
    if (/(warn|предупр|warning|залип|пропуск)/.test(s)) return 'l-warn';
    if (/(\bok\b|connected|в эфире|подключ|скопирован|готово|запущен)/.test(s)) return 'l-ok';
    return '';
}

function appendLine(el, line) {
    if (!el) return;
    const span = document.createElement('span');
    const cls = lineClass(line);
    if (cls) span.className = cls;
    span.textContent = line + '\n';
    el.appendChild(span);
}

function log(...args) {
    const line = new Date().toTimeString().slice(0, 8) + ' ' + args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ');
    appendLine(logEl, line);
    if (autoScroll) logEl.scrollTop = logEl.scrollHeight;
    appendLine(logArea, line);
    if (!logFrozen && logArea) logArea.scrollTop = logArea.scrollHeight;
    console.log(...args);
}

let toastTimer = null;
function showToast(text, isErr) {
    const el = document.getElementById('toast');
    if (!el) return;
    el.textContent = text;
    el.classList.toggle('err', !!isErr);
    el.classList.add('show');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
}

function doorChime() {
    try {
        const ctx = new (window.AudioContext || window.webkitAudioContext)();
        const now = ctx.currentTime;
        [[880, 0], [1318.5, 0.13]].forEach(([f, dt]) => {
            const o = ctx.createOscillator();
            const g = ctx.createGain();
            o.type = 'sine';
            o.frequency.value = f;
            g.gain.setValueAtTime(0.0001, now + dt);
            g.gain.exponentialRampToValueAtTime(0.28, now + dt + 0.03);
            g.gain.exponentialRampToValueAtTime(0.0001, now + dt + 0.55);
            o.connect(g);
            g.connect(ctx.destination);
            o.start(now + dt);
            o.stop(now + dt + 0.6);
        });
        setTimeout(() => { try { ctx.close(); } catch (e) {} }, 1600);
    } catch (e) {}
}

function setStatus(text) {
    statusEl.textContent = text;
    log('status:', text);
}

function loadTelegram() {
    const s = document.createElement('script');
    s.src = 'https://telegram.org/js/telegram-web-app.js';
    // ВАЖНО: без s.remove() и без таймера-обрыва — WebView Velogram падает в чёрный
    // экран, если удалять <script> во время загрузки (проверено A/B 22.09.2026)
    s.onerror = () => { log('TG: скрипт не загрузился (ошибка)'); if (window.__bootLog) window.__bootLog('tg: нет (сеть)'); };
    s.onload = () => {
        try {
            if (window.Telegram && window.Telegram.WebApp) {
                const tg = window.Telegram.WebApp;
                if (window.__bootLog) window.__bootLog('tg: ок v' + tg.version);
                document.body.classList.add('tg');
                tg.ready();
                log('TG: v' + tg.version, '| platform:', tg.platform, '| isFullscreen:', tg.isFullscreen, '| isExpanded:', tg.isExpanded, '| viewport:', tg.viewportStableHeight);
                try {
                    if (tg.onEvent) {
                        tg.onEvent('fullscreenChanged', () => log('event fullscreenChanged ->', tg.isFullscreen));
                        tg.onEvent('fullscreenFailed', (e) => log('event fullscreenFailed:', JSON.stringify(e)));
                        tg.onEvent('viewportChanged', (e) => { if (e && e.isStateStable) log('viewport ->', tg.viewportStableHeight); });
                    }
                } catch (e) {}
                try {
                    if (tg.isFullscreen && tg.exitFullscreen) {
                        tg.exitFullscreen();
                        log('вызван exitFullscreen');
                    } else {
                        log('exitFullscreen недоступен');
                    }
                } catch (e) {
                    log('exitFullscreen error:', String(e));
                }
                try {
                    if (tg.setHeaderColor) tg.setHeaderColor('secondary_bg_color');
                    if (tg.setBackgroundColor) tg.setBackgroundColor('#17171a');
                } catch (e) {}
            }
        } catch (e) {
            log('telegram init error:', String(e));
        }
    };
    document.head.appendChild(s);
}

async function getMic() {
    if (!navigator.mediaDevices || !navigator.mediaDevices.getUserMedia) {
        log('mic: getUserMedia недоступен');
        return null;
    }
    try {
        const stream = await navigator.mediaDevices.getUserMedia({
            audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true }
        });
        log('mic: трек получен');
        return stream.getAudioTracks()[0] || null;
    } catch (e) {
        log('mic error:', String(e));
        return null;
    }
}

function buildPeer() {
    pc = new RTCPeerConnection({
        iceServers: [
            { urls: ['stun:stun.l.google.com:19302', 'stun:stun.cloudflare.com:3478'] },
            { urls: 'turn:openrelay.metered.ca:80', username: 'openrelayproject', credential: 'openrelayproject' },
            { urls: 'turn:openrelay.metered.ca:443', username: 'openrelayproject', credential: 'openrelayproject' },
            { urls: 'turn:openrelay.metered.ca:443?transport=tcp', username: 'openrelayproject', credential: 'openrelayproject' }
        ]
    });

    const remote = [];
    remote.push(pc.addTransceiver('video', { direction: 'recvonly' }).receiver.track);
    const audioTr = pc.addTransceiver('audio', { direction: 'recvonly' });
    remote.push(audioTr.receiver.track);
    if (micTrack) {
        audioTr.direction = 'sendrecv';
        audioTr.sender.replaceTrack(micTrack);
    }
    video.srcObject = new MediaStream(remote);
    video.muted = true;
    video.play()
        .then(() => log('video: играет (без звука)'))
        .catch(e => log('play error:', String(e)));

    pc.addEventListener('iceconnectionstatechange', () => log('ice:', pc.iceConnectionState));
    let lastPath = '';
    setInterval(async () => {
        if (!pc) return;
        try {
            const stats = await pc.getStats();
            stats.forEach(r => {
                if (r.type === 'inbound-rtp' && r.kind === 'video') {
                    log('video stats: framesDecoded=' + r.framesDecoded + ' bytes=' + r.bytesReceived + ' w=' + r.frameWidth + 'x' + r.frameHeight);
                }
            });
            let pairId = null;
            stats.forEach(r => { if (r.type === 'transport' && r.selectedCandidatePairId) pairId = r.selectedCandidatePairId; });
            let local = null, remote = null;
            stats.forEach(r => {
                if (r.type === 'candidate-pair' && (r.id === pairId || r.selected || r.nominated)) {
                    stats.forEach(c => {
                        if (c.id === r.localCandidateId) local = c;
                        if (c.id === r.remoteCandidateId) remote = c;
                    });
                }
            });
            if (local) {
                const lt = local.candidateType;
                const via = lt === 'relay' ? 'P2P через TURN (релей)'
                    : (lt === 'srflx' || lt === 'prflx' ? 'P2P через NAT' : 'напрямую (WiFi/LAN)');
                const s = via + ' | ' + lt + '→' + (remote ? remote.candidateType : '?');
                if (s !== lastPath) { lastPath = s; log('путь трафика:', s); }
            }
        } catch (e) {}
    }, 5000);

    pc.addEventListener('connectionstatechange', () => {
        setStatus('WebRTC: ' + pc.connectionState);
        if (pc.connectionState === 'connected') {
            btnDoor.disabled = false;
            if (btnShot) btnShot.disabled = false;
            if (btnRec) btnRec.disabled = false;
            btnMic.disabled = false;
            btnMic.classList.toggle('on', !!micTrack);
            btnMic.classList.toggle('off', !micTrack);
            btnSound.disabled = false;
            enableSoundAuto();
            updateResolution();
            if (btnQuality) {
                btnQuality.disabled = false;
                btnQuality.textContent = quality.toUpperCase();
            }
            lastFrameTs = Date.now();
            lastFrameTotal = -1;
            try { video.style.transform = 'translateZ(0)'; } catch (e) {}
            setTimeout(repaintNudge, 2500);
            setTimeout(repaintNudge, 6000);
            btnToggle.disabled = false;
            btnToggle.classList.remove('play');
        }
    });
    return pc;
}

async function signalLocal() {
    const wsUrl = API.replace(/^http/, 'ws') + '/api/ws?src=' + encodeURIComponent(SRC);
    log('WS:', wsUrl);
    ws = new WebSocket(wsUrl);

    pc.addEventListener('icecandidate', ev => {
        if (!ev.candidate || !ws || ws.readyState !== WebSocket.OPEN) return;
        ws.send(JSON.stringify({ type: 'webrtc/candidate', value: ev.candidate.candidate }));
    });

    ws.addEventListener('open', async () => {
        log('WS открыт');
        await pc.setLocalDescription(await pc.createOffer());
        ws.send(JSON.stringify({ type: 'webrtc/offer', value: pc.localDescription.sdp }));
        log('offer отправлен');
    });

    ws.addEventListener('message', async ev => {
        const msg = JSON.parse(ev.data);
        if (msg.type === 'webrtc/candidate') {
            await addCand(msg.value);
        } else if (msg.type === 'webrtc/answer') {
            log('answer получен');
            await pc.setRemoteDescription({ type: 'answer', sdp: msg.value });
            setStatus('В эфире');
            await flushCands();
        }
    });

    ws.addEventListener('close', () => setStatus('Соединение закрыто'));
    ws.addEventListener('error', () => setStatus('Ошибка WebSocket'));
}

async function addCand(c) {
    if (!pc) return;
    if (!pc.remoteDescription) {
        pendingCands.push(c);
        return;
    }
    try {
        await pc.addIceCandidate({ candidate: c, sdpMid: '0' });
    } catch (e) {
        log('ice add error:', String(e));
    }
}

async function flushCands() {
    const list = pendingCands;
    pendingCands = [];
    for (const c of list) {
        try {
            await pc.addIceCandidate({ candidate: c, sdpMid: '0' });
        } catch (e) {
            log('ice add error:', String(e));
        }
    }
}

function rtdbAddCandidates(value) {
    const list = [];
    if (typeof value === 'string') list.push(value);
    else if (value && typeof value === 'object') {
        for (const v of Object.values(value)) if (typeof v === 'string') list.push(v);
    }
    for (const c of list) addCand(c);
}

async function authViaTelegram() {
    const tg = window.Telegram && window.Telegram.WebApp;
    const initData = tg && tg.initData;
    if (!initData) {
        log('нет initData — авторизация через Telegram невозможна');
        return null;
    }
    const id = 'auth-' + Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
    log('запрос доступа через Telegram (initData)...');
    try {
        await fetch(`${DB}/rooms/${id}.json`, {
            method: 'PUT',
            body: JSON.stringify({ key: 'authreq', offer: initData, cmd: { ts: Date.now() } }),
        });
    } catch (e) {
        log('authreq error:', String(e));
        return null;
    }
    const key = await new Promise(resolve => {
        const es = new EventSource(`${DB}/rooms/${id}/cmd_result.json`);
        streams.push(es);
        let done = false;
        es.addEventListener('put', ev => {
            try {
                const r = JSON.parse(ev.data).data;
                if (!r || done) return;
                done = true;
                try { es.close(); } catch (e) {}
                fetch(`${DB}/rooms/${id}.json`, { method: 'DELETE' }).catch(() => {});
                resolve(typeof r === 'string' ? r : null);
            } catch (e) {}
        });
        setTimeout(() => {
            if (!done) {
                done = true;
                try { es.close(); } catch (e) {}
                fetch(`${DB}/rooms/${id}.json`, { method: 'DELETE' }).catch(() => {});
                resolve(null);
            }
        }, 15000);
    });
    if (key && key !== 'denied') {
        log('доступ получен через Telegram');
        return key;
    }
    log(key === 'denied' ? 'доступ запрещён (нет в списке пользователей)' : 'таймаут авторизации');
    return null;
}

async function signalRtdb() {
    // В Telegram ВСЕГДА берём свежий токен через initData — старые ссылки
    // с истёкшим k= работают без непоняток у клиента. Токен из ссылки —
    // фолбэк для случаев без Telegram (обычный браузер).
    gotAnswer = false;
    const tg = window.Telegram && window.Telegram.WebApp;
    const urlKey = KEY;
    if (tg && tg.initData) {
        const tgToken = await authViaTelegram();
        if (tgToken) {
            if (urlKey && urlKey !== tgToken) log('токен из ссылки устарел — обновлён через Telegram');
            KEY = tgToken;
        } else if (!urlKey) {
            setStatus('Нет доступа');
            log('откройте приложение через сообщение о звонке или команду /link');
            return;
        } else {
            log('Telegram-авторизация не удалась — пробую токен из ссылки');
        }
    }
    if (!KEY) {
        KEY = await authViaTelegram();
        if (!KEY) {
            setStatus('Нет доступа');
            log('откройте приложение через сообщение о звонке или команду /link');
            return;
        }
    }
    roomBase = `${DB}/rooms/${ROOM}-${Math.random().toString(36).slice(2, 8)}`;
    log('комната:', roomBase.split('/rooms/')[1], '| качество:', quality.toUpperCase());
    await fetch(`${roomBase}/key.json`, { method: 'PUT', body: JSON.stringify(KEY) });
    await fetch(`${roomBase}/cmd.json`, { method: 'PUT', body: JSON.stringify({ quality: quality, ts: Date.now() }) }).catch(() => {});

    pc.addEventListener('icecandidate', ev => {
        if (!ev.candidate) return;
        fetch(`${roomBase}/cand_app.json`, { method: 'POST', body: JSON.stringify(ev.candidate.candidate) })
            .catch(e => log('cand post error:', String(e)));
    });

    const answerEs = new EventSource(`${roomBase}/answer.json`);
    streams.push(answerEs);
    answerEs.addEventListener('put', async ev => {
        try {
            const obj = JSON.parse(ev.data);
            const sdp = typeof obj.data === 'string' ? obj.data : (obj.data && obj.data.sdp);
            if (!sdp) return;
            gotAnswer = true;
            if (staleHintTimer) { clearTimeout(staleHintTimer); staleHintTimer = null; }
            log('answer получен (rtdb)');
            await pc.setRemoteDescription({ type: 'answer', sdp });
            setStatus('В эфире');
            await flushCands();
        } catch (e) {
            log('answer parse error:', String(e));
        }
    });

    const candEs = new EventSource(`${roomBase}/cand_box.json`);
    streams.push(candEs);
    const onCand = ev => {
        try {
            rtdbAddCandidates(JSON.parse(ev.data).data);
        } catch (e) {
            log('cand parse error:', String(e));
        }
    };
    candEs.addEventListener('put', onCand);
    candEs.addEventListener('patch', onCand);

    await pc.setLocalDescription(await pc.createOffer());
    const res = await fetch(`${roomBase}/offer.json`, { method: 'PUT', body: JSON.stringify(pc.localDescription.sdp) });
    log('offer -> rtdb:', res.status);

    // если ответа нет — понятная подсказка (обычно устаревшая ссылка/токен)
    if (staleHintTimer) clearTimeout(staleHintTimer);
    staleHintTimer = setTimeout(() => {
        if (!gotAnswer) {
            log('нет ответа 12с: откройте приложение через кнопку бота (ссылка могла устареть)');
            setStatus('Нет ответа — откройте через бота');
        }
    }, 12000);
}

async function maybeMicAtStart() {
    try {
        if (navigator.permissions && navigator.permissions.query) {
            const st = await navigator.permissions.query({ name: 'microphone' });
            if (st.state === 'granted') {
                log('mic: разрешение есть, включаю сразу');
                return await getMic();
            }
            log('mic: push-to-talk (запросим при нажатии MIC)');
            return null;
        }
    } catch (e) {
        log('mic query error:', String(e));
    }
    return null;
}

async function start() {
    log('режим:', MODE, '| API:', API, '| SRC:', SRC);
    setStatus('Подключение...');

    micTrack = await maybeMicAtStart();
    buildPeer();

    if (MODE === 'rtdb') {
        await signalRtdb();
    } else {
        await signalLocal();
    }
}

function hangup() {
    if (staleHintTimer) { clearTimeout(staleHintTimer); staleHintTimer = null; }
    log('завершение звонка');
    if (recording) {
        log('запись продолжается на сервере (авто-стоп до 120с), видео придёт в Telegram');
        recording = false;
        if (recDot) recDot.classList.add('hidden');
        recStopTimer();
    }
    soundAutoTried = false;
    try {
        if (pc) pc.close();
    } catch (e) {}
    for (const s of streams) {
        try { s.close(); } catch (e) {}
    }
    streams = [];
    try {
        if (ws) ws.close();
    } catch (e) {}
    if (roomBase) {
        fetch(roomBase + '.json', { method: 'DELETE' }).catch(() => {});
    }
    if (micTrack) {
        try { micTrack.stop(); } catch (e) {}
        micTrack = null;
    }
    setStatus('Завершено');
    pc = null;
    ws = null;
    pendingCands = [];
    btnToggle.classList.add('play');
    btnToggle.disabled = false;
    btnDoor.disabled = true;
    btnMic.disabled = true;
    if (btnSound) btnSound.disabled = true;
    if (btnShot) btnShot.disabled = true;
    if (btnRec) btnRec.disabled = true;
    if (btnQuality) btnQuality.disabled = true;
    video.srcObject = null;
    updateResolution();
}

async function addMicTrack() {
    if (micTrack) return;
    micTrack = await getMic();
    if (!micTrack) return;
    const tr = pc.getTransceivers().find(t => t.receiver && t.receiver.track && t.receiver.track.kind === 'audio');
    if (tr) {
        tr.direction = 'sendrecv';
        await tr.sender.replaceTrack(micTrack);
    } else {
        pc.addTransceiver(micTrack, { direction: 'sendrecv' });
    }
    await pc.setLocalDescription(await pc.createOffer());
    if (MODE === 'rtdb') {
        await fetch(`${roomBase}/offer.json`, { method: 'PUT', body: JSON.stringify(pc.localDescription.sdp) });
        log('renegotiation -> rtdb');
    } else if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'webrtc/offer', value: pc.localDescription.sdp }));
        log('renegotiation -> ws');
    }
    btnMic.classList.add('on');
    btnMic.classList.remove('off');
    log('mic: включён (push-to-talk)');
}

function setSound(on) {
    video.muted = !on;
    if (on) video.play().catch(e => log('play error:', String(e)));
    btnSound.classList.toggle('muted', !on);
    btnSound.classList.toggle('on', on);
    if (on) btnSound.classList.remove('attention');
    showVideoBadge(on ? '🔊 ЗВУК ВКЛ' : '🔇 ЗВУК ВЫКЛ');
    log('звук:', on ? 'вкл' : 'выкл');
}

function armSoundUnlock() {
    const evs = ['pointerdown', 'touchstart', 'mousedown', 'click', 'keydown'];
    const once = () => {
        evs.forEach(e => document.removeEventListener(e, once, true));
        btnSound.classList.remove('attention');
        setSound(true);
    };
    evs.forEach(e => document.addEventListener(e, once, true));
}

function enableSoundAuto() {
    if (soundAutoTried) return;
    soundAutoTried = true;
    video.muted = false;
    const mark = ok => {
        btnSound.classList.toggle('muted', !ok);
        btnSound.classList.toggle('on', ok);
    };
    const ok = () => { mark(true); showVideoBadge('🔊 ЗВУК ВКЛ'); log('звук: включён автоматически'); };
    const fail = () => {
        video.muted = true;
        mark(false);
        btnSound.classList.add('attention');
        video.play().catch(() => {});
        log('автозвук: браузер ждёт касание — включу по первому тапу');
        armSoundUnlock();
    };
    const p = video.play();
    if (p && p.then) p.then(ok).catch(fail); else ok();
}

function frameTotal() {
    try {
        if (video.getVideoPlaybackQuality) {
            return video.getVideoPlaybackQuality().totalVideoFrames || 0;
        }
        return Math.round(video.currentTime * 30);
    } catch (e) { return -1; }
}

function sampleBrightness() {
    try {
        const c = document.createElement('canvas');
        c.width = 16; c.height = 12;
        const ctx = c.getContext('2d');
        ctx.drawImage(video, 0, 0, 16, 12);
        const d = ctx.getImageData(0, 0, 16, 12).data;
        let sum = 0;
        for (let i = 0; i < d.length; i += 4) sum += (d[i] + d[i + 1] + d[i + 2]) / 3;
        return sum / (d.length / 4);
    } catch (e) { return -1; }
}

function repaintNudge() {
    try {
        video.style.transform = 'translateZ(0.001px)';
        setTimeout(() => { video.style.transform = ''; }, 80);
    } catch (e) {}
}

function recoverVideo(reason) {
    if (recoveries < 2) {
        recoveries++;
        log('видео-сторож: ' + reason + ' — перезапуск (' + recoveries + '/2)');
        try { hangup(); } catch (e) {}
        setTimeout(() => start().catch(e => log('видео-сторож старт ошибка:', String(e))), 900);
        return;
    }
    const n = parseInt(sessionStorage.getItem('vidReload') || '0');
    if (n < 3) {
        sessionStorage.setItem('vidReload', String(n + 1));
        log('видео-сторож: ' + reason + ' — перезагружаю страницу');
        location.reload();
    } else {
        log('видео-сторож: ' + reason + ' — перезагрузки не помогли, жду вручную');
        recoveries = 0;
    }
}

setInterval(() => {
    if (!pc || pc.connectionState !== 'connected') return;
    updateResolution();
    if (!lastFrameTs) { lastFrameTs = Date.now(); return; }
    if (video.readyState < 2) {
        if (Date.now() - lastFrameTs > 10000) {
            lastFrameTs = Date.now();
            recoverVideo('readyState=' + video.readyState);
        }
        return;
    }
    const f = frameTotal();
    if (f !== lastFrameTotal) {
        lastFrameTotal = f;
        lastFrameTs = Date.now();
        stableTs = Date.now();
    }
    try {
        const r = video.getBoundingClientRect();
        if (r.width < 40 || r.height < 40) {
            log('видео-сторож: область видео ' + Math.round(r.width) + 'x' + Math.round(r.height) + ' — перерисовка');
            repaintNudge();
        }
    } catch (e) {}
    const br = sampleBrightness();
    if (br > 25) { sawBright = true; blackStrikes = 0; }
    else if (sawBright && br >= 0 && br < 4) { blackStrikes++; }
    else if (br >= 4) { blackStrikes = 0; }
    if (Date.now() - lastFrameTs > 9000) {
        lastFrameTs = Date.now();
        recoverVideo('кадры стоят');
        return;
    }
    if (blackStrikes >= 3) {
        blackStrikes = 0;
        log('видео-сторож: чёрный экран, принудительная перерисовка');
        repaintNudge();
        setTimeout(() => { if (sawBright && sampleBrightness() >= 0 && sampleBrightness() < 4) recoverVideo('чёрный экран'); }, 1500);
    }
    if (recoveries > 0 && stableTs && Date.now() - stableTs > 60000) {
        recoveries = 0;
        sessionStorage.removeItem('vidReload');
        log('видео-сторож: поток стабилен, счётчики сброшены');
    }
}, 3000);

btnSound.addEventListener('click', () => setSound(video.muted));

btnMic.addEventListener('click', async () => {
    if (!micTrack) {
        await addMicTrack();
        if (micTrack) showVideoBadge('🎤 МИКРОФОН ВКЛ');
        return;
    }
    micTrack.enabled = !micTrack.enabled;
    btnMic.classList.toggle('on', micTrack.enabled);
    btnMic.classList.toggle('off', !micTrack.enabled);
    showVideoBadge(micTrack.enabled ? '🎤 МИКРОФОН ВКЛ' : '🎤 МИКРОФОН ВЫКЛ');
    log('mic:', micTrack.enabled ? 'вкл' : 'выкл');
});

btnDoor.addEventListener('click', () => {
    log('открыть дверь -> команда');
    btnDoor.classList.add('busy');
    if (roomBase) {
        fetch(`${roomBase}/cmd.json`, { method: 'PUT', body: JSON.stringify({ door: Date.now() }) })
            .then(() => log('команда отправлена'))
            .catch(e => log('cmd error:', String(e)));
    }
    const es = new EventSource(`${roomBase}/cmd_result.json`);
    streams.push(es);
    es.addEventListener('put', ev => {
        try {
            const res = JSON.parse(ev.data).data;
            if (!res) return;
            log('результат двери:', res);
            btnDoor.classList.remove('busy');
            btnDoor.classList.add(res === 'ok' ? 'ok' : 'err');
            if (res === 'ok') {
                doorChime();
                showVideoBadge('🚪 ДВЕРЬ ОТКРЫТА');
            } else {
                showToast('Дверь: ' + res, true);
            }
            es.close();
            setTimeout(() => { btnDoor.classList.remove('ok', 'err'); }, 3000);
        } catch (e) {}
    });
});

function watchMediaResult(cb) {
    const es = new EventSource(`${roomBase}/media_result.json`);
    streams.push(es);
    let done = false;
    const finish = res => {
        if (done) return;
        done = true;
        try { es.close(); } catch (e) {}
        cb(res);
    };
    es.addEventListener('put', ev => {
        try {
            const res = JSON.parse(ev.data).data;
            if (res) finish(res);
        } catch (e) {}
    });
    setTimeout(() => finish('таймаут'), 20000);
}

if (btnShot) btnShot.addEventListener('click', () => {
    if (!roomBase) return;
    log('скриншот -> команда');
    btnShot.classList.add('busy');
    fetch(`${roomBase}/cmd.json`, { method: 'PUT', body: JSON.stringify({ snap: Date.now() }) })
        .catch(e => log('cmd error:', String(e)));
    watchMediaResult(res => {
        btnShot.classList.remove('busy');
        const ok = res === 'ok';
        btnShot.classList.add(ok ? 'ok' : 'err');
        if (ok) showVideoBadge('📸 СКРИНШОТ');
        else showToast('Скриншот: ' + res, true);
        setTimeout(() => btnShot.classList.remove('ok', 'err'), 3000);
    });
});

if (btnRec) btnRec.addEventListener('click', () => {
    if (!roomBase) return;
    const action = recording ? 'stop' : 'start';
    log('запись:', action);
    btnRec.classList.add('busy');
    fetch(`${roomBase}/cmd.json`, { method: 'PUT', body: JSON.stringify({ rec: action }) })
        .catch(e => log('cmd error:', String(e)));
    watchMediaResult(res => {
        btnRec.classList.remove('busy');
        const ok = res === 'ok';
        if (ok && action === 'start') {
            recording = true;
            btnRec.classList.add('on');
            if (recDot) recDot.classList.remove('hidden');
            recStartTimer();
        } else if (ok && action === 'stop') {
            recording = false;
            btnRec.classList.remove('on');
            if (recDot) recDot.classList.add('hidden');
            recStopTimer();
        } else {
            if (action === 'stop') {
                recording = false;
                btnRec.classList.remove('on');
                if (recDot) recDot.classList.add('hidden');
                recStopTimer();
            }
            showToast('Запись: ' + res, true);
        }
    });
});

if (btnToggle) btnToggle.addEventListener('click', () => {
    if (pc && (pc.connectionState === 'connected' || pc.connectionState === 'connecting')) {
        hangup();
    } else {
        log('повторный запуск...');
        btnToggle.classList.remove('play');
        start().catch(e => log('start error:', String(e)));
    }
});

if (btnQuality) btnQuality.addEventListener('click', () => {
    const next = quality === 'hd' ? 'sd' : 'hd';
    quality = next;
    try { localStorage.setItem('vidQuality2', next); } catch (e) {}
    btnQuality.textContent = next.toUpperCase();
    log('качество:', next.toUpperCase() + ' (' + (next === 'sd' ? '640x360' : '1280x720') + ') — мягкое переподключение');
    // мягкая пересборка: рвём только медиа-сессию, органы управления не трогаем
    if (roomBase) { fetch(roomBase + '.json', { method: 'DELETE' }).catch(() => {}); }
    try { if (pc) pc.close(); } catch (e) {}
    for (const s of streams) {
        try { s.close(); } catch (e) {}
    }
    streams = [];
    try { if (ws) ws.close(); } catch (e) {}
    if (micTrack) {
        try { micTrack.stop(); } catch (e) {}
        micTrack = null;
    }
    pc = null;
    ws = null;
    soundAutoTried = false;
    setStatus('Переключение…');
    setTimeout(() => start().catch(e => log('quality start error:', String(e))), 250);
});

let lastHeaderTap = 0;
headerEl.addEventListener('click', () => {
    const now = Date.now();
    if (now - lastHeaderTap < 400) {
        const vis = logEl.classList.toggle('visible');
        if (logHead) logHead.classList.toggle('visible', vis);
        lastHeaderTap = 0;
        return;
    }
    lastHeaderTap = now;
});

if (btnScroll) btnScroll.addEventListener('click', () => {
    autoScroll = !autoScroll;
    btnScroll.classList.toggle('on', autoScroll);
    btnScroll.textContent = 'автопрокрутка: ' + (autoScroll ? 'вкл' : 'выкл');
    if (autoScroll) logEl.scrollTop = logEl.scrollHeight;
});

function openLogOverlay() {
    if (!logOverlay) return;
    logOverlay.classList.remove('hidden');
    if (logArea) logArea.scrollTop = logArea.scrollHeight;
}

function copyOverlayLog() {
    const el = logArea || logEl;
    const text = el ? (el.textContent || '') : '';
    let ok = false;
    try {
        const range = document.createRange();
        range.selectNodeContents(el);
        const sel = window.getSelection();
        sel.removeAllRanges();
        sel.addRange(range);
        ok = document.execCommand('copy');
        sel.removeAllRanges();
    } catch (e) {}
    if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(() => {
            showToast('📋 Лог скопирован', false);
        }).catch(() => {});
    }
    showToast(ok ? '📋 Лог скопирован' : 'Не вышло — выдели вручную', !ok);
}

if (btnLogOpen) btnLogOpen.addEventListener('click', openLogOverlay);
if (btnLogCopy) btnLogCopy.addEventListener('click', copyOverlayLog);
if (btnLogPause) btnLogPause.addEventListener('click', () => {
    logFrozen = !logFrozen;
    btnLogPause.textContent = logFrozen ? '▶ продолжить' : '⏸ остановить';
    btnLogPause.classList.toggle('on', logFrozen);
    if (!logFrozen && logArea) logArea.scrollTop = logArea.scrollHeight;
});
if (btnLogClose) btnLogClose.addEventListener('click', () => {
    if (logOverlay) logOverlay.classList.add('hidden');
});

let lastVideoTap = 0;
if (videoWrap) videoWrap.addEventListener('click', () => {
    const now = Date.now();
    if (now - lastVideoTap < 400) {
        const on = document.body.classList.toggle('cinema');
        log('кинорежим:', on ? 'вкл (поворот + полный экран)' : 'выкл');
        showToast(on ? 'Двойной тап — выйти' : 'Обычный режим');
        lastVideoTap = 0;
        return;
    }
    lastVideoTap = now;
});

let dragY = null;
if (handleEl) handleEl.addEventListener('pointerdown', e => {
    dragY = e.clientY;
    try { handleEl.setPointerCapture(e.pointerId); } catch (err) {}
});
if (handleEl) handleEl.addEventListener('pointermove', e => {
    if (dragY === null) return;
    const dy = e.clientY - dragY;
    if (!sheetEl) return;
    if (dy < -40) { sheetEl.classList.add('full'); dragY = null; }
    else if (dy > 40) { sheetEl.classList.remove('full'); dragY = null; }
});
if (handleEl) handleEl.addEventListener('pointerup', () => { dragY = null; });
if (handleEl) handleEl.addEventListener('dblclick', () => { if (sheetEl) sheetEl.classList.toggle('full'); });

loadTelegram();
log('страница загружена | режим:', MODE, '| build:', window.__BUILD || '?', '| version.json:', window.__VERJSON || '?');
log('UA:', navigator.userAgent);

if (MODE === 'rtdb') {
    setTimeout(() => {
        log('авто-старт...');
        start().catch(e => log('авто-старт ошибка:', String(e)));
    }, 300);
}

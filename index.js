const EXTENSION_KEY = 'theme_feedback_assistant';
const ROOT_ID = 'theme-feedback-assistant';
const API_BASE = '/api/plugins/theme-feedback';
const LOGO_URL = new URL('./assets/theme-feedback-logo.png', import.meta.url).href;
const MAX_COMMENT_LENGTH = 2000;
const THEME_KEYS = Object.freeze([
    'blur_strength', 'main_text_color', 'italics_text_color', 'underline_text_color',
    'quote_text_color', 'blur_tint_color', 'chat_tint_color', 'user_mes_blur_tint_color',
    'bot_mes_blur_tint_color', 'shadow_color', 'shadow_width', 'border_color', 'font_scale',
    'fast_ui_mode', 'waifuMode', 'avatar_style', 'chat_display', 'toastr_position', 'noShadows',
    'chat_width', 'timer_enabled', 'timestamps_enabled', 'timestamp_model_icon',
    'mesIDDisplay_enabled', 'hideChatAvatars_enabled', 'message_token_count_enabled',
    'expand_message_actions', 'enableZenSliders', 'enableLabMode', 'hotswap_enabled',
    'custom_css', 'bogus_folders', 'zoomed_avatar_magnification', 'reduced_motion',
    'compact_input_area', 'show_swipe_num_all_messages', 'click_to_edit', 'media_display',
]);

const ctx = SillyTavern.getContext();
const eventTypes = ctx.eventTypes || ctx.event_types;
let captureLibraryPromise;
let baseScreenshot = null;
let drawing = false;
let lastPoint = null;
let currentIdentity = null;

function getSettings() {
    if (!ctx.extensionSettings[EXTENSION_KEY]) {
        ctx.extensionSettings[EXTENSION_KEY] = { lastScreen: '主聊天' };
    }
    return ctx.extensionSettings[EXTENSION_KEY];
}

function notify(kind, message, title = '美化反馈助手') {
    const handler = window.toastr?.[kind];
    if (typeof handler === 'function') {
        handler(message, title);
    } else {
        console[kind === 'error' ? 'error' : 'log'](`[${title}] ${message}`);
    }
}

function setStatus(message, state = '') {
    const status = document.getElementById('theme-feedback-status');
    status.textContent = message;
    status.dataset.state = state;
}

function stableThemeProjection(theme) {
    const projected = {};
    for (const key of THEME_KEYS) {
        if (Object.hasOwn(theme || {}, key)) {
            projected[key] = theme[key];
        }
    }
    return projected;
}

async function sha256(value) {
    const bytes = new TextEncoder().encode(JSON.stringify(value));
    const digest = await crypto.subtle.digest('SHA-256', bytes);
    return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, '0')).join('');
}

function isTrustedThemeUrl(value) {
    try {
        const url = new URL(value);
        return url.protocol === 'https:' && ['raw.githubusercontent.com', 'cdn.jsdelivr.net'].includes(url.hostname);
    } catch {
        return false;
    }
}

async function resolveThemeIdentity() {
    const activeName = String(ctx.powerUserSettings.theme || '未命名主题').trim();
    const installedEntries = Object.entries(ctx.extensionSettings.theme_subscriber?.installed || {});
    const installedMatch = installedEntries.find(([, entry]) => entry?.name === activeName);
    const runtimeTheme = stableThemeProjection(ctx.powerUserSettings);
    const runtimeFingerprint = await sha256(runtimeTheme);
    const identity = {
        theme_id: installedMatch?.[0] || 'local-theme',
        theme_name: activeName,
        version_name: installedMatch?.[1]?.versionName || '本地版本',
        version: installedMatch?.[1]?.version || '',
        catalog_sha256: installedMatch?.[1]?.sha256 || '',
        runtime_fingerprint: runtimeFingerprint,
        match_status: installedMatch ? 'modified' : 'local',
    };

    const themeUrl = installedMatch?.[1]?.themeUrl;
    if (themeUrl && isTrustedThemeUrl(themeUrl)) {
        try {
            const response = await fetch(themeUrl, { credentials: 'omit', cache: 'no-store' });
            if (response.ok) {
                const catalogTheme = stableThemeProjection(await response.json());
                identity.match_status = JSON.stringify(catalogTheme) === JSON.stringify(runtimeTheme) ? 'matched' : 'modified';
            }
        } catch (error) {
            console.warn('[美化反馈助手] 无法核对远程主题版本，将按本地修改状态记录。', error);
        }
    }
    return identity;
}

function isVisible(selector) {
    const element = document.querySelector(selector);
    return Boolean(element && element.getClientRects().length && getComputedStyle(element).visibility !== 'hidden');
}

function detectScreen() {
    const screens = [
        ['#world_info', '世界书'],
        ['#WorldInfo', '世界书'],
        ['#ai_response_configuration', '预设与生成设置'],
        ['#rm_extensions_block', '扩展设置'],
        ['#character_popup', '角色编辑'],
        ['#right-nav-panel', '右侧抽屉'],
        ['#left-nav-panel', '左侧抽屉'],
        ['dialog[open]', '弹窗'],
        ['.popup[style*="display: block"]', '弹窗'],
    ];
    return screens.find(([selector]) => isVisible(selector))?.[1] || '主聊天';
}

function identityLabel(identity) {
    const state = identity.match_status === 'matched'
        ? '与订阅版本一致'
        : identity.match_status === 'modified'
            ? '本地已修改'
            : '本地主题';
    return `${identity.theme_name} · ${identity.version_name} · ${state}`;
}

async function getCaptureLibrary() {
    captureLibraryPromise ||= import('./vendor/html2canvas-pro.esm.js').then(module => module.default);
    return captureLibraryPromise;
}

function drawBaseImage() {
    if (!baseScreenshot) {
        return;
    }
    const canvas = document.getElementById('theme-feedback-canvas');
    const context = canvas.getContext('2d');
    canvas.width = baseScreenshot.naturalWidth;
    canvas.height = baseScreenshot.naturalHeight;
    context.drawImage(baseScreenshot, 0, 0);
}

async function captureCurrentView() {
    const root = document.getElementById(ROOT_ID);
    const captureButton = document.getElementById('theme-feedback-capture');
    captureButton.disabled = true;
    setStatus('正在截取当前酒馆界面…', 'working');
    try {
        currentIdentity = await resolveThemeIdentity();
        document.getElementById('theme-feedback-identity').textContent = identityLabel(currentIdentity);
        document.getElementById('theme-feedback-screen').value = detectScreen();
        root.classList.add('theme-feedback-capture-hidden');
        await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
        const html2canvas = await getCaptureLibrary();
        const screenshot = await html2canvas(document.documentElement, {
            backgroundColor: null,
            useCORS: true,
            allowTaint: false,
            logging: false,
            scale: Math.min(window.devicePixelRatio || 1, 2),
            width: window.innerWidth,
            height: window.innerHeight,
            windowWidth: window.innerWidth,
            windowHeight: window.innerHeight,
            scrollX: -window.scrollX,
            scrollY: -window.scrollY,
        });
        root.classList.remove('theme-feedback-capture-hidden');
        const image = new Image();
        image.src = screenshot.toDataURL('image/png');
        await image.decode();
        baseScreenshot = image;
        drawBaseImage();
        document.getElementById('theme-feedback-editor').hidden = false;
        document.getElementById('theme-feedback-upload').disabled = false;
        setStatus('截图完成。可以圈出问题并填写反馈。', 'success');
    } catch (error) {
        root.classList.remove('theme-feedback-capture-hidden');
        console.error('[美化反馈助手] 截图失败', error);
        setStatus(`截图失败：${error?.message || String(error)}`, 'error');
    } finally {
        captureButton.disabled = false;
    }
}

function canvasPoint(event) {
    const canvas = event.currentTarget;
    const rect = canvas.getBoundingClientRect();
    return {
        x: (event.clientX - rect.left) * canvas.width / rect.width,
        y: (event.clientY - rect.top) * canvas.height / rect.height,
    };
}

function startDrawing(event) {
    if (!baseScreenshot) return;
    drawing = true;
    lastPoint = canvasPoint(event);
    event.currentTarget.setPointerCapture(event.pointerId);
}

function continueDrawing(event) {
    if (!drawing || !lastPoint) return;
    const canvas = event.currentTarget;
    const point = canvasPoint(event);
    const rect = canvas.getBoundingClientRect();
    const context = canvas.getContext('2d');
    context.strokeStyle = '#ff3b4f';
    context.lineWidth = Math.max(4, 4 * canvas.width / rect.width);
    context.lineCap = 'round';
    context.lineJoin = 'round';
    context.beginPath();
    context.moveTo(lastPoint.x, lastPoint.y);
    context.lineTo(point.x, point.y);
    context.stroke();
    lastPoint = point;
}

function stopDrawing(event) {
    drawing = false;
    lastPoint = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
        event.currentTarget.releasePointerCapture(event.pointerId);
    }
}

async function checkServer() {
    const response = await fetch(`${API_BASE}/status`, { headers: ctx.getRequestHeaders() });
    if (!response.ok) {
        throw new Error(response.status === 404 ? '服务端插件尚未安装或未启用。' : `服务端不可用：HTTP ${response.status}`);
    }
    return response.json();
}

async function uploadFeedback() {
    const button = document.getElementById('theme-feedback-upload');
    const comment = document.getElementById('theme-feedback-comment').value.trim();
    const screen = document.getElementById('theme-feedback-screen').value.trim() || detectScreen();
    if (!baseScreenshot) {
        setStatus('请先截取当前界面。', 'error');
        return;
    }
    if (!comment) {
        setStatus('请填写需要反馈的问题。', 'error');
        document.getElementById('theme-feedback-comment').focus();
        return;
    }
    button.disabled = true;
    button.textContent = '正在上传…';
    setStatus('正在保存到电脑反馈箱…', 'working');
    try {
        await checkServer();
        currentIdentity ||= await resolveThemeIdentity();
        const canvas = document.getElementById('theme-feedback-canvas');
        const response = await fetch(`${API_BASE}/feedback`, {
            method: 'POST',
            headers: ctx.getRequestHeaders(),
            body: JSON.stringify({
                ...currentIdentity,
                screen,
                viewport: `${window.innerWidth}x${window.innerHeight}@${Math.min(window.devicePixelRatio || 1, 2)}x`,
                platform: navigator.userAgentData?.platform || navigator.platform || 'unknown',
                sillytavern_version: String(ctx.version || ''),
                comment: comment.slice(0, MAX_COMMENT_LENGTH),
                image_data_url: canvas.toDataURL('image/png'),
            }),
        });
        const result = await response.json().catch(() => ({}));
        if (!response.ok) {
            throw new Error(result.error || `上传失败：HTTP ${response.status}`);
        }
        setStatus(`反馈 ${result.feedback_id} 已保存。`, 'success');
        notify('success', `反馈 ${result.feedback_id} 已保存到电脑。`);
        button.textContent = '已上传';
    } catch (error) {
        console.error('[美化反馈助手] 上传失败', error);
        setStatus(error?.message || String(error), 'error');
        button.textContent = '重试上传';
        button.disabled = false;
    }
}

function setOpen(open) {
    const sheet = document.getElementById('theme-feedback-sheet');
    const backdrop = document.getElementById('theme-feedback-backdrop');
    const launcher = document.getElementById('theme-feedback-launcher');
    sheet.hidden = !open;
    backdrop.hidden = !open;
    launcher.setAttribute('aria-expanded', String(open));
    document.body.classList.toggle('theme-feedback-open', open);
    if (open) {
        document.getElementById('theme-feedback-capture').focus();
    } else {
        launcher.focus();
    }
}

function createUi() {
    const root = document.createElement('div');
    root.id = ROOT_ID;
    root.innerHTML = `
        <button id="theme-feedback-launcher" class="theme-feedback-launcher" type="button" aria-expanded="false" aria-controls="theme-feedback-sheet">
            <img src="${LOGO_URL}" alt=""><span>美化反馈</span>
        </button>
        <div id="theme-feedback-backdrop" class="theme-feedback-backdrop" hidden></div>
        <section id="theme-feedback-sheet" class="theme-feedback-sheet" role="dialog" aria-modal="true" aria-labelledby="theme-feedback-title" hidden>
            <div class="theme-feedback-handle" aria-hidden="true"></div>
            <header class="theme-feedback-header">
                <img class="theme-feedback-logo" src="${LOGO_URL}" alt="">
                <div class="theme-feedback-heading"><small>THEME FEEDBACK</small><h2 id="theme-feedback-title">美化反馈助手</h2></div>
                <button id="theme-feedback-close" class="menu_button theme-feedback-close" type="button" aria-label="关闭反馈助手"><i class="fa-solid fa-xmark" aria-hidden="true"></i></button>
            </header>
            <p id="theme-feedback-identity" class="theme-feedback-identity">正在识别当前主题…</p>
            <button id="theme-feedback-capture" class="menu_button theme-feedback-primary" type="button"><i class="fa-solid fa-camera" aria-hidden="true"></i>截取当前界面</button>
            <div id="theme-feedback-editor" class="theme-feedback-editor" hidden>
                <div class="theme-feedback-canvas-wrap"><canvas id="theme-feedback-canvas" aria-label="反馈截图标注画布"></canvas></div>
                <div class="theme-feedback-toolbar"><span>用手指圈出问题</span><button id="theme-feedback-clear" class="menu_button" type="button">清除标注</button></div>
                <label for="theme-feedback-screen">反馈窗口</label>
                <input id="theme-feedback-screen" class="text_pole" type="text" maxlength="100">
                <label for="theme-feedback-comment">问题说明</label>
                <textarea id="theme-feedback-comment" class="text_pole" rows="3" maxlength="${MAX_COMMENT_LENGTH}" placeholder="例如：正文太靠左，头像和文字挤在一起。"></textarea>
                <button id="theme-feedback-upload" class="menu_button theme-feedback-primary" type="button" disabled>上传到电脑反馈箱</button>
            </div>
            <p id="theme-feedback-status" class="theme-feedback-status" aria-live="polite">截图不会自动上传，由你确认后再保存。</p>
        </section>`;
    document.body.append(root);

    document.getElementById('theme-feedback-launcher').addEventListener('click', async () => {
        setOpen(true);
        currentIdentity = await resolveThemeIdentity();
        document.getElementById('theme-feedback-identity').textContent = identityLabel(currentIdentity);
        document.getElementById('theme-feedback-screen').value = detectScreen();
    });
    document.getElementById('theme-feedback-close').addEventListener('click', () => setOpen(false));
    document.getElementById('theme-feedback-backdrop').addEventListener('click', () => setOpen(false));
    document.getElementById('theme-feedback-capture').addEventListener('click', captureCurrentView);
    document.getElementById('theme-feedback-clear').addEventListener('click', drawBaseImage);
    document.getElementById('theme-feedback-upload').addEventListener('click', uploadFeedback);
    const canvas = document.getElementById('theme-feedback-canvas');
    canvas.addEventListener('pointerdown', startDrawing);
    canvas.addEventListener('pointermove', continueDrawing);
    canvas.addEventListener('pointerup', stopDrawing);
    canvas.addEventListener('pointercancel', stopDrawing);
    document.addEventListener('keydown', event => {
        if (event.key === 'Escape' && !document.getElementById('theme-feedback-sheet').hidden) {
            setOpen(false);
        }
    });
}

function initialize() {
    if (document.getElementById(ROOT_ID)) {
        return;
    }
    getSettings();
    createUi();
    void checkServer().catch(error => setStatus(error.message, 'error'));
}

if (eventTypes?.APP_READY) {
    ctx.eventSource.on(eventTypes.APP_READY, initialize);
} else {
    $(initialize);
}

console.log('[美化反馈助手] 扩展脚本已加载');

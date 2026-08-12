import { randomBytes } from 'node:crypto';
import { appendFile, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const pluginDirectory = path.dirname(fileURLToPath(import.meta.url));
const localConfigPath = path.join(pluginDirectory, 'config.local.json');
const defaultRoot = path.join(process.cwd(), 'theme-feedback-inbox');
const allowedImageTypes = new Map([
    ['image/png', '.png'],
    ['image/jpeg', '.jpg'],
    ['image/webp', '.webp'],
]);

export const info = Object.freeze({
    id: 'theme-feedback',
    name: 'Theme Feedback Inbox',
    description: 'Receives user-confirmed SillyTavern theme screenshots and stores them locally.',
});

function safeSegment(value, fallback) {
    const clean = String(value || '')
        .normalize('NFKC')
        .replace(/[<>:"/\\|?*\u0000-\u001F]/g, '_')
        .replace(/[. ]+$/g, '')
        .trim()
        .slice(0, 100);
    return clean || fallback;
}

function isSameOrigin(req) {
    const origin = req.get('origin');
    if (!origin) {
        return true;
    }
    try {
        return new URL(origin).host === req.get('host');
    } catch {
        return false;
    }
}

function parseImage(dataUrl, maxBytes) {
    const match = String(dataUrl || '').match(/^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=\s]+)$/);
    if (!match || !allowedImageTypes.has(match[1])) {
        throw new Error('截图必须是 PNG、JPEG 或 WebP 图片。');
    }
    const bytes = Buffer.from(match[2].replace(/\s/g, ''), 'base64');
    if (!bytes.length || bytes.length > maxBytes) {
        throw new Error(`截图大小必须在 1 字节到 ${maxBytes} 字节之间。`);
    }
    return { bytes, extension: allowedImageTypes.get(match[1]), mimeType: match[1] };
}

function normalizeMetadata(input) {
    const comment = String(input.comment || '').trim().slice(0, 2000);
    if (!comment) {
        throw new Error('请填写反馈说明。');
    }
    return {
        theme_id: String(input.theme_id || 'local-theme').trim().slice(0, 100),
        theme_name: String(input.theme_name || '未知主题').trim().slice(0, 128),
        version_name: String(input.version_name || '本地版本').trim().slice(0, 100),
        version: String(input.version || '').trim().slice(0, 80),
        catalog_sha256: String(input.catalog_sha256 || '').trim().toLowerCase().slice(0, 64),
        runtime_fingerprint: String(input.runtime_fingerprint || '').trim().toLowerCase().slice(0, 64),
        match_status: ['matched', 'modified', 'local'].includes(input.match_status) ? input.match_status : 'local',
        screen: String(input.screen || '未知窗口').trim().slice(0, 100),
        viewport: String(input.viewport || '').trim().slice(0, 40),
        platform: String(input.platform || '').trim().slice(0, 80),
        sillytavern_version: String(input.sillytavern_version || '').trim().slice(0, 40),
        comment,
    };
}

async function loadConfig() {
    let local = {};
    try {
        const configText = (await readFile(localConfigPath, 'utf8')).replace(/^\uFEFF/, '');
        local = JSON.parse(configText);
    } catch (error) {
        if (error?.code !== 'ENOENT') {
            throw new Error(`反馈助手配置无效：${error?.message || String(error)}`);
        }
    }
    const feedbackRoot = path.resolve(String(process.env.THEME_FEEDBACK_ROOT || local.feedbackRoot || defaultRoot));
    const maxImageBytes = Number(local.maxImageBytes || 15 * 1024 * 1024);
    const allowedUserHandles = Array.isArray(local.allowedUserHandles)
        ? local.allowedUserHandles.map(value => String(value).trim()).filter(Boolean)
        : [];
    if (!Number.isSafeInteger(maxImageBytes) || maxImageBytes < 1024 || maxImageBytes > 30 * 1024 * 1024) {
        throw new Error('maxImageBytes 必须是 1KB 到 30MB 之间的整数。');
    }
    if (!allowedUserHandles.length) {
        throw new Error('allowedUserHandles 至少要填写一个酒馆用户 handle。');
    }
    await mkdir(feedbackRoot, { recursive: true });
    return { feedbackRoot, maxImageBytes, allowedUserHandles };
}

function isAllowedUser(req, config) {
    const handle = String(req.user?.profile?.handle || '').trim();
    return handle && config.allowedUserHandles.includes(handle);
}

export async function init(router) {
    const config = await loadConfig();

    router.get('/status', (req, res) => {
        if (!isAllowedUser(req, config)) {
            return res.status(403).json({ error: '当前酒馆用户无权使用反馈收件箱。' });
        }
        res.json({ ready: true, max_image_bytes: config.maxImageBytes });
    });

    router.post('/feedback', async (req, res) => {
        try {
            if (!isSameOrigin(req)) {
                return res.status(403).json({ error: '只接受当前酒馆页面发出的反馈。' });
            }
            if (!isAllowedUser(req, config)) {
                return res.status(403).json({ error: '当前酒馆用户无权使用反馈收件箱。' });
            }

            const metadata = normalizeMetadata(req.body || {});
            const image = parseImage(req.body?.image_data_url, config.maxImageBytes);
            const now = new Date();
            const timestamp = now.toISOString().replace(/[-:T]/g, '').replace(/\.\d{3}Z$/, 'Z');
            const feedbackId = `${timestamp}-${randomBytes(3).toString('hex')}`;
            const themeFolder = safeSegment(metadata.theme_name, '未知主题');
            const versionFolder = safeSegment(metadata.version_name, '本地版本');
            const feedbackFolder = path.resolve(config.feedbackRoot, themeFolder, versionFolder, feedbackId);
            const rootPrefix = `${config.feedbackRoot}${path.sep}`.toLowerCase();
            if (!`${feedbackFolder}${path.sep}`.toLowerCase().startsWith(rootPrefix)) {
                return res.status(400).json({ error: '反馈路径无效。' });
            }

            await mkdir(path.dirname(feedbackFolder), { recursive: true });
            await mkdir(feedbackFolder, { recursive: false });
            const screenshotName = `screenshot${image.extension}`;
            const record = {
                feedback_id: feedbackId,
                created_at: now.toISOString(),
                status: 'open',
                screenshot: screenshotName,
                image_mime_type: image.mimeType,
                ...metadata,
            };
            await writeFile(path.join(feedbackFolder, screenshotName), image.bytes, { flag: 'wx' });
            await writeFile(path.join(feedbackFolder, 'feedback.json'), `${JSON.stringify(record, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
            await appendFile(path.join(config.feedbackRoot, 'feedback-index.jsonl'), `${JSON.stringify({
                feedback_id: feedbackId,
                created_at: record.created_at,
                status: record.status,
                theme_name: record.theme_name,
                version_name: record.version_name,
                screen: record.screen,
                comment: record.comment,
                relative_folder: path.relative(config.feedbackRoot, feedbackFolder),
            })}\n`, 'utf8');

            return res.status(201).json({
                feedback_id: feedbackId,
                theme_name: record.theme_name,
                version_name: record.version_name,
                saved: true,
            });
        } catch (error) {
            console.error('[theme-feedback] Failed to save feedback:', error);
            return res.status(400).json({ error: error?.message || String(error) });
        }
    });
}

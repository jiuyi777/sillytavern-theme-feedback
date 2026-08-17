import { getStore } from '@netlify/blobs';
import { randomBytes, timingSafeEqual } from 'node:crypto';

declare const Netlify: { env: { get(name: string): string | undefined } };

const MAX_REQUEST_BYTES = 5_500_000;
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
const STORE_NAME = 'theme-feedback-pending';
const ALLOWED_IMAGE_TYPES = new Map([
    ['image/png', '.png'],
    ['image/jpeg', '.jpg'],
    ['image/webp', '.webp'],
]);

const corsHeaders = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Authorization, Content-Type',
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
};

function json(body: unknown, status = 200) {
    return new Response(JSON.stringify(body), {
        status,
        headers: { ...corsHeaders, 'Content-Type': 'application/json; charset=utf-8' },
    });
}

function env(name: string) {
    return Netlify.env.get(name)?.trim() || '';
}

function relayConfigured() {
    return Boolean(
        env('THEME_FEEDBACK_UPLOAD_SECRET').length >= 20
        && env('THEME_FEEDBACK_SYNC_SECRET').length >= 32,
    );
}

function safeEqual(left: string, right: string) {
    const leftBytes = Buffer.from(left);
    const rightBytes = Buffer.from(right);
    return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function bearer(request: Request) {
    return request.headers.get('authorization')?.replace(/^Bearer\s+/i, '').trim() || '';
}

function authorized(request: Request, secretName: string, minimumLength: number) {
    const expected = env(secretName);
    return expected.length >= minimumLength && safeEqual(bearer(request), expected);
}

function cleanText(value: unknown, fallback: string, maxLength: number) {
    const text = String(value || '').trim().slice(0, maxLength);
    return text || fallback;
}

function parseImage(dataUrl: unknown) {
    const match = String(dataUrl || '').match(/^data:(image\/(?:png|jpeg|webp));base64,([A-Za-z0-9+/=\s]+)$/);
    if (!match || !ALLOWED_IMAGE_TYPES.has(match[1])) {
        throw new Error('截图必须是 PNG、JPEG 或 WebP。');
    }
    const base64 = match[2].replace(/\s/g, '');
    const bytes = Buffer.from(base64, 'base64');
    if (!bytes.length || bytes.length > MAX_IMAGE_BYTES) {
        throw new Error('截图大小必须在 1 字节到 4 MB 之间。');
    }
    return {
        dataUrl: `data:${match[1]};base64,${base64}`,
        bytes: bytes.length,
        mimeType: match[1],
        extension: ALLOWED_IMAGE_TYPES.get(match[1])!,
    };
}

function normalizeMetadata(input: Record<string, unknown>) {
    const comment = cleanText(input.comment, '', 2000);
    if (!comment) {
        throw new Error('请填写问题说明。');
    }
    return {
        theme_id: cleanText(input.theme_id, 'local-theme', 100),
        theme_name: cleanText(input.theme_name, '未知主题', 128),
        version_name: cleanText(input.version_name, '本地版本', 100),
        version: cleanText(input.version, '', 80),
        catalog_sha256: cleanText(input.catalog_sha256, '', 64),
        runtime_fingerprint: cleanText(input.runtime_fingerprint, '', 64),
        match_status: ['matched', 'modified', 'local'].includes(String(input.match_status)) ? String(input.match_status) : 'local',
        screen: cleanText(input.screen, '未知窗口', 100),
        viewport: cleanText(input.viewport, '', 40),
        platform: cleanText(input.platform, '', 120),
        sillytavern_version: cleanText(input.sillytavern_version, '', 40),
        comment,
    };
}

function store() {
    return getStore({ name: STORE_NAME, consistency: 'strong' });
}

function pendingKey(feedbackId: string) {
    return `pending/${feedbackId}.json`;
}

async function queueFeedback(input: Record<string, unknown>) {
    const metadata = normalizeMetadata(input);
    const image = parseImage(input.image_data_url);
    const timestamp = new Date().toISOString().replace(/[-:T]/g, '').replace(/\.\d{3}Z$/, 'Z');
    const feedbackId = `${timestamp}-${randomBytes(3).toString('hex')}`;
    const record = {
        feedback_id: feedbackId,
        created_at: new Date().toISOString(),
        status: 'open',
        screenshot: `screenshot${image.extension}`,
        image_mime_type: image.mimeType,
        image_bytes: image.bytes,
        image_data_url: image.dataUrl,
        ...metadata,
    };
    await store().setJSON(pendingKey(feedbackId), record);
    return record;
}

async function pullPending(request: Request) {
    if (!authorized(request, 'THEME_FEEDBACK_SYNC_SECRET', 32)) {
        return json({ error: '同步凭据无效。' }, 401);
    }
    const after = new URL(request.url).searchParams.get('after') || '';
    const afterKey = /^\d{14}Z-[a-f0-9]{6}$/.test(after) ? pendingKey(after) : '';
    const pending = await store().list({ prefix: 'pending/' });
    const first = pending.blobs
        .sort((left, right) => left.key.localeCompare(right.key))
        .find(blob => !afterKey || blob.key > afterKey);
    if (!first) {
        return json({ items: [] });
    }
    const record = await store().get(first.key, { type: 'json' });
    return json({ items: record ? [record] : [] });
}

async function acknowledgePending(request: Request) {
    if (!authorized(request, 'THEME_FEEDBACK_SYNC_SECRET', 32)) {
        return json({ error: '同步凭据无效。' }, 401);
    }
    const input = await request.json() as { feedback_ids?: unknown };
    const ids = Array.isArray(input.feedback_ids)
        ? input.feedback_ids.map(String).filter(id => /^\d{14}Z-[a-f0-9]{6}$/.test(id)).slice(0, 20)
        : [];
    for (const id of ids) {
        await store().delete(pendingKey(id));
    }
    return json({ acknowledged: ids });
}

export default async (request: Request) => {
    if (request.method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: corsHeaders });
    }

    const mode = new URL(request.url).searchParams.get('mode');
    try {
        if (request.method === 'GET' && mode === 'pull') {
            return await pullPending(request);
        }
        if (request.method === 'POST' && mode === 'ack') {
            return await acknowledgePending(request);
        }
        if (request.method === 'GET') {
            if (!relayConfigured()) {
                return json({ ready: false, error: '中转服务尚未完成私人收件箱配置。' }, 503);
            }
            return json({ ready: true, max_image_bytes: MAX_IMAGE_BYTES });
        }
        if (request.method !== 'POST') {
            return json({ error: 'Method not allowed.' }, 405);
        }
        if (!authorized(request, 'THEME_FEEDBACK_UPLOAD_SECRET', 20)) {
            return json({ error: '私人上传码无效。' }, 401);
        }
        const contentLength = Number(request.headers.get('content-length') || 0);
        if (contentLength > MAX_REQUEST_BYTES) {
            return json({ error: '反馈数据超过 5.5 MB。' }, 413);
        }
        const input = await request.json() as Record<string, unknown>;
        const record = await queueFeedback(input);
        return json({ saved: true, feedback_id: record.feedback_id, created_at: record.created_at }, 201);
    } catch (error) {
        console.error('[theme-feedback-relay] Request failed:', error);
        return json({ error: error instanceof Error ? error.message : String(error) }, 400);
    }
};

export const config = {
    path: '/api/theme-feedback',
    method: ['GET', 'POST', 'OPTIONS'],
};

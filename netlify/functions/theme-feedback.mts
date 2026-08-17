import { randomBytes, timingSafeEqual } from 'node:crypto';

declare const Netlify: { env: { get(name: string): string | undefined } };

const MAX_REQUEST_BYTES = 5_500_000;
const MAX_IMAGE_BYTES = 4 * 1024 * 1024;
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

function safeEqual(left: string, right: string) {
    const leftBytes = Buffer.from(left);
    const rightBytes = Buffer.from(right);
    return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function authorize(request: Request) {
    const expected = env('THEME_FEEDBACK_UPLOAD_SECRET');
    const provided = request.headers.get('authorization')?.replace(/^Bearer\s+/i, '').trim() || '';
    return expected.length >= 20 && safeEqual(provided, expected);
}

function cleanText(value: unknown, fallback: string, maxLength: number) {
    const text = String(value || '').trim().slice(0, maxLength);
    return text || fallback;
}

function safePathSegment(value: unknown, fallback: string) {
    const segment = cleanText(value, fallback, 100)
        .normalize('NFKC')
        .replace(/[<>:"/\\|?*\u0000-\u001F]/g, '_')
        .replace(/\.\.+/g, '_')
        .replace(/[. ]+$/g, '')
        .trim();
    return segment || fallback;
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
    return { base64, bytes: bytes.length, mimeType: match[1], extension: ALLOWED_IMAGE_TYPES.get(match[1])! };
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

async function github(path: string, init: RequestInit = {}) {
    const token = env('THEME_FEEDBACK_GITHUB_TOKEN');
    if (!token) {
        throw new Error('中转服务尚未配置 GitHub 写入凭据。');
    }
    const response = await fetch(`https://api.github.com${path}`, {
        ...init,
        headers: {
            'Accept': 'application/vnd.github+json',
            'Authorization': `Bearer ${token}`,
            'Content-Type': 'application/json',
            'User-Agent': 'sillytavern-theme-feedback-relay',
            'X-GitHub-Api-Version': '2022-11-28',
            ...init.headers,
        },
    });
    const result = await response.json().catch(() => ({}));
    if (!response.ok) {
        throw new Error(`GitHub 写入失败：HTTP ${response.status} ${String(result?.message || '')}`.trim());
    }
    return result;
}

async function commitFeedback(metadata: ReturnType<typeof normalizeMetadata>, image: ReturnType<typeof parseImage>, feedbackId: string) {
    const owner = env('THEME_FEEDBACK_GITHUB_OWNER');
    const repo = env('THEME_FEEDBACK_GITHUB_REPO');
    const branch = env('THEME_FEEDBACK_GITHUB_BRANCH') || 'main';
    if (!owner || !repo) {
        throw new Error('中转服务尚未配置私有反馈仓库。');
    }
    const repoPath = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}`;
    const ref = await github(`${repoPath}/git/ref/heads/${encodeURIComponent(branch)}`);
    const parent = await github(`${repoPath}/git/commits/${ref.object.sha}`);
    const imageBlob = await github(`${repoPath}/git/blobs`, {
        method: 'POST',
        body: JSON.stringify({ content: image.base64, encoding: 'base64' }),
    });
    const folder = [
        'feedback',
        safePathSegment(metadata.theme_name, '未知主题'),
        safePathSegment(metadata.version_name, '本地版本'),
        feedbackId,
    ].join('/');
    const record = {
        feedback_id: feedbackId,
        created_at: new Date().toISOString(),
        status: 'open',
        screenshot: `screenshot${image.extension}`,
        image_mime_type: image.mimeType,
        image_bytes: image.bytes,
        ...metadata,
    };
    const metadataBlob = await github(`${repoPath}/git/blobs`, {
        method: 'POST',
        body: JSON.stringify({ content: `${JSON.stringify(record, null, 2)}\n`, encoding: 'utf-8' }),
    });
    const tree = await github(`${repoPath}/git/trees`, {
        method: 'POST',
        body: JSON.stringify({
            base_tree: parent.tree.sha,
            tree: [
                { path: `${folder}/screenshot${image.extension}`, mode: '100644', type: 'blob', sha: imageBlob.sha },
                { path: `${folder}/feedback.json`, mode: '100644', type: 'blob', sha: metadataBlob.sha },
            ],
        }),
    });
    const commit = await github(`${repoPath}/git/commits`, {
        method: 'POST',
        body: JSON.stringify({
            message: `feedback: ${metadata.theme_name} / ${metadata.version_name} / ${feedbackId}`,
            tree: tree.sha,
            parents: [ref.object.sha],
        }),
    });
    await github(`${repoPath}/git/refs/heads/${encodeURIComponent(branch)}`, {
        method: 'PATCH',
        body: JSON.stringify({ sha: commit.sha, force: false }),
    });
    return record;
}

export default async (request: Request) => {
    if (request.method === 'OPTIONS') {
        return new Response(null, { status: 204, headers: corsHeaders });
    }
    if (request.method === 'GET') {
        return json({ ready: true, max_image_bytes: MAX_IMAGE_BYTES });
    }
    if (request.method !== 'POST') {
        return json({ error: 'Method not allowed.' }, 405);
    }
    if (!authorize(request)) {
        return json({ error: '私人上传码无效。' }, 401);
    }
    const contentLength = Number(request.headers.get('content-length') || 0);
    if (contentLength > MAX_REQUEST_BYTES) {
        return json({ error: '反馈数据超过 5.5 MB。' }, 413);
    }
    try {
        const input = await request.json() as Record<string, unknown>;
        const metadata = normalizeMetadata(input);
        const image = parseImage(input.image_data_url);
        const timestamp = new Date().toISOString().replace(/[-:T]/g, '').replace(/\.\d{3}Z$/, 'Z');
        const feedbackId = `${timestamp}-${randomBytes(3).toString('hex')}`;
        const record = await commitFeedback(metadata, image, feedbackId);
        return json({ saved: true, feedback_id: record.feedback_id, created_at: record.created_at }, 201);
    } catch (error) {
        console.error('[theme-feedback-relay] Upload failed:', error);
        return json({ error: error instanceof Error ? error.message : String(error) }, 400);
    }
};

export const config = {
    path: '/api/theme-feedback',
    method: ['GET', 'POST', 'OPTIONS'],
};

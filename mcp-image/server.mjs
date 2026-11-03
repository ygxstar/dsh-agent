#!/usr/bin/env node
// apimart-image：零依赖 MCP stdio 服务器，暴露 generate_image 工具（ADR-0003）。
// 传输：换行分隔的 JSON-RPC 2.0（MCP stdio 约定）。
// APIMart gpt-image-2 为异步任务：POST /images/generations 取 task_id → GET /tasks/{id} 轮询。
import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';

const BASE = (process.env.APIMART_BASE_URL || 'https://api.apimart.ai/v1').replace(/\/+$/, '');
const MODEL = process.env.APIMART_IMAGE_MODEL || 'gpt-image-2';
const API_KEY = process.env.APIMART_API_KEY || '';
const POLL_INTERVAL_MS = 2000;
// 必须小于 dsh-mcp-client 的 toolCallTimeoutMs（300000），留出收尾余量
const TASK_DEADLINE_MS = 270000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function send(msg) {
  process.stdout.write(JSON.stringify(msg) + '\n');
}

function reply(id, result) {
  send({ jsonrpc: '2.0', id, result });
}

function replyError(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

const GENERATE_TOOL = {
  name: 'generate_image',
  description:
    '调用 APIMart gpt-image-2 生成或改写图像，返回图像本身。' +
    '提供 image_urls 时为图生图（可拿已生成的结果图继续修改），否则为文生图。' +
    '常与 mono-color-skill 配合：先用技能产出单色海报的英文 prompt，再调用本工具。',
  inputSchema: {
    type: 'object',
    properties: {
      prompt: { type: 'string', description: '图像描述（支持中英文，越具体越好）' },
      image_urls: {
        type: 'array',
        maxItems: 15,
        items: { type: 'string' },
        description:
          '参考图，最多 15 张：公开 URL，或 base64 data URI（data:image/png;base64,...）。' +
          '传入即进入图生图模式；不传则按 size 比例输出。',
      },
      size: {
        type: 'string',
        description:
          '输出宽高比，如 1:1 / 3:2 / 2:3 / 4:3 / 16:9 / 9:16 / 21:9，或像素如 1024x1536；省略则 1:1（图生图省略则跟随输入图比例）',
      },
      resolution: {
        type: 'string',
        enum: ['1k', '2k', '4k'],
        description: '输出像素档位，默认 1k',
      },
      nsfw_check: { type: 'boolean', description: '提交前先过内容审核，默认 false' },
      save_path: {
        type: 'string',
        description:
          '图片落盘的绝对路径（推荐，用 pwd 查看当前工作区）。' +
          '提供后图片直接写入该文件，工具只返回路径与字节数，不返回图像内容——' +
          '大幅图像经会话回传会撑爆上下文导致渲染失败，凡是要把图保存到工作区都应传本参数。',
      },
    },
    required: ['prompt'],
  },
};

function errorText(body) {
  if (!body) return 'no response body';
  if (body.error) return body.error.message || JSON.stringify(body.error);
  return JSON.stringify(body).slice(0, 500);
}

async function apimartFetch(path, init) {
  const res = await fetch(`${BASE}${path}`, {
    ...init,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${API_KEY}`, ...(init?.headers || {}) },
  });
  let body = null;
  try {
    body = await res.json();
  } catch {
    /* non-JSON */
  }
  if (!res.ok) throw new Error(`APIMart HTTP ${res.status}: ${errorText(body)}`);
  if (body && body.error) throw new Error(`APIMart: ${errorText(body)}`);
  return body;
}

function pickImageUrl(task) {
  const images = task?.result?.images ?? task?.images;
  if (!Array.isArray(images) || images.length === 0) {
    throw new Error(`APIMart 任务没有返回图片数据: ${JSON.stringify(task).slice(0, 400)}`);
  }
  const first = images[0];
  if (typeof first === 'string') return first;
  let url = first?.url;
  if (Array.isArray(url)) url = url[0];
  if (typeof url !== 'string' || !url) {
    throw new Error(`APIMart 图片数据中没有有效 URL: ${JSON.stringify(first).slice(0, 300)}`);
  }
  return url;
}

function sniffMime(bytes) {
  if (bytes[0] === 0x89 && bytes[1] === 0x50) return 'image/png';
  if (bytes[0] === 0xff && bytes[1] === 0xd8) return 'image/jpeg';
  if (bytes[0] === 0x47 && bytes[1] === 0x49) return 'image/gif';
  if (bytes.slice(0, 4).toString() === 'RIFF' && bytes.slice(8, 12).toString() === 'WEBP') return 'image/webp';
  return 'image/png';
}

async function fetchImage(url) {
  if (url.startsWith('data:')) {
    const [header, payload] = url.split(',', 2);
    const base64 = header.includes(';base64');
    const buf = Buffer.from(payload, base64 ? 'base64' : 'utf8');
    const mime = header.slice(5, header.indexOf(';')) || header.slice(5) || sniffMime(buf);
    return { buf, mime };
  }
  const res = await fetch(url);
  if (!res.ok) throw new Error(`下载结果图失败 HTTP ${res.status}: ${url}`);
  const buf = Buffer.from(await res.arrayBuffer());
  const mime = (res.headers.get('content-type') || '').split(';')[0].trim() || sniffMime(buf);
  return { buf, mime };
}

async function generateImage(args) {
  if (!API_KEY) throw new Error('APIMART_API_KEY 未配置');
  const payload = { model: MODEL, prompt: args.prompt, n: 1 };
  if (args.size) payload.size = args.size;
  if (args.resolution) payload.resolution = args.resolution;
  if (args.nsfw_check === true) payload.nsfw_check = true;
  if (args.image_urls !== undefined) {
    if (!Array.isArray(args.image_urls) || args.image_urls.length === 0) {
      throw new Error('image_urls 必须是非空数组');
    }
    if (args.image_urls.length > 15) throw new Error('image_urls exceeds max 15');
    payload.image_urls = args.image_urls;
  }

  const submitted = await apimartFetch('/images/generations', {
    method: 'POST',
    body: JSON.stringify(payload),
  });
  const taskId = submitted?.data?.[0]?.task_id || submitted?.data?.task_id || submitted?.task_id;
  if (!taskId) throw new Error(`APIMart 未返回 task_id: ${JSON.stringify(submitted).slice(0, 400)}`);

  const deadline = Date.now() + TASK_DEADLINE_MS;
  for (;;) {
    await sleep(POLL_INTERVAL_MS);
    if (Date.now() > deadline) throw new Error(`APIMart 任务超时（${TASK_DEADLINE_MS / 1000}s）: ${taskId}`);
    const res = await fetch(`${BASE}/tasks/${encodeURIComponent(taskId)}?language=zh`, {
      headers: { Authorization: `Bearer ${API_KEY}` },
    });
    const body = await res.json().catch(() => null);
    if (!res.ok) throw new Error(`APIMart 查询任务 HTTP ${res.status}: ${errorText(body)}`);
    const task = body?.data ?? body;
    const status = String(task?.status || '').toLowerCase();
    if (status === 'completed' || status === 'complete' || status === 'succeeded' || status === 'success') {
      const { buf, mime } = await fetchImage(pickImageUrl(task));
      return { taskId, buf, mime };
    }
    if (['failed', 'error', 'canceled', 'cancelled'].includes(status)) {
      const err = task?.error || task?.message || '远端任务失败';
      throw new Error(`APIMart 任务失败: ${typeof err === 'object' ? err.message || JSON.stringify(err) : err}`);
    }
  }
}

async function handleToolsCall(id, params) {
  try {
    if (params?.name !== 'generate_image') throw new Error(`未知工具: ${params?.name}`);
    const args = params.arguments || {};
    const { taskId, buf, mime } = await generateImage(args);
    if (typeof args.save_path === 'string' && args.save_path) {
      // 直接落盘、只回路径：大 base64 图像块经会话回传会撑爆 harness 渲染
      const target = path.resolve(args.save_path);
      mkdirSync(path.dirname(target), { recursive: true });
      writeFileSync(target, buf);
      reply(id, { content: [{ type: 'text', text: `生成完成 task_id=${taskId} 已保存到 ${target} mime=${mime} bytes=${buf.length}` }] });
      return;
    }
    reply(id, {
      content: [
        { type: 'text', text: `生成完成 task_id=${taskId} mime=${mime} bytes=${buf.length}` },
        { type: 'image', data: buf.toString('base64'), mimeType: mime },
      ],
    });
  } catch (err) {
    reply(id, { content: [{ type: 'text', text: `generate_image 失败: ${err?.message || err}` }], isError: true });
  }
}

const rl = readline.createInterface({ input: process.stdin, crlfDelay: Infinity });
rl.on('line', (line) => {
  const trimmed = line.trim();
  if (!trimmed) return;
  let msg;
  try {
    msg = JSON.parse(trimmed);
  } catch {
    return; // 非法帧：忽略，不能让服务器退出
  }
  const { id, method, params } = msg;
  const isRequest = id !== undefined && id !== null;

  if (method === 'initialize') {
    reply(id, {
      protocolVersion: params?.protocolVersion || '2025-06-18',
      capabilities: { tools: {} },
      serverInfo: { name: 'apimart-image', version: '1.0.0' },
    });
    return;
  }
  if (method === 'tools/list') {
    reply(id, { tools: [GENERATE_TOOL] });
    return;
  }
  if (method === 'tools/call') {
    void handleToolsCall(id, params);
    return;
  }
  if (method === 'ping') {
    reply(id, {});
    return;
  }
  if (isRequest) replyError(id, -32601, `Method not found: ${method}`);
  // 其余 notification（initialized / cancelled 等）静默忽略
});

rl.on('close', () => process.exit(0));

// Adapted from yejinshengge/processon-notion-embed (MIT).
// See public/licenses/processon-notion-embed.txt for the original license.
import type { ProcessOnEmbedInput, ProcessOnEmbedResult, NotionPageConnection } from "../shared/types";

export const NOTION_API = "https://api.notion.com/v1";
export const NOTION_VERSION = "2026-03-11";

export class ToolError extends Error {
  readonly field?: string;
  readonly code: string;
  readonly uncertain: boolean;

  constructor(message: string, options: { field?: string; code?: string; uncertain?: boolean } = {}) {
    super(message);
    this.name = "ToolError";
    this.field = options.field;
    this.code = options.code ?? "tool_error";
    this.uncertain = options.uncertain ?? false;
  }
}

export function normalizeProcessOn(input: string): string {
  let value = String(input ?? "").trim();
  if (/^<iframe\b/i.test(value)) {
    const match = value.match(/\ssrc\s*=\s*(["'])(.*?)\1/i);
    if (!match) throw new ToolError("iframe 代码中没有找到 src 链接，请复制 ProcessOn 的嵌入链接。", { field: "processon-url" });
    value = match[2].replaceAll("&amp;", "&");
  }
  let url: URL;
  try { url = new URL(value); } catch {
    throw new ToolError("请粘贴完整的 ProcessOn 嵌入链接，或其 iframe 代码。", { field: "processon-url" });
  }
  if (url.protocol !== "https:" || !["processon.com", "www.processon.com"].includes(url.hostname) || url.username || url.password || url.port) {
    throw new ToolError("仅支持 https://www.processon.com/embed/… 形式的官方嵌入链接。", { field: "processon-url" });
  }
  const match = url.pathname.match(/^\/embed\/([a-f0-9]{24})\/?$/i);
  if (!match) throw new ToolError("这是普通页面链接。请在 ProcessOn「分享 → 嵌入第三方」中复制嵌入链接。", { field: "processon-url" });
  return `https://www.processon.com/embed/${match[1].toLowerCase()}`;
}

const UUID_AT_END = /(?:^|[^a-f0-9])([a-f0-9]{32}|[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/i;
const RAW_UUID = /^([a-f0-9]{32}|[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12})$/i;

export function parseNotionPage(input: string): string {
  const value = String(input ?? "").trim();
  let id = value.match(RAW_UUID)?.[1];
  if (!id) {
    let url: URL;
    try { url = new URL(value); } catch {
      throw new ToolError("请粘贴完整的 Notion 页面链接，或页面 ID。", { field: "notion-url" });
    }
    const host = url.hostname;
    const allowed = ["app.notion.com", "notion.so", "www.notion.so", "notion.site"].includes(host) || host.endsWith(".notion.site");
    if (!allowed || url.protocol !== "https:" || url.username || url.password || url.port) {
      throw new ToolError("请使用 notion.so、app.notion.com 或 notion.site 的官方页面链接。", { field: "notion-url" });
    }
    let pathname: string;
    try { pathname = decodeURIComponent(url.pathname); } catch {
      throw new ToolError("Notion 链接的编码不完整，请重新复制页面链接。", { field: "notion-url" });
    }
    id = (pathname.split("/").filter(Boolean).at(-1) ?? "").match(UUID_AT_END)?.[1];
    if (!id) throw new ToolError("链接中没有找到页面 ID，请在目标 Notion 页面中重新复制链接。", { field: "notion-url" });
  }
  const raw = id.replaceAll("-", "").toLowerCase();
  return `${raw.slice(0, 8)}-${raw.slice(8, 12)}-${raw.slice(12, 16)}-${raw.slice(16, 20)}-${raw.slice(20)}`;
}

export function normalizeToken(input: string): string {
  const token = String(input ?? "").trim().replace(/^Bearer\s+/i, "");
  if (!token) throw new ToolError("请先到配置页填写并保存 Notion 内部集成密钥。", { field: "notion-token" });
  if (token.length < 20 || token.length > 500 || !/^[a-z0-9_.=\-]+$/i.test(token)) {
    throw new ToolError("凭证格式不完整，请到配置页重新复制并保存完整的 Notion 密钥。", { field: "notion-token" });
  }
  return token;
}

interface RichText {
  type?: string;
  plain_text?: string;
  text?: { content: string };
}

interface NotionPage {
  object: string;
  in_trash?: boolean;
  archived?: boolean;
  properties?: Record<string, { type: string; title?: RichText[] }>;
}

interface NotionBlock {
  object?: string;
  id?: string;
  type: string;
  in_trash?: boolean;
  archived?: boolean;
  embed?: { url: string; caption?: RichText[] };
  heading_2?: { rich_text: RichText[] };
}

interface BlockList {
  results: NotionBlock[];
  has_more: boolean;
  next_cursor?: string | null;
}

export function buildEmbedPayload({ embedUrl, title = "", position = "end" }: Omit<ProcessOnEmbedInput, "pageId">): {
  children: NotionBlock[];
  position: { type: "start" | "end" };
} {
  const url = normalizeProcessOn(embedUrl);
  const heading = String(title).trim();
  if (heading.length > 80) throw new ToolError("标题最多 80 个字符。", { field: "block-title" });
  if (!["start", "end"].includes(position)) throw new ToolError("请选择页面顶部或页面底部。", { field: "position" });
  const children: NotionBlock[] = [];
  if (heading) children.push({ object: "block", type: "heading_2", heading_2: { rich_text: [{ type: "text", text: { content: heading } }] } });
  children.push({ object: "block", type: "embed", embed: { url, caption: [] } });
  return { children, position: { type: position } };
}

export function notionPageUrl(pageId: string, blockId?: string): string {
  const page = parseNotionPage(pageId).replaceAll("-", "");
  const block = blockId ? parseNotionPage(blockId).replaceAll("-", "") : "";
  return `https://app.notion.com/p/${page}${block ? `#${block}` : ""}`;
}

export function readPageTitle(page: NotionPage): string {
  const title = Object.values(page.properties ?? {}).find((property) => property?.type === "title");
  return title?.title?.map((part) => part.plain_text ?? part.text?.content ?? "").join("") || "未命名页面";
}

function responseError(status: number, write: boolean): ToolError {
  if (status === 401) return new ToolError("Notion 未接受这个凭证。请到配置页检查密钥是否完整或已经失效。", { code: "unauthorized", field: "notion-token" });
  if (status === 403) return new ToolError("连接缺少所需权限。请开启「读取内容」和「插入内容」，并授权目标页面。", { code: "restricted_resource" });
  if (status === 404) return new ToolError("找不到可访问的目标页面。请在该页面右上角「••• → 连接」中添加你的 Notion 集成，并核对页面链接。", { code: "object_not_found", field: "notion-url" });
  if (status === 429) return new ToolError("Notion 请求过于频繁，请稍等片刻再试。", { code: "rate_limited" });
  if (status === 400) return new ToolError("Notion 无法处理本次请求。请检查目标是否为页面，以及链接和标题是否完整。", { code: "validation_error" });
  if (status === 409) return new ToolError("页面正在发生其他修改，请稍后重试。工具会先检查是否已有相同图表。", { code: "conflict_error", uncertain: write });
  if (write && status >= 500) return new ToolError("Notion 暂时未确认写入结果。请先打开目标页面查看，再重试，避免重复添加。", { code: "uncertain_write", uncertain: true });
  return new ToolError("Notion 服务暂时不可用，请稍后重试。", { code: "service_unavailable" });
}

interface ClientOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  sleep?: (ms: number) => Promise<unknown>;
}

export class NotionClient {
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;
  private readonly sleep: (ms: number) => Promise<unknown>;

  constructor(token: string, { fetchImpl = globalThis.fetch, timeoutMs = 20000, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) }: ClientOptions = {}) {
    this.token = normalizeToken(token);
    this.fetchImpl = (...args) => fetchImpl.call(globalThis, ...args);
    this.timeoutMs = timeoutMs;
    this.sleep = sleep;
  }

  async request<T>(path: string, { method = "GET", body }: { method?: "GET" | "PATCH"; body?: unknown } = {}, attempt = 0): Promise<T> {
    // User input never controls the origin receiving the saved credential.
    if (!/^\/(pages|blocks)\/[a-f0-9-]{36}(?:\/children(?:\?.*)?)?$/i.test(path)) {
      throw new ToolError("请求地址无效。", { code: "invalid_path" });
    }
    const write = method !== "GET";
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMs);
    let response: Response;
    let data: unknown;
    try {
      response = await this.fetchImpl(`${NOTION_API}${path}`, {
        method,
        headers: { Authorization: `Bearer ${this.token}`, "Notion-Version": NOTION_VERSION, "Content-Type": "application/json", Accept: "application/json" },
        body: body ? JSON.stringify(body) : undefined,
        signal: controller.signal,
        credentials: "omit",
        mode: "cors",
        redirect: "error",
        referrerPolicy: "no-referrer"
      });
      data = await response.json().catch(() => null);
    } catch {
      throw new ToolError(write
        ? "连接中断或请求超时，写入结果尚未确认。请先打开目标页面查看，再重试。"
        : "无法连接 Notion。请检查网络是否能访问 api.notion.com，再重试。", {
        code: write ? "uncertain_write" : "network_error", uncertain: write
      });
    } finally {
      clearTimeout(timeout);
    }
    // Reads can retry rate limits. Never retry a write with an uncertain result.
    if (response.status === 429 && !write && attempt < 2) {
      const seconds = Number(response.headers.get("Retry-After"));
      await this.sleep(Math.min(3000, Math.max(1000, Number.isFinite(seconds) ? seconds * 1000 : 1000)));
      return this.request<T>(path, { method, body }, attempt + 1);
    }
    if (!response.ok) throw responseError(response.status, write);
    if (!data || typeof data !== "object" || Array.isArray(data)) {
      throw new ToolError(write ? "Notion 返回结果不完整。请先打开目标页面确认是否已写入。" : "Notion 返回结果不完整，请稍后重试。", { code: "invalid_response", uncertain: write });
    }
    return data as T;
  }

  async page(pageId: string): Promise<NotionPage> {
    const page = await this.request<NotionPage>(`/pages/${parseNotionPage(pageId)}`);
    if (page.object !== "page" || page.in_trash || page.archived) {
      throw new ToolError("目标不是可写入的页面，或该页面已在垃圾箱中。", { field: "notion-url" });
    }
    return page;
  }

  async children(pageId: string): Promise<NotionBlock[]> {
    const id = parseNotionPage(pageId);
    const blocks: NotionBlock[] = [];
    const seen = new Set<string>();
    let cursor: string | null | undefined;
    do {
      const query = new URLSearchParams({ page_size: "100" });
      if (cursor) query.set("start_cursor", cursor);
      const data = await this.request<BlockList>(`/blocks/${id}/children?${query}`);
      if (!Array.isArray(data.results) || data.results.some((block) => !block || typeof block.type !== "string") || typeof data.has_more !== "boolean") {
        throw new ToolError("无法读取页面区块，请稍后重试。", { code: "invalid_response" });
      }
      blocks.push(...data.results);
      if (!data.has_more) return blocks;
      cursor = data.next_cursor;
      if (typeof cursor !== "string" || !cursor || seen.has(cursor)) {
        throw new ToolError("页面区块分页结果不完整，已停止操作，没有写入内容。", { code: "invalid_response" });
      }
      seen.add(cursor);
    } while (cursor);
    return blocks;
  }
}

function matchingEmbed(block: NotionBlock, embedUrl: string): boolean {
  if (block.type !== "embed" || block.in_trash || block.archived) return false;
  try { return normalizeProcessOn(block.embed?.url ?? "") === embedUrl; } catch { return false; }
}

export async function checkNotionPage(token: string, pageId: string): Promise<NotionPageConnection> {
  const id = parseNotionPage(pageId);
  const page = await new NotionClient(token).page(id);
  return { pageId: id, pageTitle: readPageTitle(page), pageUrl: notionPageUrl(id) };
}

export async function embedGraph({ token, pageId, embedUrl, title, position, fetchImpl, onProgress = () => {} }: ProcessOnEmbedInput & {
  token: string;
  fetchImpl?: typeof fetch;
  onProgress?: (step: "page" | "duplicates" | "insert") => void;
}): Promise<ProcessOnEmbedResult> {
  const id = parseNotionPage(pageId);
  const payload = buildEmbedPayload({ embedUrl, title, position });
  const url = normalizeProcessOn(embedUrl);
  const client = new NotionClient(token, { fetchImpl });
  onProgress("page");
  const page = await client.page(id);
  onProgress("duplicates");
  const blocks = await client.children(id);
  const existing = blocks.find((block) => matchingEmbed(block, url));
  if (existing) {
    if (!existing.id || !RAW_UUID.test(existing.id)) throw new ToolError("已有图表的区块信息不完整，已停止写入，请稍后重试。", { code: "invalid_response" });
    return { created: false, pageTitle: readPageTitle(page), pageId: id, blockId: existing.id, url };
  }
  onProgress("insert");
  const result = await client.request<BlockList>(`/blocks/${id}/children`, { method: "PATCH", body: payload });
  const embedded = Array.isArray(result.results) ? result.results.find((block) => block && matchingEmbed(block, url)) : undefined;
  if (!embedded?.id || !RAW_UUID.test(embedded.id)) {
    throw new ToolError("Notion 返回的区块与预期不一致。请打开目标页面核对，暂时不要重复提交。", { code: "invalid_response", uncertain: true });
  }
  return { created: true, pageTitle: readPageTitle(page), pageId: id, blockId: embedded.id, url };
}

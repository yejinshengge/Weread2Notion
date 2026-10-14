import type { BackgroundRequest, BackgroundResponse } from "./types";

export class BackgroundError extends Error {
  readonly field?: string;
  readonly code?: string;
  readonly uncertain: boolean;

  constructor(response: Extract<BackgroundResponse<unknown>, { ok: false }>) {
    super(response.error);
    this.name = "BackgroundError";
    this.field = response.field;
    this.code = response.code;
    this.uncertain = response.uncertain ?? false;
  }
}

export async function sendBackgroundMessage<T>(request: BackgroundRequest): Promise<T> {
  const response = (await chrome.runtime.sendMessage(request)) as BackgroundResponse<T> | undefined;
  if (!response || (response.ok !== true && response.ok !== false)) {
    throw incompleteResponseError(request);
  }
  if (!response.ok) {
    if (typeof response.error !== "string") throw incompleteResponseError(request);
    throw new BackgroundError(response);
  }
  if (!hasCompleteResponseData(request, response.data)) throw incompleteResponseError(request);
  return response.data;
}

function hasCompleteResponseData(request: BackgroundRequest, data: unknown): boolean {
  if (data === undefined || data === null) return false;
  if (request.type !== "EMBED_PROCESSON" && request.type !== "CHECK_NOTION_PAGE") return true;
  if (typeof data !== "object" || Array.isArray(data)) return false;
  const result = data as Record<string, unknown>;
  if (typeof result.pageId !== "string" || typeof result.pageTitle !== "string") return false;
  return request.type === "CHECK_NOTION_PAGE"
    ? typeof result.pageUrl === "string"
    : typeof result.created === "boolean" && typeof result.blockId === "string" && typeof result.url === "string";
}

function incompleteResponseError(request: BackgroundRequest): BackgroundError {
  const embedding = request.type === "EMBED_PROCESSON";
  return new BackgroundError({
    ok: false,
    code: "invalid_response",
    uncertain: embedding,
    error: embedding
      ? "后台返回的嵌入结果不完整。请先打开目标 Notion 页面核对，再在扩展管理页重新加载插件并重新打开操作页。"
      : "后台服务返回结果不完整，请在扩展管理页重新加载插件并重新打开操作页。"
  });
}

export function openOptionsPage(): void {
  if (window.parent !== window) {
    window.parent.postMessage({ type: "SWITCH_TAB", tab: "settings" }, window.location.origin);
    return;
  }

  window.location.href = chrome.runtime.getURL("sync.html#settings");
}

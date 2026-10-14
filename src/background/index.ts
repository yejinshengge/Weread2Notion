import { getSettings, saveSettings } from "../storage";
import type {
  BackgroundRequest,
  BackgroundResponse,
  ProcessOnEmbedResult,
  SyncProgress,
  SyncSummary,
  WeReadBook
} from "../shared/types";
import { searchDatabasePages, syncBooksToNotion, validateDatabase } from "../services/notion";
import { fetchWeReadBooks, fetchWeReadHighlights, fetchWeReadNotebooks } from "../services/weread";
import { checkNotionPage, embedGraph, normalizeProcessOn, parseNotionPage, ToolError } from "../services/processon";

const pendingEmbeds = new Map<string, Promise<ProcessOnEmbedResult>>();
const handledRequestTypes = {
  FETCH_WEREAD_BOOKS: true,
  VALIDATE_NOTION: true,
  SEARCH_NOTION_PAGES: true,
  CHECK_NOTION_PAGE: true,
  EMBED_PROCESSON: true,
  SYNC_BOOKS: true
} satisfies Record<BackgroundRequest["type"], true>;

chrome.action.onClicked.addListener(() => {
  void chrome.tabs.create({ url: chrome.runtime.getURL("sync.html") });
});

chrome.runtime.onMessage.addListener((request: unknown, _sender, sendResponse) => {
  if (!isBackgroundRequest(request)) return false;

  handleRequest(request)
    .then((data) => sendResponse({ ok: true, data } satisfies BackgroundResponse<unknown>))
    .catch((error) => sendResponse({
      ok: false,
      error: getErrorMessage(error),
      ...(error instanceof ToolError ? { field: error.field, code: error.code, uncertain: error.uncertain } : {})
    } satisfies BackgroundResponse<unknown>));

  return true;
});

function isBackgroundRequest(request: unknown): request is BackgroundRequest {
  return Boolean(request) && typeof request === "object" && request !== null &&
    "type" in request && typeof request.type === "string" && Object.hasOwn(handledRequestTypes, request.type);
}

async function handleRequest(
  request: BackgroundRequest
): Promise<WeReadBook[] | SyncSummary | unknown> {
  switch (request.type) {
    case "FETCH_WEREAD_BOOKS": {
      const settings = await getSettings();
      return fetchWeReadBooks(settings.wereadApiKey, { includeStartReadAt: isStartReadAtEnabled(settings) });
    }
    case "VALIDATE_NOTION": {
      const validation = await validateDatabase(request.token, request.databaseIdOrUrl);
      const settings = await getSettings();
      await saveSettings({
        ...settings,
        notionToken: request.token,
        databaseUrl: request.databaseIdOrUrl,
        databaseId: validation.databaseId,
        dataSourceId: validation.dataSourceId,
        databaseProperties: validation.properties,
        lastValidatedAt: new Date().toISOString()
      });
      return validation;
    }
    case "SEARCH_NOTION_PAGES": {
      const settings = await getSettings();
      if (!settings.notionToken) {
        throw new Error("请先完成 Notion 设置");
      }
      return searchDatabasePages(settings.notionToken, request.databaseId, request.query);
    }
    case "CHECK_NOTION_PAGE": {
      const settings = await getSettings();
      return checkNotionPage(settings.notionToken, request.pageId);
    }
    case "EMBED_PROCESSON": {
      const settings = await getSettings();
      const pageId = parseNotionPage(request.input.pageId);
      const embedUrl = normalizeProcessOn(request.input.embedUrl);
      const key = `${pageId}:${embedUrl}`;
      const pending = pendingEmbeds.get(key);
      if (pending) return pending;
      const job = embedGraph({ ...request.input, token: settings.notionToken, pageId, embedUrl });
      pendingEmbeds.set(key, job);
      try {
        return await job;
      } finally {
        pendingEmbeds.delete(key);
      }
    }
    case "SYNC_BOOKS": {
      const settings = await getSettings();
      await publishSyncProgress({
        total: request.books.length,
        completed: 0,
        currentTitle: "正在读取微信读书笔记本...",
        stage: "preparing",
        highlightTotal: 0,
        highlightCompleted: 0,
        summary: { created: 0, updated: 0, skipped: 0, failed: [] }
      });
      const notebooks = await fetchWeReadNotebooks(settings.wereadApiKey);
      const notebooksByBookId = new Map(notebooks.map((book) => [book.bookId, book]));
      await publishSyncProgress({
        total: request.books.length,
        completed: 0,
        currentTitle: "正在准备 Notion 配置...",
        stage: "preparing",
        highlightTotal: 0,
        highlightCompleted: 0,
        summary: { created: 0, updated: 0, skipped: 0, failed: [] }
      });
      return syncBooksToNotion(settings, request.books, {
        onProgress: (progress) => publishSyncProgress(progress),
        getHighlights: (book) => {
          const notebook = notebooksByBookId.get(book.bookId);
          return notebook
            ? fetchWeReadHighlights(settings.wereadApiKey, book.bookId, notebook)
            : Promise.resolve([]);
        }
      });
    }
  }
}

async function publishSyncProgress(progress: SyncProgress): Promise<void> {
  try {
    await chrome.runtime.sendMessage({ type: "SYNC_PROGRESS", progress });
  } catch {
    // The sync page may be closed while the background task continues.
  }
}

function isStartReadAtEnabled(settings: Awaited<ReturnType<typeof getSettings>>): boolean {
  return settings.fieldMappings.some(
    (mapping) => mapping.sourceType === "field" && mapping.sourceField === "startReadAt" && mapping.propertyName
  );
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "未知错误";
}

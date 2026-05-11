import { getSettings, saveSettings } from "../storage";
import type {
  BackgroundRequest,
  BackgroundResponse,
  SyncProgress,
  SyncSummary,
  WeReadBook,
  WeReadHighlightNote,
  WeReadNotebookBook
} from "../shared/types";
import { searchDatabasePages, syncBookHighlightsToNotion, syncBooksToNotion, validateDatabase } from "../services/notion";
import { enrichBooksWithProgress, fetchWeReadBooks, fetchWeReadHighlights, fetchWeReadNotebooks } from "../services/weread";

chrome.action.onClicked.addListener(() => {
  void chrome.tabs.create({ url: chrome.runtime.getURL("sync.html") });
});

chrome.runtime.onMessage.addListener((request: BackgroundRequest, _sender, sendResponse) => {
  handleRequest(request)
    .then((data) => sendResponse({ ok: true, data } satisfies BackgroundResponse<unknown>))
    .catch((error) => sendResponse({ ok: false, error: getErrorMessage(error) } satisfies BackgroundResponse<unknown>));

  return true;
});

async function handleRequest(
  request: BackgroundRequest
): Promise<WeReadBook[] | WeReadNotebookBook[] | WeReadHighlightNote[] | SyncSummary | unknown> {
  switch (request.type) {
    case "FETCH_WEREAD_BOOKS": {
      const settings = await getSettings();
      return fetchWeReadBooks({ includeStartReadAt: isStartReadAtEnabled(settings) });
    }
    case "FETCH_WEREAD_NOTEBOOKS": {
      return fetchWeReadNotebooks();
    }
    case "FETCH_WEREAD_HIGHLIGHTS": {
      return fetchWeReadHighlights(request.book.bookId);
    }
    case "VALIDATE_NOTION": {
      const validation = await validateDatabase(request.token, request.databaseIdOrUrl);
      const settings = await getSettings();
      await saveSettings({
        ...settings,
        notionToken: request.token,
        databaseUrl: request.databaseIdOrUrl,
        databaseId: validation.databaseId,
        databaseProperties: validation.properties,
        lastValidatedAt: new Date().toISOString()
      });
      return validation;
    }
    case "VALIDATE_HIGHLIGHT_NOTION": {
      const validation = await validateDatabase(request.token, request.databaseIdOrUrl);
      const settings = await getSettings();
      await saveSettings({
        ...settings,
        notionToken: request.token,
        highlightDatabaseUrl: request.databaseIdOrUrl,
        highlightDatabaseId: validation.databaseId,
        highlightDatabaseProperties: validation.properties,
        lastHighlightValidatedAt: new Date().toISOString()
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
    case "SYNC_BOOKS": {
      const settings = await getSettings();
      const books = isStartReadAtEnabled(settings) ? await enrichBooksWithProgress(request.books) : request.books;
      return syncBooksToNotion(settings, books, {
        onProgress: (progress) => publishSyncProgress(progress)
      });
    }
    case "SYNC_BOOK_HIGHLIGHTS": {
      const settings = await getSettings();
      return syncBookHighlightsToNotion(settings, request.book, request.notes, {
        onProgress: (progress) => publishHighlightSyncProgress(progress)
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

async function publishHighlightSyncProgress(progress: SyncProgress): Promise<void> {
  try {
    await chrome.runtime.sendMessage({ type: "HIGHLIGHT_SYNC_PROGRESS", progress });
  } catch {
    // The highlights page may be closed while the background task continues.
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

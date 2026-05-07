import { getSettings, saveSettings } from "../storage";
import type { BackgroundRequest, BackgroundResponse, SyncProgress, SyncSummary, WeReadBook } from "../shared/types";
import { validateDatabase, syncBooksToNotion } from "../services/notion";
import { enrichBooksWithProgress, fetchWeReadBooks } from "../services/weread";

chrome.action.onClicked.addListener(() => {
  void chrome.tabs.create({ url: chrome.runtime.getURL("sync.html") });
});

chrome.runtime.onMessage.addListener((request: BackgroundRequest, _sender, sendResponse) => {
  handleRequest(request)
    .then((data) => sendResponse({ ok: true, data } satisfies BackgroundResponse<unknown>))
    .catch((error) => sendResponse({ ok: false, error: getErrorMessage(error) } satisfies BackgroundResponse<unknown>));

  return true;
});

async function handleRequest(request: BackgroundRequest): Promise<WeReadBook[] | SyncSummary | unknown> {
  switch (request.type) {
    case "FETCH_WEREAD_BOOKS": {
      const settings = await getSettings();
      return fetchWeReadBooks({ includeStartReadAt: isStartReadAtEnabled(settings) });
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
    case "SYNC_BOOKS": {
      const settings = await getSettings();
      const books = isStartReadAtEnabled(settings) ? await enrichBooksWithProgress(request.books) : request.books;
      return syncBooksToNotion(settings, books, {
        onProgress: (progress) => publishSyncProgress(progress)
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
  const mapping = settings.mappings.startReadAt;
  return Boolean(mapping?.enabled && mapping.propertyName);
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "未知错误";
}

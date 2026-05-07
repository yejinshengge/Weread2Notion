import "./styles.css";
import { openOptionsPage, sendBackgroundMessage } from "../shared/runtime";
import type { ExtensionSettings, SyncProgress, SyncSummary, WeReadBook } from "../shared/types";
import { getCachedBookList, getSettings, saveCachedBookList } from "../storage";

interface SyncState {
  settings: ExtensionSettings | null;
  books: WeReadBook[];
  selectedIds: Set<string>;
  loading: boolean;
  syncing: boolean;
  message: string;
  error: string;
  summary: SyncSummary | null;
  syncProgress: SyncProgress | null;
  cacheFetchedAt: string | null;
}

const state: SyncState = {
  settings: null,
  books: [],
  selectedIds: new Set(),
  loading: false,
  syncing: false,
  message: "",
  error: "",
  summary: null,
  syncProgress: null,
  cacheFetchedAt: null
};

const app = document.querySelector<HTMLDivElement>("#app");
document.body.classList.toggle("embedded", window.parent !== window);

void init();

async function init(): Promise<void> {
  const [settings, cachedBookList] = await Promise.all([getSettings(), getCachedBookList()]);
  state.settings = settings;
  if (cachedBookList) {
    state.books = cachedBookList.books;
    state.selectedIds = new Set(cachedBookList.selectedIds);
    state.cacheFetchedAt = cachedBookList.fetchedAt;
    state.message = `已恢复上次读取的 ${cachedBookList.books.length} 本书`;
  }
  render();
}

chrome.runtime.onMessage.addListener((message: { type?: string; progress?: SyncProgress }) => {
  if (message.type !== "SYNC_PROGRESS" || !message.progress) {
    return;
  }

  state.syncing = true;
  state.syncProgress = message.progress;
  state.summary = message.progress.summary;
  render();
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local" || !changes.settings) {
    return;
  }

  void refreshSettings();
});

function render(): void {
  if (!app) {
    return;
  }

  const bookListScrollTop = app.querySelector<HTMLElement>(".book-list")?.scrollTop ?? 0;
  const configured = isConfigured(state.settings);
  const selectedCount = state.selectedIds.size;
  const canSync = configured && selectedCount > 0 && !state.syncing && !state.loading;
  const fetchButtonDisabled = state.loading || state.syncing;

  app.innerHTML = `
    <main class="sync-shell">
      <header class="topbar">
        <div>
          <h1>WeRead to Notion</h1>
          <p>${configured ? "功能页：读取书架并同步选中的书籍" : "功能页：请先到配置页完成 Notion 与字段映射"}</p>
        </div>
        <button class="icon-button" id="open-options" title="切换到配置页">配置页</button>
      </header>

      ${renderStatus(configured)}

      <section class="toolbar">
        <button id="fetch-books" class="secondary" ${fetchButtonDisabled ? "disabled" : ""}>
          ${state.loading ? "读取中..." : "读取书架"}
        </button>
        <button id="select-all" class="ghost" ${state.books.length === 0 ? "disabled" : ""}>全选</button>
        <button id="select-none" class="ghost" ${state.books.length === 0 ? "disabled" : ""}>清空</button>
      </section>

      ${renderBooks()}

      ${renderSyncProgress()}

      ${renderSummary()}

      <footer class="footer">
        <span>${state.books.length > 0 ? `已选择 ${selectedCount} / ${state.books.length}` : "等待读取微信读书书架"}</span>
        <button id="sync-books" class="primary" ${canSync ? "" : "disabled"}>
          ${state.syncing ? "同步中..." : "同步到 Notion"}
        </button>
      </footer>
    </main>
  `;

  bindEvents();
  const bookList = app.querySelector<HTMLElement>(".book-list");
  if (bookList) {
    bookList.scrollTop = bookListScrollTop;
  }
}

async function refreshSettings(): Promise<void> {
  state.settings = await getSettings();
  render();
}

function renderStatus(configured: boolean): string {
  const mapping = state.settings?.mappings.wereadId;
  const idReady = Boolean(mapping?.enabled && mapping.propertyName);
  const items = [
    configured ? "Notion 已连接" : "Notion 未配置",
    idReady ? `去重字段：${escapeHtml(mapping?.propertyName ?? "")}` : "缺少 WeRead ID 映射"
  ];
  if (state.cacheFetchedAt && state.books.length > 0) {
    items.push(`书架缓存：${formatDate(state.cacheFetchedAt)}`);
  }
  const className = configured ? "status ok" : "status warn";

  return `
    <section class="${className}">
      ${items.map((item) => `<span>${item}</span>`).join("")}
      ${state.error ? `<strong>${escapeHtml(state.error)}</strong>` : ""}
      ${state.message ? `<strong>${escapeHtml(state.message)}</strong>` : ""}
    </section>
  `;
}

function renderBooks(): string {
  if (state.books.length === 0) {
    return `
      <section class="empty">
        <p>登录微信读书网页版后，点击“读取书架”。</p>
      </section>
    `;
  }

  return `
    <section class="book-list">
      ${state.books
        .map(
          (book) => `
            <label class="book-row">
              <input type="checkbox" data-book-id="${escapeHtml(book.bookId)}" ${
                state.selectedIds.has(book.bookId) ? "checked" : ""
              } />
              <img src="${escapeHtml(book.cover || "")}" alt="" />
              <span class="book-main">
                <strong>${escapeHtml(book.title)}</strong>
                <small>${escapeHtml([book.author, book.category].filter(Boolean).join(" · ") || "无作者/类别")}</small>
              </span>
              <span class="progress">${book.progress}%</span>
              <span class="badge">${book.status}</span>
            </label>
          `
        )
        .join("")}
    </section>
  `;
}

function renderSummary(): string {
  if (!state.summary) {
    return "";
  }

  const failed = state.summary.failed
    .map((item) => `<li>${escapeHtml(item.title)}：${escapeHtml(item.reason)}</li>`)
    .join("");

  return `
    <section class="summary">
      <div>
        <b>${state.summary.created}</b>
        <span>新建</span>
      </div>
      <div>
        <b>${state.summary.updated}</b>
        <span>更新</span>
      </div>
      <div>
        <b>${state.summary.skipped}</b>
        <span>跳过</span>
      </div>
      ${
        failed
          ? `<details open><summary>${state.summary.failed.length} 本失败</summary><ul>${failed}</ul></details>`
          : ""
      }
    </section>
  `;
}

function renderSyncProgress(): string {
  if (!state.syncing || !state.syncProgress) {
    return "";
  }

  const { completed, total, currentTitle, summary } = state.syncProgress;
  const percent = total > 0 ? Math.round((completed / total) * 100) : 0;
  const detail = currentTitle
    ? `正在同步：${currentTitle}`
    : completed >= total
      ? "正在收尾..."
      : "准备同步...";

  return `
    <section class="sync-progress">
      <div class="progress-heading">
        <strong>${completed} / ${total}</strong>
        <span>${percent}%</span>
      </div>
      <div class="progress-track" aria-label="同步进度">
        <span style="width: ${percent}%"></span>
      </div>
      <p>${escapeHtml(detail)}</p>
      <small>新建 ${summary.created} · 更新 ${summary.updated} · 失败 ${summary.failed.length}</small>
    </section>
  `;
}

function bindEvents(): void {
  document.querySelector("#open-options")?.addEventListener("click", openOptionsPage);
  document.querySelector("#fetch-books")?.addEventListener("click", fetchBooks);
  document.querySelector("#select-all")?.addEventListener("click", () => {
    state.selectedIds = new Set(state.books.map((book) => book.bookId));
    void persistCurrentBookList();
    render();
  });
  document.querySelector("#select-none")?.addEventListener("click", () => {
    state.selectedIds.clear();
    void persistCurrentBookList();
    render();
  });
  document.querySelector("#sync-books")?.addEventListener("click", syncSelectedBooks);

  document.querySelectorAll<HTMLInputElement>("input[data-book-id]").forEach((input) => {
    input.addEventListener("change", () => {
      const bookId = input.dataset.bookId;
      if (!bookId) {
        return;
      }
      if (input.checked) {
        state.selectedIds.add(bookId);
      } else {
        state.selectedIds.delete(bookId);
      }
      void persistCurrentBookList();
      render();
    });
  });
}

async function fetchBooks(): Promise<void> {
  state.loading = true;
  state.error = "";
  state.message = "";
  state.summary = null;
  render();

  try {
    const books = await sendBackgroundMessage<WeReadBook[]>({ type: "FETCH_WEREAD_BOOKS" });
    state.books = books;
    state.selectedIds = new Set(books.map((book) => book.bookId));
    state.cacheFetchedAt = new Date().toISOString();
    state.message = books.length > 0 ? `已读取 ${books.length} 本书` : "没有读取到书籍";
    await persistCurrentBookList();
  } catch (error) {
    state.error = getErrorMessage(error);
  } finally {
    state.loading = false;
    render();
  }
}

async function syncSelectedBooks(): Promise<void> {
  const selectedBooks = state.books.filter((book) => state.selectedIds.has(book.bookId));
  state.syncing = true;
  state.error = "";
  state.message = "";
  state.summary = null;
  state.syncProgress = {
    total: selectedBooks.length,
    completed: 0,
    summary: { created: 0, updated: 0, skipped: 0, failed: [] }
  };
  render();

  try {
    state.summary = await sendBackgroundMessage<SyncSummary>({ type: "SYNC_BOOKS", books: selectedBooks });
    state.message = "同步完成";
  } catch (error) {
    state.error = getErrorMessage(error);
  } finally {
    state.syncing = false;
    state.syncProgress = null;
    render();
  }
}

function isConfigured(settings: ExtensionSettings | null): boolean {
  return Boolean(
    settings?.notionToken &&
      settings.databaseId &&
      settings.mappings.wereadId.enabled &&
      settings.mappings.wereadId.propertyName
  );
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => {
    const entities: Record<string, string> = {
      "&": "&amp;",
      "<": "&lt;",
      ">": "&gt;",
      '"': "&quot;",
      "'": "&#39;"
    };
    return entities[char] ?? char;
  });
}

async function persistCurrentBookList(): Promise<void> {
  const fetchedAt = state.cacheFetchedAt ?? new Date().toISOString();
  state.cacheFetchedAt = fetchedAt;
  await saveCachedBookList({
    books: state.books,
    selectedIds: [...state.selectedIds],
    fetchedAt
  });
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    dateStyle: "short",
    timeStyle: "short"
  }).format(new Date(value));
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "未知错误";
}

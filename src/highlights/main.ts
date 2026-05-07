import "./styles.css";
import { openOptionsPage, sendBackgroundMessage } from "../shared/runtime";
import type { ExtensionSettings, SyncSummary, WeReadHighlightNote, WeReadNotebookBook } from "../shared/types";
import { getSettings } from "../storage";

interface HighlightsState {
  settings: ExtensionSettings | null;
  books: WeReadNotebookBook[];
  selectedBookId: string;
  notes: WeReadHighlightNote[];
  loadingBooks: boolean;
  loadingNotes: boolean;
  syncing: boolean;
  message: string;
  error: string;
  summary: SyncSummary | null;
}

const state: HighlightsState = {
  settings: null,
  books: [],
  selectedBookId: "",
  notes: [],
  loadingBooks: false,
  loadingNotes: false,
  syncing: false,
  message: "",
  error: "",
  summary: null
};

const app = document.querySelector<HTMLDivElement>("#app");
document.body.classList.toggle("embedded", window.parent !== window);

void init();

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

  const configured = isConfigured(state.settings);
  const selectedBook = getSelectedBook();
  const canSync = configured && selectedBook && state.notes.length > 0 && !state.syncing && !state.loadingNotes;

  app.innerHTML = `
    <main class="highlight-shell">
      <header class="topbar">
        <div>
          <h1>划线同步</h1>
          <p>${configured ? "读取微信读书笔记，并按书同步到 Notion 页面" : "请先配置划线同步数据库"}</p>
        </div>
        <button class="icon-button" id="open-options" type="button">配置页</button>
      </header>

      ${renderStatus(configured)}

      <section class="toolbar">
        <button id="fetch-notebooks" class="secondary" ${state.loadingBooks || state.syncing ? "disabled" : ""}>
          ${state.loadingBooks ? "读取中..." : "读取划线书籍"}
        </button>
      </section>

      <section class="workspace">
        ${renderBookList()}
        ${renderDetail(selectedBook, Boolean(canSync))}
      </section>

      ${renderSummary()}
    </main>
  `;

  bindEvents();
}

async function init(): Promise<void> {
  state.settings = await getSettings();
  render();
}

async function refreshSettings(): Promise<void> {
  state.settings = await getSettings();
  render();
}

function renderStatus(configured: boolean): string {
  const items = [
    configured ? "划线数据库已配置" : "划线数据库未配置",
    state.settings?.highlightDatabaseProperties.some((property) => property.name === "WeRead ID" || property.name === "Book ID")
      ? "去重字段：已检测到 Book ID"
      : "去重字段：按固定页面标题匹配"
  ];

  return `
    <section class="status ${configured ? "ok" : "warn"}">
      ${items.map((item) => `<span>${escapeHtml(item)}</span>`).join("")}
      ${state.error ? `<strong>${escapeHtml(state.error)}</strong>` : ""}
      ${state.message ? `<strong>${escapeHtml(state.message)}</strong>` : ""}
    </section>
  `;
}

function renderBookList(): string {
  if (state.books.length === 0) {
    return `
      <section class="empty-list">
        <p>登录微信读书网页版后，点击“读取划线书籍”。</p>
      </section>
    `;
  }

  return `
    <section class="book-list" aria-label="有划线或想法的书">
      ${state.books
        .map(
          (book) => `
            <button class="book-row ${book.bookId === state.selectedBookId ? "active" : ""}" type="button" data-book-id="${escapeHtml(
              book.bookId
            )}">
              <img src="${escapeHtml(book.cover || "")}" alt="" />
              <span class="book-main">
                <strong>${escapeHtml(book.title)}</strong>
                <small>${escapeHtml(book.author || "未知作者")}</small>
              </span>
              <span class="counts">
                <b>${book.noteCount}</b>
                <small>划线 ${book.bookmarkCount} · 想法 ${book.reviewCount}</small>
              </span>
            </button>
          `
        )
        .join("")}
    </section>
  `;
}

function renderDetail(book: WeReadNotebookBook | null, canSync: boolean): string {
  if (!book) {
    return `
      <section class="detail empty-detail">
        <p>选择一本书后，会列出这本书下当前账号的全部划线与想法。</p>
      </section>
    `;
  }

  return `
    <section class="detail">
      <header class="detail-header">
        <div>
          <h2>${escapeHtml(book.title)}</h2>
          <p>${escapeHtml(book.author || "未知作者")} · 共 ${state.notes.length} 条</p>
        </div>
        <button id="sync-highlights" class="primary" ${canSync ? "" : "disabled"}>
          ${state.syncing ? "同步中..." : "立即同步"}
        </button>
      </header>
      ${state.loadingNotes ? renderLoadingNotes() : renderNotes()}
    </section>
  `;
}

function renderLoadingNotes(): string {
  return `
    <div class="note-placeholder">
      <p>正在读取划线与想法...</p>
    </div>
  `;
}

function renderNotes(): string {
  if (state.notes.length === 0) {
    return `
      <div class="note-placeholder">
        <p>没有读取到划线或想法。</p>
      </div>
    `;
  }

  let currentChapter = "";
  return `
    <div class="note-list">
      ${state.notes
        .map((note) => {
          const chapter = note.chapterTitle || "未分章节";
          const heading = chapter !== currentChapter ? `<h3>${escapeHtml(chapter)}</h3>` : "";
          currentChapter = chapter;
          return `
            ${heading}
            <article class="note-card">
              ${note.original ? `<blockquote>${escapeHtml(note.original)}</blockquote>` : ""}
              ${note.thought ? `<p>${escapeHtml(note.thought)}</p>` : ""}
              <footer>${escapeHtml([note.userName, note.createdAt ? formatDate(note.createdAt) : undefined].filter(Boolean).join(" · "))}</footer>
            </article>
          `;
        })
        .join("")}
    </div>
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
      <div><b>${state.summary.created}</b><span>新建</span></div>
      <div><b>${state.summary.updated}</b><span>更新</span></div>
      <div><b>${state.summary.skipped}</b><span>跳过</span></div>
      ${failed ? `<details open><summary>${state.summary.failed.length} 本失败</summary><ul>${failed}</ul></details>` : ""}
    </section>
  `;
}

function bindEvents(): void {
  document.querySelector("#open-options")?.addEventListener("click", openOptionsPage);
  document.querySelector("#fetch-notebooks")?.addEventListener("click", fetchNotebooks);
  document.querySelector("#sync-highlights")?.addEventListener("click", syncCurrentBook);

  document.querySelectorAll<HTMLButtonElement>("[data-book-id]").forEach((button) => {
    button.addEventListener("click", () => {
      const bookId = button.dataset.bookId;
      if (bookId) {
        void selectBook(bookId);
      }
    });
  });
}

async function fetchNotebooks(): Promise<void> {
  state.loadingBooks = true;
  state.error = "";
  state.message = "";
  state.summary = null;
  render();

  try {
    state.books = await sendBackgroundMessage<WeReadNotebookBook[]>({ type: "FETCH_WEREAD_NOTEBOOKS" });
    state.message = state.books.length > 0 ? `已读取 ${state.books.length} 本有划线或想法的书` : "没有读取到划线书籍";
    if (state.books[0]) {
      await selectBook(state.books[0].bookId);
      return;
    }
  } catch (error) {
    state.error = getErrorMessage(error);
  } finally {
    state.loadingBooks = false;
    render();
  }
}

async function selectBook(bookId: string): Promise<void> {
  const book = state.books.find((item) => item.bookId === bookId);
  if (!book) {
    return;
  }

  state.selectedBookId = bookId;
  state.notes = [];
  state.loadingNotes = true;
  state.error = "";
  state.message = "";
  state.summary = null;
  render();

  try {
    state.notes = await sendBackgroundMessage<WeReadHighlightNote[]>({ type: "FETCH_WEREAD_HIGHLIGHTS", book });
  } catch (error) {
    state.error = getErrorMessage(error);
  } finally {
    state.loadingNotes = false;
    render();
  }
}

async function syncCurrentBook(): Promise<void> {
  const book = getSelectedBook();
  if (!book || state.notes.length === 0) {
    return;
  }

  state.syncing = true;
  state.error = "";
  state.message = "";
  state.summary = null;
  render();

  try {
    state.summary = await sendBackgroundMessage<SyncSummary>({
      type: "SYNC_BOOK_HIGHLIGHTS",
      book,
      notes: state.notes
    });
    state.message = state.summary.failed.length > 0 ? "同步完成，但有失败项" : "划线同步完成";
  } catch (error) {
    state.error = getErrorMessage(error);
  } finally {
    state.syncing = false;
    render();
  }
}

function getSelectedBook(): WeReadNotebookBook | null {
  return state.books.find((book) => book.bookId === state.selectedBookId) ?? null;
}

function isConfigured(settings: ExtensionSettings | null): boolean {
  return Boolean(settings?.notionToken && settings.highlightDatabaseId && getTitlePropertyName(settings));
}

function getTitlePropertyName(settings: ExtensionSettings): string {
  return settings.highlightDatabaseProperties.find((property) => property.type === "title")?.name ?? "";
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

function formatDate(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    dateStyle: "short",
    timeStyle: "short"
  }).format(new Date(value));
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "未知错误";
}

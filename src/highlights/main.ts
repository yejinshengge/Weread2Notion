import "./styles.css";
import {
  HIGHLIGHT_FIELD_LABELS,
  HIGHLIGHT_SYNC_FIELDS,
  getHighlightAllowedTypes,
  isWritablePropertyType
} from "../shared/fields";
import { bindCustomValueControls, renderCustomValueControl } from "../shared/customFields";
import { openOptionsPage, sendBackgroundMessage } from "../shared/runtime";
import type {
  DatabaseProperty,
  ExtensionSettings,
  FieldMappingEntry,
  HighlightSyncField,
  SyncSummary,
  WeReadHighlightNote,
  WeReadNotebookBook
} from "../shared/types";
import { getCachedHighlightBookList, getSettings, saveCachedHighlightBookList, saveSettings } from "../storage";
import { getHighlightFieldMappingError, getTitleProperty } from "../services/notion";

interface HighlightsState {
  settings: ExtensionSettings | null;
  books: WeReadNotebookBook[];
  selectedBookId: string;
  notes: WeReadHighlightNote[];
  loadingBooks: boolean;
  loadingNotes: boolean;
  syncing: boolean;
  savingFields: boolean;
  fieldConfigOpen: boolean;
  message: string;
  error: string;
  summary: SyncSummary | null;
  cacheFetchedAt: string | null;
}

const state: HighlightsState = {
  settings: null,
  books: [],
  selectedBookId: "",
  notes: [],
  loadingBooks: false,
  loadingNotes: false,
  syncing: false,
  savingFields: false,
  fieldConfigOpen: false,
  message: "",
  error: "",
  summary: null,
  cacheFetchedAt: null
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

  const bookListScrollTop = app.querySelector<HTMLElement>(".book-list")?.scrollTop ?? 0;
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

      ${renderFieldConfig()}

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
  const bookList = app.querySelector<HTMLElement>(".book-list");
  if (bookList) {
    bookList.scrollTop = bookListScrollTop;
  }
}

async function init(): Promise<void> {
  const [settings, cachedBookList] = await Promise.all([getSettings(), getCachedHighlightBookList()]);
  state.settings = settings;
  if (cachedBookList) {
    state.books = cachedBookList.books;
    state.selectedBookId = cachedBookList.books.some((book) => book.bookId === cachedBookList.selectedBookId)
      ? cachedBookList.selectedBookId
      : cachedBookList.books[0]?.bookId ?? "";
    state.cacheFetchedAt = cachedBookList.fetchedAt;
    state.message = `已恢复上次读取的 ${cachedBookList.books.length} 本划线书籍`;
  }
  render();
  if (state.selectedBookId) {
    await selectBook(state.selectedBookId);
  }
}

async function refreshSettings(): Promise<void> {
  state.settings = await getSettings();
  render();
}

function renderStatus(configured: boolean): string {
  const idMapping = getHighlightBookIdMapping();
  const items = [
    configured ? "划线数据库已配置" : "划线数据库未配置",
    idMapping?.propertyName
      ? `去重字段：${escapeHtml(idMapping.propertyName)}`
      : "去重字段：按固定页面标题匹配"
  ];
  if (state.cacheFetchedAt && state.books.length > 0) {
    items.push(`划线书籍缓存：${formatDate(state.cacheFetchedAt)}`);
  }

  return `
    <section class="status ${configured ? "ok" : "warn"}">
      ${items.map((item) => `<span>${escapeHtml(item)}</span>`).join("")}
      ${state.error ? `<strong>${escapeHtml(state.error)}</strong>` : ""}
      ${state.message ? `<strong>${escapeHtml(state.message)}</strong>` : ""}
    </section>
  `;
}

function renderFieldConfig(): string {
  const settings = state.settings;
  if (!settings) {
    return "";
  }

  const titleProperty = getTitleProperty(settings.highlightDatabaseProperties);
  const fieldsLoaded = settings.highlightDatabaseProperties.length > 0;
  const hint = fieldsLoaded
    ? titleProperty
      ? `页面标题会自动写入 title 字段「${escapeHtml(titleProperty.name)}」。下面的条目只负责额外字段。`
      : "当前划线数据库缺少 title 类型字段，请回到配置页重新验证数据库。"
    : "验证划线数据库后，可以在这里添加要同步到 Notion 的字段条目。";

  return `
    <details class="field-config" ${state.fieldConfigOpen ? "open" : ""}>
      <summary class="field-config-summary">
        <div>
          <h2>划线字段</h2>
          <p>${hint}</p>
        </div>
        <span class="field-summary-meta">
          <span class="field-count">${settings.highlightFieldMappings.length} 个条目</span>
          <span class="field-toggle-cue" aria-hidden="true"></span>
        </span>
      </summary>
      <div class="field-config-body">
        <div class="field-config-header">
          <button id="add-field-entry" class="secondary" type="button" ${fieldsLoaded ? "" : "disabled"}>添加字段</button>
        </div>
        <div class="field-entry-header" aria-hidden="true">
          <span>Notion 字段</span>
          <span>同步内容</span>
          <span>自定义内容</span>
          <span>更新方式</span>
          <span>操作</span>
        </div>
        <div class="field-entry-list">
          ${
            settings.highlightFieldMappings.length > 0
              ? settings.highlightFieldMappings
                  .map((entry) => renderFieldEntry(entry, settings.highlightDatabaseProperties))
                  .join("")
              : `<p class="empty-fields">还没有字段条目。可以添加 Book ID 用于去重，也可以添加作者、划线数量、最后同步时间或自定义内容。</p>`
          }
        </div>
        <label class="toggle-row">
          <input id="use-highlight-notion-cover" type="checkbox" ${settings.useHighlightNotionCover ? "checked" : ""} />
          <span>将书的封面设置为 Notion 页面封面</span>
        </label>
        <div class="field-actions">
          <button id="save-field-config" class="primary" type="button" ${state.savingFields ? "disabled" : ""}>
            ${state.savingFields ? "保存中..." : "保存字段配置"}
          </button>
        </div>
      </div>
    </details>
  `;
}

function renderFieldEntry(entry: FieldMappingEntry<HighlightSyncField>, properties: DatabaseProperty[]): string {
  const property = properties.find((item) => item.name === entry.propertyName);
  const error = getHighlightFieldMappingError(entry, properties);
  const customMode = entry.sourceType === "custom";
  const allowedTypes =
    !customMode && entry.sourceField
      ? `兼容：${getHighlightAllowedTypes(entry.sourceField).join(" / ")}`
      : "自定义内容会按 Notion 字段类型写入";

  return `
    <div class="field-entry" data-field-entry="${escapeAttribute(entry.id)}">
      <select data-entry-property="${escapeAttribute(entry.id)}">
        <option value="">选择 Notion 字段</option>
        ${properties
          .filter((item) => isWritablePropertyType(item.type))
          .map(
            (item) =>
              `<option value="${escapeAttribute(item.name)}" ${
                item.name === entry.propertyName ? "selected" : ""
              }>${escapeHtml(item.name)} · ${item.type}</option>`
          )
          .join("")}
      </select>
      <select data-entry-source="${escapeAttribute(entry.id)}">
        <option value="">选择同步内容</option>
        ${HIGHLIGHT_SYNC_FIELDS.map(
          (field) =>
            `<option value="${field}" ${!customMode && entry.sourceField === field ? "selected" : ""}>${
              HIGHLIGHT_FIELD_LABELS[field]
            }</option>`
        ).join("")}
        <option value="__custom" ${customMode ? "selected" : ""}>自定义内容</option>
      </select>
      ${renderCustomValueControl(entry, property)}
      <label class="overwrite-toggle">
        <input
          type="checkbox"
          data-entry-overwrite="${escapeAttribute(entry.id)}"
          ${entry.overwriteOnUpdate ? "checked" : ""}
          ${entry.sourceField === "bookId" ? "disabled" : ""}
        />
        <span>${entry.sourceField === "bookId" ? "用于去重" : "覆盖更新"}</span>
      </label>
      <button class="secondary danger" type="button" data-entry-remove="${escapeAttribute(entry.id)}">删除</button>
      <small class="${error ? "field-error" : ""}">${escapeHtml(error ?? allowedTypes)}</small>
    </div>
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
  document.querySelector<HTMLDetailsElement>(".field-config")?.addEventListener("toggle", (event) => {
    state.fieldConfigOpen = (event.currentTarget as HTMLDetailsElement).open;
  });
  document.querySelector("#fetch-notebooks")?.addEventListener("click", fetchNotebooks);
  document.querySelector("#sync-highlights")?.addEventListener("click", syncCurrentBook);
  document.querySelector("#add-field-entry")?.addEventListener("click", addFieldEntry);
  document.querySelector("#save-field-config")?.addEventListener("click", saveFieldConfig);
  document.querySelector<HTMLInputElement>("#use-highlight-notion-cover")?.addEventListener("change", (event) => {
    if (!state.settings) {
      return;
    }
    state.settings.useHighlightNotionCover = (event.currentTarget as HTMLInputElement).checked;
  });

  document.querySelectorAll<HTMLSelectElement>("select[data-entry-property]").forEach((select) => {
    select.addEventListener("change", () => {
      const entry = getFieldEntry(select.dataset.entryProperty);
      updateFieldEntry(select.dataset.entryProperty, {
        propertyName: select.value,
        customValue: entry?.sourceType === "custom" ? "" : entry?.customValue ?? ""
      });
    });
  });

  document.querySelectorAll<HTMLSelectElement>("select[data-entry-source]").forEach((select) => {
    select.addEventListener("change", () => {
      const sourceType = select.value === "__custom" ? "custom" : "field";
      updateFieldEntry(select.dataset.entrySource, {
        sourceType,
        sourceField: sourceType === "field" ? (select.value as HighlightSyncField) : "",
        customValue: sourceType === "field" ? "" : getFieldEntry(select.dataset.entrySource)?.customValue ?? "",
        overwriteOnUpdate: select.value === "bookId" ? false : getFieldEntry(select.dataset.entrySource)?.overwriteOnUpdate ?? false
      });
    });
  });

  bindCustomValueControls<HighlightSyncField>({
    getEntry: getFieldEntry,
    updateEntry: updateFieldEntry,
    render
  });

  document.querySelectorAll<HTMLInputElement>("input[data-entry-overwrite]").forEach((input) => {
    input.addEventListener("change", () =>
      updateFieldEntry(input.dataset.entryOverwrite, { overwriteOnUpdate: input.checked })
    );
  });

  document.querySelectorAll<HTMLButtonElement>("button[data-entry-remove]").forEach((button) => {
    button.addEventListener("click", () => removeFieldEntry(button.dataset.entryRemove));
  });

  document.querySelectorAll<HTMLButtonElement>("[data-book-id]").forEach((button) => {
    button.addEventListener("click", () => {
      const bookId = button.dataset.bookId;
      if (bookId) {
        void selectBook(bookId);
      }
    });
  });
}

function addFieldEntry(): void {
  if (!state.settings) {
    return;
  }
  state.settings.highlightFieldMappings = [
    ...state.settings.highlightFieldMappings,
    {
      id: createEntryId(),
      propertyName: "",
      sourceType: "field",
      sourceField: "",
      customValue: "",
      overwriteOnUpdate: false
    }
  ];
  state.fieldConfigOpen = true;
  render();
}

function updateFieldEntry(
  id: string | undefined,
  patch: Partial<FieldMappingEntry<HighlightSyncField>>,
  shouldRender = true
): void {
  if (!id || !state.settings) {
    return;
  }
  state.settings.highlightFieldMappings = state.settings.highlightFieldMappings.map((entry) =>
    entry.id === id ? { ...entry, ...patch } : entry
  );
  if (shouldRender) {
    render();
  }
}

function removeFieldEntry(id: string | undefined): void {
  if (!id || !state.settings) {
    return;
  }
  state.settings.highlightFieldMappings = state.settings.highlightFieldMappings.filter((entry) => entry.id !== id);
  render();
}

async function saveFieldConfig(): Promise<void> {
  if (!state.settings) {
    return;
  }

  const invalidEntry = state.settings.highlightFieldMappings.find((entry) =>
    Boolean(getHighlightFieldMappingError(entry, state.settings?.highlightDatabaseProperties ?? []))
  );
  if (invalidEntry) {
    state.error = getHighlightFieldMappingError(invalidEntry, state.settings.highlightDatabaseProperties) ?? "字段配置有误";
    state.fieldConfigOpen = true;
    render();
    return;
  }

  state.savingFields = true;
  state.error = "";
  state.message = "";
  render();

  try {
    await saveSettings(state.settings);
    state.message = "划线字段配置已保存";
  } catch (error) {
    state.error = getErrorMessage(error);
  } finally {
    state.savingFields = false;
    render();
  }
}

async function fetchNotebooks(): Promise<void> {
  state.loadingBooks = true;
  state.error = "";
  state.message = "";
  state.summary = null;
  render();

  try {
    state.books = await sendBackgroundMessage<WeReadNotebookBook[]>({ type: "FETCH_WEREAD_NOTEBOOKS" });
    state.selectedBookId = state.books[0]?.bookId ?? "";
    state.cacheFetchedAt = new Date().toISOString();
    state.message = state.books.length > 0 ? `已读取 ${state.books.length} 本有划线或想法的书` : "没有读取到划线书籍";
    await persistCurrentHighlightBookList();
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
  void persistCurrentHighlightBookList();
  state.notes = [];
  state.loadingNotes = true;
  state.error = "";
  state.message = "";
  state.summary = null;
  render();

  try {
    state.notes = await sendBackgroundMessage<WeReadHighlightNote[]>({ type: "FETCH_WEREAD_HIGHLIGHTS", book });
    updateBookCounts(bookId, state.notes);
    void persistCurrentHighlightBookList();
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

function updateBookCounts(bookId: string, notes: WeReadHighlightNote[]): void {
  const bookmarkCount = notes.filter((note) => note.original).length;
  const reviewCount = notes.filter((note) => note.thought).length;
  state.books = state.books.map((book) =>
    book.bookId === bookId
      ? {
          ...book,
          noteCount: bookmarkCount,
          bookmarkCount,
          reviewCount
        }
      : book
  );
}

function isConfigured(settings: ExtensionSettings | null): boolean {
  return Boolean(settings?.notionToken && settings.highlightDatabaseId && getTitlePropertyName(settings));
}

function getTitlePropertyName(settings: ExtensionSettings): string {
  return settings.highlightDatabaseProperties.find((property) => property.type === "title")?.name ?? "";
}

function getHighlightBookIdMapping(settings = state.settings): FieldMappingEntry<HighlightSyncField> | null {
  return (
    settings?.highlightFieldMappings.find((entry) => entry.sourceType === "field" && entry.sourceField === "bookId") ??
    null
  );
}

function getFieldEntry(id: string | undefined): FieldMappingEntry<HighlightSyncField> | null {
  return state.settings?.highlightFieldMappings.find((entry) => entry.id === id) ?? null;
}

function createEntryId(): string {
  return `highlight-field-${Date.now()}-${Math.random().toString(16).slice(2)}`;
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

function escapeAttribute(value: string): string {
  return escapeHtml(value);
}

async function persistCurrentHighlightBookList(): Promise<void> {
  const fetchedAt = state.cacheFetchedAt ?? new Date().toISOString();
  state.cacheFetchedAt = fetchedAt;
  await saveCachedHighlightBookList({
    books: state.books,
    selectedBookId: state.selectedBookId,
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

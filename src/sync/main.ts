import "./styles.css";
import { FIELD_LABELS, SYNC_FIELDS, getBookAllowedTypes, isWritablePropertyType } from "../shared/fields";
import { bindCustomValueControls, renderCustomValueControl } from "../shared/customFields";
import { openOptionsPage, sendBackgroundMessage } from "../shared/runtime";
import type { DatabaseProperty, ExtensionSettings, FieldMappingEntry, SyncField, SyncProgress, SyncSummary, WeReadBook } from "../shared/types";
import { getCachedBookList, getSettings, saveCachedBookList, saveSettings } from "../storage";
import { getBookFieldMappingError, getTitleProperty } from "../services/notion";

interface SyncState {
  settings: ExtensionSettings | null;
  books: WeReadBook[];
  selectedIds: Set<string>;
  loading: boolean;
  syncing: boolean;
  savingFields: boolean;
  fieldConfigOpen: boolean;
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
  savingFields: false,
  fieldConfigOpen: false,
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
          <h1>书架同步</h1>
          <p>${configured ? "读取书架并同步选中的书籍" : "请先到配置页完成 Notion 连接，并在本页配置 WeRead ID 字段"}</p>
        </div>
        <button class="icon-button" id="open-options" title="切换到配置页">配置页</button>
      </header>

      ${renderStatus(configured)}

      ${renderFieldConfig()}

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
  const mapping = getBookIdMapping();
  const idReady = Boolean(mapping?.propertyName && state.settings && !getBookFieldMappingError(mapping, state.settings.databaseProperties));
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

function renderFieldConfig(): string {
  const settings = state.settings;
  if (!settings) {
    return "";
  }

  const titleProperty = getTitleProperty(settings.databaseProperties);
  const fieldsLoaded = settings.databaseProperties.length > 0;
  const hint = fieldsLoaded
    ? titleProperty
      ? `书名会自动写入 title 字段「${escapeHtml(titleProperty.name)}」。下面的条目只负责额外字段。`
      : "当前数据库缺少 title 类型字段，请回到配置页重新验证数据库。"
    : "验证书架数据库后，可以在这里添加要同步到 Notion 的字段条目。";

  return `
    <details class="field-config" ${state.fieldConfigOpen ? "open" : ""}>
      <summary class="field-config-summary">
        <div>
          <h2>书架字段</h2>
          <p>${hint}</p>
        </div>
        <span class="field-summary-meta">
          <span class="field-count">${settings.fieldMappings.length} 个条目</span>
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
            settings.fieldMappings.length > 0
              ? settings.fieldMappings.map((entry) => renderFieldEntry(entry, settings.databaseProperties)).join("")
              : `<p class="empty-fields">还没有字段条目。添加一个 WeRead ID 条目用于去重，再按需添加作者、状态、备注等字段。</p>`
          }
        </div>
        <label class="toggle-row">
          <input id="use-notion-cover" type="checkbox" ${settings.useNotionCover ? "checked" : ""} />
          <span>将微信读书封面设置为 Notion 页面封面</span>
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

function renderFieldEntry(entry: FieldMappingEntry<SyncField>, properties: DatabaseProperty[]): string {
  const property = properties.find((item) => item.name === entry.propertyName);
  const error = getBookFieldMappingError(entry, properties);
  const customMode = entry.sourceType === "custom";
  const allowedTypes =
    !customMode && entry.sourceField ? `兼容：${getBookAllowedTypes(entry.sourceField).join(" / ")}` : "自定义内容会按 Notion 字段类型写入";

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
        ${SYNC_FIELDS.map(
          (field) =>
            `<option value="${field}" ${!customMode && entry.sourceField === field ? "selected" : ""}>${
              FIELD_LABELS[field]
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
          ${entry.sourceField === "wereadId" ? "disabled" : ""}
        />
        <span>${entry.sourceField === "wereadId" ? "用于去重" : "覆盖更新"}</span>
      </label>
      <button class="ghost danger" type="button" data-entry-remove="${escapeAttribute(entry.id)}">删除</button>
      <small class="${error ? "field-error" : ""}">${escapeHtml(error ?? allowedTypes)}</small>
    </div>
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
  document.querySelector<HTMLDetailsElement>(".field-config")?.addEventListener("toggle", (event) => {
    state.fieldConfigOpen = (event.currentTarget as HTMLDetailsElement).open;
  });
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
  document.querySelector("#add-field-entry")?.addEventListener("click", addFieldEntry);
  document.querySelector("#save-field-config")?.addEventListener("click", saveFieldConfig);
  document.querySelector<HTMLInputElement>("#use-notion-cover")?.addEventListener("change", (event) => {
    if (!state.settings) {
      return;
    }
    state.settings.useNotionCover = (event.currentTarget as HTMLInputElement).checked;
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
        sourceField: sourceType === "field" ? (select.value as SyncField) : "",
        customValue: sourceType === "field" ? "" : getFieldEntry(select.dataset.entrySource)?.customValue ?? "",
        overwriteOnUpdate: select.value === "wereadId" ? false : getFieldEntry(select.dataset.entrySource)?.overwriteOnUpdate ?? false
      });
    });
  });

  bindCustomValueControls<SyncField>({
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

function addFieldEntry(): void {
  if (!state.settings) {
    return;
  }
  state.settings.fieldMappings = [
    ...state.settings.fieldMappings,
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
  patch: Partial<FieldMappingEntry<SyncField>>,
  shouldRender = true
): void {
  if (!id || !state.settings) {
    return;
  }
  state.settings.fieldMappings = state.settings.fieldMappings.map((entry) =>
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
  state.settings.fieldMappings = state.settings.fieldMappings.filter((entry) => entry.id !== id);
  render();
}

async function saveFieldConfig(): Promise<void> {
  if (!state.settings) {
    return;
  }

  const invalidEntry = state.settings.fieldMappings.find((entry) =>
    Boolean(getBookFieldMappingError(entry, state.settings?.databaseProperties ?? []))
  );
  if (invalidEntry) {
    state.error = getBookFieldMappingError(invalidEntry, state.settings.databaseProperties) ?? "字段配置有误";
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
    state.message = "书架字段配置已保存";
  } catch (error) {
    state.error = getErrorMessage(error);
  } finally {
    state.savingFields = false;
    render();
  }
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
  const idMapping = getBookIdMapping(settings);
  return Boolean(
    settings?.notionToken &&
      settings.databaseId &&
      idMapping?.propertyName &&
      !getBookFieldMappingError(idMapping, settings.databaseProperties)
  );
}

function getBookIdMapping(settings = state.settings): FieldMappingEntry<SyncField> | null {
  return settings?.fieldMappings.find((entry) => entry.sourceType === "field" && entry.sourceField === "wereadId") ?? null;
}

function getFieldEntry(id: string | undefined): FieldMappingEntry<SyncField> | null {
  return state.settings?.fieldMappings.find((entry) => entry.id === id) ?? null;
}

function createEntryId(): string {
  return `field-${Date.now()}-${Math.random().toString(16).slice(2)}`;
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

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
  notice: SyncNotice | null;
  noticeTimer: number | null;
  summary: SyncSummary | null;
  syncProgress: SyncProgress | null;
  cacheFetchedAt: string | null;
}

type SyncNoticeType = "success" | "error" | "info";

interface SyncNotice {
  type: SyncNoticeType;
  message: string;
}

const state: SyncState = {
  settings: null,
  books: [],
  selectedIds: new Set(),
  loading: false,
  syncing: false,
  savingFields: false,
  fieldConfigOpen: false,
  notice: null,
  noticeTimer: null,
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
  let restoredMessage = "";
  if (cachedBookList) {
    state.books = sortBooksByLastReadAt(cachedBookList.books);
    state.selectedIds = new Set(cachedBookList.selectedIds);
    state.cacheFetchedAt = cachedBookList.fetchedAt;
    restoredMessage = `已恢复上次读取的 ${cachedBookList.books.length} 本书`;
  }
  render();
  if (restoredMessage) {
    showNotice(restoredMessage, "info");
  }
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
      ${renderNotice()}

      <header class="topbar">
        <div>
          <h1>书籍与划线同步</h1>
          <p>${configured ? "同步书籍字段，并把划线与想法写入对应书籍页面" : "请先到配置页完成 Notion 连接，并在本页配置 WeRead ID 字段"}</p>
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
          ${state.syncing ? "同步中..." : "同步书籍与划线"}
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
  const cacheReady = state.books.length > 0;
  const statusItems = [
    {
      label: "微信读书",
      detail: state.settings?.wereadApiKey ? "API Key 已配置，可读取书架" : "需要配置 WEREAD_API_KEY",
      ready: Boolean(state.settings?.wereadApiKey),
      icon: "↗"
    },
    {
      label: "Notion 数据库",
      detail: state.settings?.notionToken && state.settings.dataSourceId ? "数据库已验证，可以写入" : "需要完成数据库连接与验证",
      ready: Boolean(state.settings?.notionToken && state.settings.dataSourceId),
      icon: "N"
    },
    {
      label: "去重字段",
      detail: idReady ? `已映射「${escapeHtml(mapping?.propertyName ?? "")}」` : "需要映射 WeRead ID，避免重复创建",
      ready: idReady,
      icon: "#"
    },
    {
      label: "书架数据",
      detail: cacheReady && state.cacheFetchedAt ? `最近读取 ${formatDate(state.cacheFetchedAt)}` : "尚未读取书架",
      ready: cacheReady,
      icon: "▤"
    }
  ];

  return `
    <section class="readiness-card">
      <div class="readiness-heading">
        <div>
          <span class="eyebrow">同步前检查</span>
          <h2>连接与同步准备</h2>
          <p>完成这些准备后，就可以选择书籍并同步到 Notion。</p>
        </div>
        <span class="readiness-overall ${configured ? "ready" : "pending"}">
          <span class="readiness-overall-dot" aria-hidden="true"></span>
          ${configured ? "可以开始同步" : "还有待完成项"}
        </span>
      </div>
      <div class="status-grid">
        ${statusItems.map((item) => renderStatusItem(item.label, item.detail, item.ready, item.icon)).join("")}
      </div>
    </section>
  `;
}

function renderStatusItem(label: string, detail: string, ready: boolean, icon: string): string {
  return `
    <div class="status-item ${ready ? "ready" : "pending"}">
      <span class="status-item-icon" aria-hidden="true">${icon}</span>
      <div class="status-item-copy">
        <div class="status-item-title">
          <strong>${label}</strong>
          <span class="status-chip">${ready ? "已就绪" : "待处理"}</span>
        </div>
        <small>${detail}</small>
      </div>
    </div>
  `;
}

function renderNotice(): string {
  if (!state.notice) {
    return "";
  }

  const role = state.notice.type === "error" ? "alert" : "status";
  const live = state.notice.type === "error" ? "assertive" : "polite";
  const icon = state.notice.type === "error" ? "!" : state.notice.type === "success" ? "✓" : "i";
  return `
    <div class="sync-toast ${state.notice.type}" role="${role}" aria-live="${live}">
      <span class="sync-toast-icon" aria-hidden="true">${icon}</span>
      <span class="sync-toast-message">${escapeHtml(state.notice.message)}</span>
      <button class="sync-toast-close" id="dismiss-notice" type="button" aria-label="关闭提示">×</button>
    </div>
  `;
}

function renderFieldConfig(): string {
  const settings = state.settings;
  if (!settings) {
    return "";
  }

  const titleProperty = getTitleProperty(settings.databaseProperties);
  const fieldsLoaded = settings.databaseProperties.length > 0;
  const selectedPropertyNames = new Set(
    settings.fieldMappings.map((entry) => entry.propertyName).filter(Boolean)
  );
  const hint = fieldsLoaded
    ? titleProperty
      ? `书名会自动写入 title 字段「${escapeHtml(titleProperty.name)}」。下面的条目只负责额外字段。`
      : "当前数据库缺少 title 类型字段，请回到配置页重新验证数据库。"
    : "验证书籍数据库后，可以在这里添加要同步到 Notion 的字段条目。";

  return `
    <details class="field-config" ${state.fieldConfigOpen ? "open" : ""}>
      <summary class="field-config-summary">
        <div>
          <h2>书籍字段</h2>
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
              ? settings.fieldMappings
                  .map((entry) => renderFieldEntry(entry, settings.databaseProperties, selectedPropertyNames))
                  .join("")
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

function renderFieldEntry(
  entry: FieldMappingEntry<SyncField>,
  properties: DatabaseProperty[],
  selectedPropertyNames: Set<string>
): string {
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
          .filter(
            (item) =>
              isWritablePropertyType(item.type) &&
              (item.name === entry.propertyName || !selectedPropertyNames.has(item.name))
          )
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
        <p>在配置页填写 WEREAD_API_KEY 后，点击“读取书架”。</p>
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
              <span class="book-progress">
                <span class="book-progress-label">${book.progress}%</span>
                <span class="book-progress-track" aria-hidden="true"><span style="width: ${Math.min(100, Math.max(0, book.progress))}%"></span></span>
              </span>
              <span class="badge status-${getBookStatusClass(book.status)}"><span class="badge-dot" aria-hidden="true"></span>${book.status}</span>
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

  const {
    completed,
    total,
    currentTitle,
    stage = "writing",
    highlightTotal = 0,
    highlightCompleted = 0,
    currentHighlight,
    summary
  } = state.syncProgress;
  const highlightPercent = highlightTotal > 0
    ? Math.round((Math.min(highlightCompleted, highlightTotal) / highlightTotal) * 100)
    : stage === "writing"
      ? 100
      : 0;
  const progressLabel = stage === "preparing"
    ? "准备中..."
    : stage === "readingHighlights"
      ? "正在读取划线..."
      : highlightTotal > 0
        ? `${Math.min(highlightCompleted, highlightTotal)} / ${highlightTotal} 条划线 · ${highlightPercent}%`
        : "无划线 · 已完成";
  const currentBookTitle = currentTitle?.replace(/^正在写入 Notion：/, "");
  const progressDetail = stage === "preparing"
    ? currentTitle || "正在准备同步..."
    : stage === "readingHighlights"
      ? currentTitle || "正在读取划线..."
      : currentHighlight
        ? `正在写入划线：${currentHighlight}`
        : currentBookTitle
          ? `正在写入书籍信息：${currentBookTitle}`
          : completed >= total
            ? "正在收尾..."
            : "准备写入下一本书...";
  const isIndeterminate = stage === "preparing" || stage === "readingHighlights";

  return `
    <section class="sync-progress">
      <div class="progress-heading">
        <strong>${completed} / ${total}</strong>
        <span>${progressLabel}</span>
      </div>
      <div class="sync-progress-track${isIndeterminate ? " is-indeterminate" : ""}" aria-label="划线同步进度">
        <span style="width: ${highlightPercent}%"></span>
      </div>
      <p class="sync-progress-detail" title="${escapeAttribute(progressDetail)}">${escapeHtml(progressDetail)}</p>
      <small>新建 ${summary.created} · 更新 ${summary.updated} · 失败 ${summary.failed.length}</small>
    </section>
  `;
}

function bindEvents(): void {
  document.querySelector("#dismiss-notice")?.addEventListener("click", () => dismissNotice());
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
    const error = getBookFieldMappingError(invalidEntry, state.settings.databaseProperties) ?? "字段配置有误";
    state.fieldConfigOpen = true;
    showNotice(error, "error");
    return;
  }

  state.savingFields = true;
  dismissNotice(false);
  render();

  try {
    await saveSettings(state.settings);
    showNotice("书籍字段配置已保存", "success");
  } catch (error) {
    showNotice(getErrorMessage(error), "error");
  } finally {
    state.savingFields = false;
    render();
  }
}

async function fetchBooks(): Promise<void> {
  state.loading = true;
  dismissNotice(false);
  state.summary = null;
  render();

  try {
    const books = await sendBackgroundMessage<WeReadBook[]>({ type: "FETCH_WEREAD_BOOKS" });
    state.books = sortBooksByLastReadAt(books);
    state.selectedIds = new Set(state.books.map((book) => book.bookId));
    state.cacheFetchedAt = new Date().toISOString();
    const message = state.books.length > 0 ? `已读取 ${state.books.length} 本书` : "没有读取到书籍";
    await persistCurrentBookList();
    showNotice(message, state.books.length > 0 ? "success" : "info");
  } catch (error) {
    showNotice(getErrorMessage(error), "error");
  } finally {
    state.loading = false;
    render();
  }
}

async function syncSelectedBooks(): Promise<void> {
  const selectedBooks = state.books.filter((book) => state.selectedIds.has(book.bookId));
  state.syncing = true;
  dismissNotice(false);
  state.summary = null;
  state.syncProgress = {
    total: selectedBooks.length,
    completed: 0,
    currentTitle: "正在启动同步...",
    stage: "preparing",
    highlightTotal: 0,
    highlightCompleted: 0,
    summary: { created: 0, updated: 0, skipped: 0, failed: [] }
  };
  render();

  try {
    state.summary = await sendBackgroundMessage<SyncSummary>({ type: "SYNC_BOOKS", books: selectedBooks });
    showNotice("书籍与划线同步完成", "success");
  } catch (error) {
    showNotice(getErrorMessage(error), "error");
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
      settings.dataSourceId &&
      settings.wereadApiKey &&
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

function sortBooksByLastReadAt(books: WeReadBook[]): WeReadBook[] {
  return [...books].sort((first, second) => getBookLastReadTime(second) - getBookLastReadTime(first));
}

function getBookLastReadTime(book: WeReadBook): number {
  const time = book.lastReadAt ? new Date(book.lastReadAt).getTime() : 0;
  return Number.isFinite(time) ? time : 0;
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

function showNotice(message: string, type: SyncNoticeType): void {
  window.clearTimeout(state.noticeTimer ?? undefined);
  state.notice = { message, type };
  render();
  state.noticeTimer = window.setTimeout(() => {
    state.notice = null;
    state.noticeTimer = null;
    render();
  }, type === "error" ? 6500 : 4200);
}

function dismissNotice(shouldRender = true): void {
  window.clearTimeout(state.noticeTimer ?? undefined);
  state.noticeTimer = null;
  state.notice = null;
  if (shouldRender) {
    render();
  }
}

function getBookStatusClass(status: WeReadBook["status"]): string {
  if (status === "已读完") {
    return "finished";
  }
  if (status === "阅读中") {
    return "reading";
  }
  return "unstarted";
}

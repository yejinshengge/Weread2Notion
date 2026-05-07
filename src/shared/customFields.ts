import { sendBackgroundMessage } from "./runtime";
import type { DatabaseProperty, FieldMappingEntry, NotionPageSearchResult } from "./types";

interface RelationSelection {
  id: string;
  title: string;
}

interface BindCustomValueControlsOptions<TSource extends string> {
  getEntry: (id: string | undefined) => FieldMappingEntry<TSource> | null;
  updateEntry: (id: string | undefined, patch: Partial<FieldMappingEntry<TSource>>, shouldRender?: boolean) => void;
  render: () => void;
}

export function renderCustomValueControl<TSource extends string>(
  entry: FieldMappingEntry<TSource>,
  property: DatabaseProperty | undefined
): string {
  const disabled = entry.sourceType === "custom" ? "" : "disabled";
  const value = entry.customValue;

  switch (property?.type) {
    case "select":
    case "status":
      return `
        <select data-entry-custom="${escapeAttribute(entry.id)}" ${disabled}>
          <option value="">选择选项</option>
          ${(property.options ?? [])
            .map(
              (option) =>
                `<option value="${escapeAttribute(option.name)}" ${
                  option.name === value ? "selected" : ""
                }>${escapeHtml(option.name)}</option>`
            )
            .join("")}
        </select>
      `;
    case "multi_select": {
      const selected = new Set(splitMultiSelectValue(value));
      return `
        <select class="custom-multi-select" data-entry-custom-multi="${escapeAttribute(entry.id)}" multiple size="3" ${disabled}>
          ${(property.options ?? [])
            .map(
              (option) =>
                `<option value="${escapeAttribute(option.name)}" ${
                  selected.has(option.name) ? "selected" : ""
                }>${escapeHtml(option.name)}</option>`
            )
            .join("")}
        </select>
      `;
    }
    case "checkbox":
      return `
        <select data-entry-custom="${escapeAttribute(entry.id)}" ${disabled}>
          <option value="">选择</option>
          <option value="true" ${value === "true" ? "selected" : ""}>是</option>
          <option value="false" ${value === "false" ? "selected" : ""}>否</option>
        </select>
      `;
    case "date":
      return `<input data-entry-custom="${escapeAttribute(entry.id)}" type="date" value="${escapeAttribute(
        value.slice(0, 10)
      )}" ${disabled} />`;
    case "number":
      return `<input data-entry-custom="${escapeAttribute(entry.id)}" type="number" value="${escapeAttribute(
        value
      )}" placeholder="填写数字" ${disabled} />`;
    case "relation":
      return renderRelationControl(entry, property);
    case "url":
    case "files":
      return `<input data-entry-custom="${escapeAttribute(entry.id)}" type="url" value="${escapeAttribute(
        value
      )}" placeholder="https://..." ${disabled} />`;
    default:
      return `<input data-entry-custom="${escapeAttribute(entry.id)}" type="text" value="${escapeAttribute(
        value
      )}" placeholder="${escapeAttribute(getCustomPlaceholder(property))}" ${disabled} />`;
  }
}

export function bindCustomValueControls<TSource extends string>(options: BindCustomValueControlsOptions<TSource>): void {
  document.querySelectorAll<HTMLInputElement | HTMLSelectElement>("input[data-entry-custom], select[data-entry-custom]").forEach((input) => {
    if (input instanceof HTMLInputElement && input.type === "hidden") {
      return;
    }
    input.addEventListener("input", () => options.updateEntry(input.dataset.entryCustom, { customValue: input.value }, false));
    input.addEventListener("change", () => {
      options.updateEntry(input.dataset.entryCustom, { customValue: input.value }, false);
      options.render();
    });
  });

  document.querySelectorAll<HTMLSelectElement>("select[data-entry-custom-multi]").forEach((select) => {
    select.addEventListener("change", () => {
      const value = Array.from(select.selectedOptions)
        .map((option) => option.value)
        .join(", ");
      options.updateEntry(select.dataset.entryCustomMulti, { customValue: value });
    });
  });

  document.querySelectorAll<HTMLButtonElement>("button[data-entry-relation-open]").forEach((button) => {
    button.addEventListener("click", () => {
      const entry = options.getEntry(button.dataset.entryRelationOpen);
      const databaseId = button.dataset.relationDatabaseId;
      if (!entry || !databaseId) {
        return;
      }
      void openRelationPicker({
        databaseId,
        initialValue: entry.customValue,
        onConfirm: (value) => {
          options.updateEntry(entry.id, { customValue: value });
        }
      });
    });
  });
}

function renderRelationControl<TSource extends string>(
  entry: FieldMappingEntry<TSource>,
  property: DatabaseProperty
): string {
  const disabled = entry.sourceType === "custom" && property.relationDatabaseId ? "" : "disabled";
  const selected = parseRelationSelection(entry.customValue);
  const label =
    selected.length > 0
      ? selected.map((item) => item.title || item.id).join(", ")
      : property.relationDatabaseId
        ? "选择关联页面"
        : "缺少关联数据库配置";

  return `
    <div class="relation-custom-control">
      <input data-entry-custom="${escapeAttribute(entry.id)}" type="hidden" value="${escapeAttribute(entry.customValue)}" />
      <button
        class="relation-picker-button"
        type="button"
        data-entry-relation-open="${escapeAttribute(entry.id)}"
        data-relation-database-id="${escapeAttribute(property.relationDatabaseId ?? "")}"
        ${disabled}
      >
        ${escapeHtml(label)}
      </button>
    </div>
  `;
}

async function openRelationPicker(options: {
  databaseId: string;
  initialValue: string;
  onConfirm: (value: string) => void;
}): Promise<void> {
  const selected = new Map(parseRelationSelection(options.initialValue).map((item) => [item.id, item]));
  let results: NotionPageSearchResult[] = [];
  let loading = false;
  let error = "";
  let searchQuery = "";

  const overlay = document.createElement("div");
  overlay.className = "relation-modal-backdrop";
  document.body.append(overlay);

  const close = () => overlay.remove();
  const commit = () => {
    options.onConfirm(JSON.stringify(Array.from(selected.values())));
    close();
  };

  const search = async () => {
    const input = overlay.querySelector<HTMLInputElement>("[data-relation-search]");
    searchQuery = input?.value ?? searchQuery;
    loading = true;
    error = "";
    render();
    try {
      results = await sendBackgroundMessage<NotionPageSearchResult[]>({
        type: "SEARCH_NOTION_PAGES",
        databaseId: options.databaseId,
        query: input?.value ?? ""
      });
    } catch (caught) {
      error = caught instanceof Error ? caught.message : "搜索失败";
    } finally {
      loading = false;
      render();
    }
  };

  const render = () => {
    const selectedItems = Array.from(selected.values());
    overlay.innerHTML = `
      <div class="relation-modal" role="dialog" aria-modal="true">
        <header>
          <strong>选择关联页面</strong>
          <button class="ghost" type="button" data-relation-close>关闭</button>
        </header>
        <div class="relation-search-row">
          <input data-relation-search type="search" value="${escapeAttribute(searchQuery)}" placeholder="搜索页面标题" />
          <button class="secondary" type="button" data-relation-search-button>${loading ? "搜索中..." : "搜索"}</button>
        </div>
        ${
          selectedItems.length > 0
            ? `<div class="relation-selected">${selectedItems
                .map(
                  (item) =>
                    `<button type="button" data-relation-remove="${escapeAttribute(item.id)}">${escapeHtml(
                      item.title || item.id
                    )}</button>`
                )
                .join("")}</div>`
            : ""
        }
        <div class="relation-results">
          ${
            error
              ? `<p class="relation-error">${escapeHtml(error)}</p>`
              : results.length > 0
                ? results
                    .map(
                      (page) => `
                        <label class="relation-result-row">
                          <input type="checkbox" data-relation-page="${escapeAttribute(page.id)}" ${
                            selected.has(page.id) ? "checked" : ""
                          } />
                          <span>${escapeHtml(page.title)}</span>
                        </label>
                      `
                    )
                    .join("")
                : `<p>${loading ? "正在搜索..." : "输入关键词后搜索，或直接搜索查看最近页面"}</p>`
          }
        </div>
        <footer>
          <button class="ghost" type="button" data-relation-clear>清空</button>
          <button class="primary" type="button" data-relation-confirm>确定</button>
        </footer>
      </div>
    `;

    overlay.querySelector<HTMLButtonElement>("[data-relation-close]")?.addEventListener("click", close);
    overlay.querySelector<HTMLButtonElement>("[data-relation-search-button]")?.addEventListener("click", () => void search());
    overlay.querySelector<HTMLInputElement>("[data-relation-search]")?.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        void search();
      }
    });
    overlay.querySelector<HTMLButtonElement>("[data-relation-clear]")?.addEventListener("click", () => {
      selected.clear();
      render();
    });
    overlay.querySelector<HTMLButtonElement>("[data-relation-confirm]")?.addEventListener("click", commit);
    overlay.querySelectorAll<HTMLInputElement>("input[data-relation-page]").forEach((checkbox) => {
      checkbox.addEventListener("change", () => {
        const page = results.find((item) => item.id === checkbox.dataset.relationPage);
        if (!page) {
          return;
        }
        if (checkbox.checked) {
          selected.set(page.id, { id: page.id, title: page.title });
        } else {
          selected.delete(page.id);
        }
        render();
      });
    });
    overlay.querySelectorAll<HTMLButtonElement>("button[data-relation-remove]").forEach((button) => {
      button.addEventListener("click", () => {
        const id = button.dataset.relationRemove;
        if (id) {
          selected.delete(id);
          render();
        }
      });
    });
  };

  render();
  await search();
}

function parseRelationSelection(value: string): RelationSelection[] {
  if (!value.trim()) {
    return [];
  }
  try {
    const parsed = JSON.parse(value) as unknown;
    if (Array.isArray(parsed)) {
      return parsed
        .map((item) => {
          if (typeof item === "string") {
            return { id: item, title: item };
          }
          if (item && typeof item === "object" && typeof (item as { id?: unknown }).id === "string") {
            const id = (item as { id: string }).id;
            const title = typeof (item as { title?: unknown }).title === "string" ? (item as { title: string }).title : id;
            return { id, title };
          }
          return null;
        })
        .filter((item): item is RelationSelection => Boolean(item));
    }
  } catch {
    // Plain page id strings from early builds are still accepted.
  }
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean)
    .map((id) => ({ id, title: id }));
}

function splitMultiSelectValue(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function getCustomPlaceholder(property: DatabaseProperty | undefined): string {
  switch (property?.type) {
    case "number":
      return "填写数字";
    case "checkbox":
      return "true/false 或 是/否";
    case "date":
      return "YYYY-MM-DD";
    case "multi_select":
      return "选择一个或多个选项";
    case "url":
    case "files":
      return "https://...";
    default:
      return "填写自定义内容";
  }
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

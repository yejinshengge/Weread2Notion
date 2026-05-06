import "./styles.css";
import { FIELD_LABELS, SYNC_FIELDS, getAllowedTypes } from "../shared/fields";
import { sendBackgroundMessage } from "../shared/runtime";
import type { DatabaseProperty, ExtensionSettings, SyncField } from "../shared/types";
import { getSettings, saveSettings } from "../storage";
import { getMappingError, getTitleProperty } from "../services/notion";

interface OptionsState {
  settings: ExtensionSettings | null;
  saving: boolean;
  validating: boolean;
  message: string;
  error: string;
  toast: {
    type: "ok" | "error";
    message: string;
  } | null;
}

const state: OptionsState = {
  settings: null,
  saving: false,
  validating: false,
  message: "",
  error: "",
  toast: null
};

const app = document.querySelector<HTMLDivElement>("#app");
const NOTION_INTEGRATIONS_URL = "https://www.notion.so/my-integrations";
let toastTimer: number | undefined;

void init();

async function init(): Promise<void> {
  state.settings = await getSettings();
  render();
}

function render(): void {
  if (!app || !state.settings) {
    return;
  }

  const settings = state.settings;
  const titleProperty = getTitleProperty(settings.databaseProperties);
  const propertiesLoaded = settings.databaseProperties.length > 0;

  app.innerHTML = `
    <main class="settings-shell">
      <header class="hero">
        <div>
          <p>WeRead to Notion</p>
          <h1>同步设置</h1>
        </div>
        <span>${settings.lastValidatedAt ? `上次验证：${formatDate(settings.lastValidatedAt)}` : "尚未验证数据库"}</span>
      </header>

      ${renderMessage()}

      <section class="panel">
        <h2>Notion 连接</h2>
        <div class="field">
          <div class="field-heading">
            <label for="notion-token">内部集成密钥</label>
            <a class="secondary-link" href="${NOTION_INTEGRATIONS_URL}" target="_blank" rel="noopener noreferrer">
              获取 Notion 密钥
            </a>
          </div>
          <input id="notion-token" type="password" value="${escapeAttribute(settings.notionToken)}" placeholder="secret_..." autocomplete="off" />
        </div>
        <label>
          <span>数据库 URL 或 ID</span>
          <input id="database-url" type="text" value="${escapeAttribute(settings.databaseUrl || settings.databaseId)}" placeholder="https://www.notion.so/..." />
        </label>
        <div class="actions">
          <button id="validate-database" class="primary" ${state.validating ? "disabled" : ""}>
            ${state.validating ? "验证中..." : "验证数据库"}
          </button>
          <p>${propertiesLoaded ? `已读取 ${settings.databaseProperties.length} 个字段` : "验证后可配置字段映射"}</p>
        </div>
        ${
          propertiesLoaded && !titleProperty
            ? `<p class="field-error">数据库必须包含 title 类型字段。</p>`
            : ""
        }
      </section>

      <section class="panel">
        <h2>同步字段</h2>
        <p class="hint">${
          titleProperty
            ? `书名将写入 title 字段「${escapeHtml(titleProperty.name)}」。其余字段可按需启用并映射到兼容的 Notion 字段。`
            : "书名将写入数据库的 title 字段。其余字段可按需启用并映射到兼容的 Notion 字段。"
        }</p>
        <div class="mapping-list">
          ${SYNC_FIELDS.map((field) => renderMappingRow(field, settings)).join("")}
        </div>
        <label class="toggle-row">
          <input id="use-notion-cover" type="checkbox" ${settings.useNotionCover ? "checked" : ""} />
          <span>将微信读书封面设置为 Notion 页面封面</span>
        </label>
      </section>

      <footer class="footer">
        <button id="save-settings" class="primary" ${state.saving ? "disabled" : ""}>
          ${state.saving ? "保存中..." : "保存设置"}
        </button>
      </footer>

      ${renderToast()}
    </main>
  `;

  bindEvents();
}

function renderMessage(): string {
  if (state.error) {
    return `<section class="notice error">${escapeHtml(state.error)}</section>`;
  }
  if (state.message) {
    return `<section class="notice ok">${escapeHtml(state.message)}</section>`;
  }
  return "";
}

function renderToast(): string {
  if (!state.toast) {
    return "";
  }

  return `
    <div class="toast ${state.toast.type}" role="status" aria-live="polite">
      ${escapeHtml(state.toast.message)}
    </div>
  `;
}

function renderMappingRow(field: SyncField, settings: ExtensionSettings): string {
  const mapping = settings.mappings[field];
  const canConfigureOverwrite = field !== "wereadId";
  const options = getCompatibleProperties(field, settings.databaseProperties)
    .map(
      (property) =>
        `<option value="${escapeAttribute(property.name)}" ${
          property.name === mapping.propertyName ? "selected" : ""
        }>${escapeHtml(property.name)} · ${property.type}</option>`
    )
    .join("");
  const error = getMappingError(field, mapping, settings.databaseProperties);
  const allowedTypes = getAllowedTypes(field).join(" / ");

  return `
    <div class="mapping-row">
      <label class="switch">
        <input type="checkbox" data-map-enabled="${field}" ${mapping.enabled ? "checked" : ""} />
        <span>${FIELD_LABELS[field]}</span>
      </label>
      <select data-map-property="${field}" ${mapping.enabled ? "" : "disabled"}>
        <option value="">选择字段</option>
        ${options}
      </select>
      <label class="overwrite-toggle ${canConfigureOverwrite ? "" : "muted"}">
        <input
          type="checkbox"
          data-map-overwrite="${field}"
          ${mapping.overwriteOnUpdate ? "checked" : ""}
          ${canConfigureOverwrite ? "" : "disabled"}
        />
        <span>${canConfigureOverwrite ? "覆盖更新" : "用于去重"}</span>
      </label>
      <small>${error ? escapeHtml(error) : `兼容：${escapeHtml(allowedTypes)}`}</small>
    </div>
  `;
}

function bindEvents(): void {
  document.querySelector("#validate-database")?.addEventListener("click", validateDatabaseFromForm);
  document.querySelector("#save-settings")?.addEventListener("click", saveSettingsFromForm);

  document.querySelectorAll<HTMLInputElement>("input[data-map-enabled]").forEach((input) => {
    input.addEventListener("change", () => {
      const field = input.dataset.mapEnabled as SyncField | undefined;
      if (!field || !state.settings) {
        return;
      }
      state.settings.mappings[field].enabled = input.checked;
      render();
    });
  });

  document.querySelectorAll<HTMLSelectElement>("select[data-map-property]").forEach((select) => {
    select.addEventListener("change", () => {
      const field = select.dataset.mapProperty as SyncField | undefined;
      if (!field || !state.settings) {
        return;
      }
      state.settings.mappings[field].propertyName = select.value;
      render();
    });
  });

  document.querySelectorAll<HTMLInputElement>("input[data-map-overwrite]").forEach((input) => {
    input.addEventListener("change", () => {
      const field = input.dataset.mapOverwrite as SyncField | undefined;
      if (!field || !state.settings || field === "wereadId") {
        return;
      }
      state.settings.mappings[field].overwriteOnUpdate = input.checked;
      render();
    });
  });

  document.querySelector<HTMLInputElement>("#use-notion-cover")?.addEventListener("change", (event) => {
    if (!state.settings) {
      return;
    }
    state.settings.useNotionCover = (event.currentTarget as HTMLInputElement).checked;
  });
}

async function validateDatabaseFromForm(): Promise<void> {
  const token = readInputValue("#notion-token");
  const databaseIdOrUrl = readInputValue("#database-url");

  if (state.settings) {
    state.settings = {
      ...state.settings,
      notionToken: token,
      databaseUrl: databaseIdOrUrl
    };
  }
  state.validating = true;
  state.message = "";
  state.error = "";
  render();

  try {
    await sendBackgroundMessage({ type: "VALIDATE_NOTION", token, databaseIdOrUrl });
    state.settings = await getSettings();
    state.message = "Notion 数据库验证成功";
  } catch (error) {
    state.error = getErrorMessage(error);
  } finally {
    state.validating = false;
    render();
  }
}

async function saveSettingsFromForm(): Promise<void> {
  if (!state.settings) {
    return;
  }

  const nextSettings: ExtensionSettings = {
    ...state.settings,
    notionToken: readInputValue("#notion-token"),
    databaseUrl: readInputValue("#database-url"),
    useNotionCover: Boolean(document.querySelector<HTMLInputElement>("#use-notion-cover")?.checked),
    mappings: { ...state.settings.mappings }
  };

  for (const field of SYNC_FIELDS) {
    nextSettings.mappings[field] = {
      enabled: Boolean(document.querySelector<HTMLInputElement>(`input[data-map-enabled="${field}"]`)?.checked),
      propertyName: document.querySelector<HTMLSelectElement>(`select[data-map-property="${field}"]`)?.value ?? "",
      overwriteOnUpdate:
        field !== "wereadId" &&
        Boolean(document.querySelector<HTMLInputElement>(`input[data-map-overwrite="${field}"]`)?.checked)
    };
  }

  state.settings = nextSettings;
  state.saving = true;
  state.message = "";
  state.error = "";
  render();

  try {
    await saveSettings(nextSettings);
    state.settings = nextSettings;
    state.message = "设置已保存";
    showToast("设置已保存", "ok");
  } catch (error) {
    state.error = getErrorMessage(error);
    showToast(state.error, "error");
  } finally {
    state.saving = false;
    render();
  }
}

function showToast(message: string, type: "ok" | "error"): void {
  state.toast = { message, type };
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => {
    state.toast = null;
    render();
  }, 2600);
  render();
}

function getCompatibleProperties(field: SyncField, properties: DatabaseProperty[]): DatabaseProperty[] {
  const allowedTypes = getAllowedTypes(field);
  return properties.filter((property) => allowedTypes.includes(property.type));
}

function readInputValue(selector: string): string {
  return document.querySelector<HTMLInputElement>(selector)?.value.trim() ?? "";
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    dateStyle: "short",
    timeStyle: "short"
  }).format(new Date(value));
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

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "未知错误";
}

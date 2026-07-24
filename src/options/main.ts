import "./styles.css";
import { sendBackgroundMessage } from "../shared/runtime";
import type { ExtensionSettings } from "../shared/types";
import { getSettings, saveSettings } from "../storage";
import { getTitleProperty } from "../services/notion";

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
document.body.classList.toggle("embedded", window.parent !== window);

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
          <h1>配置页</h1>
        </div>
        <div class="hero-actions">
          <span>${settings.lastValidatedAt ? `上次验证：${formatDate(settings.lastValidatedAt)}` : "尚未验证数据库"}</span>
          <button class="secondary-link" id="open-sync-page" type="button">打开书籍同步</button>
        </div>
      </header>

      ${renderMessage()}

      <section class="panel">
        <h2>微信读书连接</h2>
        <p class="hint">使用 WEREAD_API_KEY，通过微信读书 Agent API Gateway 读取书架和笔记。</p>
        <label>
          <span>WEREAD_API_KEY</span>
          <input id="weread-api-key" type="password" value="${escapeAttribute(settings.wereadApiKey)}" placeholder="wrk-..." autocomplete="off" />
        </label>
      </section>

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
          <p>${propertiesLoaded ? `已读取 ${settings.databaseProperties.length} 个字段` : "验证后到书籍同步页配置字段"}</p>
        </div>
        ${
          propertiesLoaded && !titleProperty
            ? `<p class="field-error">数据库必须包含 title 类型字段。</p>`
            : ""
        }
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

function bindEvents(): void {
  document.querySelector("#open-sync-page")?.addEventListener("click", openSyncPage);
  document.querySelector("#validate-database")?.addEventListener("click", validateDatabaseFromForm);
  document.querySelector("#save-settings")?.addEventListener("click", saveSettingsFromForm);
}

function openSyncPage(): void {
  if (window.parent !== window) {
    window.parent.postMessage({ type: "SWITCH_TAB", tab: "sync" }, window.location.origin);
    return;
  }

  window.location.href = chrome.runtime.getURL("sync.html");
}

async function validateDatabaseFromForm(): Promise<void> {
  const wereadApiKey = readInputValue("#weread-api-key");
  const token = readInputValue("#notion-token");
  const databaseIdOrUrl = readInputValue("#database-url");

  if (state.settings) {
    state.settings = {
      ...state.settings,
      wereadApiKey,
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
    state.settings = {
      ...(await getSettings()),
      wereadApiKey
    };
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
    wereadApiKey: readInputValue("#weread-api-key"),
    notionToken: readInputValue("#notion-token"),
    databaseUrl: readInputValue("#database-url")
  };

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

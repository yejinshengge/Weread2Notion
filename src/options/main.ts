import "./styles.css";
import { sendBackgroundMessage } from "../shared/runtime";
import { dismissTips, showTips } from "../shared/tips";
import type { ExtensionSettings } from "../shared/types";
import { getSettings, saveSettings } from "../storage";
import { getTitleProperty } from "../services/notion";
import { MAX_SETTINGS_BACKUP_SIZE, parseSettingsBackup, serializeSettingsBackup } from "../shared/settingsBackup";

interface OptionsState {
  settings: ExtensionSettings | null;
  saving: boolean;
  validating: boolean;
  transferring: "import" | "export" | null;
}

const state: OptionsState = {
  settings: null,
  saving: false,
  validating: false,
  transferring: null
};

const app = document.querySelector<HTMLDivElement>("#app");
const NOTION_INTEGRATIONS_URL = "https://www.notion.so/my-integrations";
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
        <p class="hint">书籍同步与图表嵌入共用此密钥。只嵌入图表时，保存密钥即可，无需填写或验证数据库。</p>
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

      <section class="panel">
        <h2>配置导入与导出</h2>
        <p class="hint">备份或迁移连接信息、书籍字段映射和封面设置。导出使用已保存的配置，请先保存修改。</p>
        <p class="hint">配置文件包含微信读书 API Key 和 Notion 密钥，请妥善保管。导入会覆盖当前配置，导入后建议重新验证数据库。</p>
        <div class="actions">
          <button id="export-settings" class="secondary-link" type="button">导出配置</button>
          <button id="import-settings" class="secondary-link" type="button">导入配置</button>
          <input id="import-settings-file" type="file" accept=".json,application/json" aria-label="选择配置文件" hidden />
        </div>
      </section>

      <footer class="footer">
        <button id="save-settings" class="primary" ${state.saving ? "disabled" : ""}>
          ${state.saving ? "保存中..." : "保存设置"}
        </button>
      </footer>
    </main>
  `;

  bindEvents();
  updateControls();
}

function bindEvents(): void {
  document.querySelector("#open-sync-page")?.addEventListener("click", openSyncPage);
  document.querySelector("#validate-database")?.addEventListener("click", validateDatabaseFromForm);
  document.querySelector("#save-settings")?.addEventListener("click", saveSettingsFromForm);
  document.querySelector("#export-settings")?.addEventListener("click", exportSettingsToFile);
  document.querySelector("#import-settings")?.addEventListener("click", () => {
    if (!isBusy()) document.querySelector<HTMLInputElement>("#import-settings-file")?.click();
  });
  document.querySelector("#import-settings-file")?.addEventListener("change", importSettingsFromFile);
}

function openSyncPage(): void {
  if (window.parent !== window) {
    window.parent.postMessage({ type: "SWITCH_TAB", tab: "sync" }, window.location.origin);
    return;
  }

  window.location.href = chrome.runtime.getURL("sync.html");
}

async function validateDatabaseFromForm(): Promise<void> {
  if (isBusy()) return;
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
  dismissTips();
  render();

  try {
    await sendBackgroundMessage({ type: "VALIDATE_NOTION", token, databaseIdOrUrl });
    state.settings = {
      ...(await getSettings()),
      wereadApiKey
    };
    showTips("Notion 数据库验证成功", "success");
  } catch (error) {
    showTips(getErrorMessage(error), "error");
  } finally {
    state.validating = false;
    render();
  }
}

async function saveSettingsFromForm(): Promise<void> {
  if (!state.settings || isBusy()) {
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
  dismissTips();
  render();

  try {
    const latestSettings = {
      ...(await getSettings()),
      wereadApiKey: nextSettings.wereadApiKey,
      notionToken: nextSettings.notionToken,
      databaseUrl: nextSettings.databaseUrl
    };
    await saveSettings(latestSettings);
    state.settings = latestSettings;
    showTips("设置已保存", "success");
  } catch (error) {
    showTips(getErrorMessage(error), "error");
  } finally {
    state.saving = false;
    render();
  }
}

async function exportSettingsToFile(): Promise<void> {
  if (isBusy()) return;
  state.transferring = "export";
  dismissTips();
  updateControls();
  try {
    const now = new Date();
    const text = serializeSettingsBackup(await getSettings(), now);
    const url = URL.createObjectURL(new Blob([text], { type: "application/json;charset=utf-8" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = `weread2notion-config-${now.toISOString().replace(/[:.]/g, "-")}.json`;
    document.body.append(link);
    try {
      link.click();
    } finally {
      link.remove();
      window.setTimeout(() => URL.revokeObjectURL(url), 1000);
    }
    showTips("已生成配置文件，包含 API Key 和 Notion 密钥，请妥善保管", "success");
  } catch (error) {
    showTips(getErrorMessage(error), "error");
  } finally {
    state.transferring = null;
    updateControls();
  }
}

async function importSettingsFromFile(event: Event): Promise<void> {
  const input = event.currentTarget as HTMLInputElement;
  const file = input.files?.[0];
  input.value = "";
  if (!file || isBusy()) return;

  state.transferring = "import";
  dismissTips();
  updateControls();
  try {
    if (file.size > MAX_SETTINGS_BACKUP_SIZE) {
      throw new Error("配置文件过大，请选择不超过 5 MB 的配置文件。");
    }
    const settings = parseSettingsBackup(await file.text());
    if (!window.confirm(`导入「${file.name}」将覆盖已保存的连接信息、${settings.fieldMappings.length} 条书籍字段映射和封面设置，并替换当前页面未保存的修改。是否继续？`)) {
      return;
    }
    await saveSettings(settings);
    state.settings = settings;
    render();
    showTips("配置已导入并保存，建议重新验证 Notion 数据库", "success");
  } catch (error) {
    showTips(getErrorMessage(error), "error");
  } finally {
    state.transferring = null;
    updateControls();
  }
}

function isBusy(): boolean {
  return state.saving || state.validating || state.transferring !== null;
}

function updateControls(): void {
  const busy = isBusy();
  document.querySelectorAll<HTMLButtonElement | HTMLInputElement>(
    "#save-settings, #validate-database, #export-settings, #import-settings, #import-settings-file, #weread-api-key, #notion-token, #database-url"
  ).forEach((control) => { control.disabled = busy; });
  const exportButton = document.querySelector("#export-settings");
  const importButton = document.querySelector("#import-settings");
  if (exportButton) exportButton.textContent = state.transferring === "export" ? "导出中..." : "导出配置";
  if (importButton) importButton.textContent = state.transferring === "import" ? "导入中..." : "导入配置";
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

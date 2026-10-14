import "../options/styles.css";
import "./styles.css";
import { BackgroundError, openOptionsPage, sendBackgroundMessage } from "../shared/runtime";
import { dismissTips, showTips } from "../shared/tips";
import type { NotionPageConnection, ProcessOnEmbedInput, ProcessOnEmbedResult } from "../shared/types";
import { getSettings } from "../storage";
import { buildEmbedPayload, normalizeProcessOn, notionPageUrl, parseNotionPage, ToolError } from "../services/processon";

const app = document.querySelector<HTMLDivElement>("#app");
let hasToken = false;
let busy = false;
let connectionRevision = 0;
document.body.classList.toggle("embedded", window.parent !== window);

void init();

async function init(): Promise<void> {
  render();
  try {
    await refreshCredentialState();
  } catch (error) {
    showError(error);
  }
}

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local" || !changes.settings || changes.settings.oldValue?.notionToken === changes.settings.newValue?.notionToken) return;
  connectionRevision += 1;
  resetPageConnection();
  void refreshCredentialState().catch(showError);
});

function render(): void {
  if (!app) return;
  app.innerHTML = `
    <main class="settings-shell processon-shell">
      <header class="hero">
        <div><p>WeRead to Notion</p><h1>图表嵌入</h1></div>
      </header>

      <section class="panel connection-card">
        <div class="connection-heading">
          <div>
            <span class="eyebrow">嵌入前检查</span>
            <h2>连接与嵌入准备</h2>
            <p class="hint">将 ProcessOn 在线图表嵌入指定的 Notion 页面，保留画布与缩放功能。</p>
          </div>
          <button id="open-options" type="button" class="secondary-link">配置页</button>
        </div>
        <div class="connection-grid">
          <div class="connection-item" id="credential-state">
            <span class="connection-icon" aria-hidden="true">N</span>
            <div><strong>Notion 连接</strong><span class="status-chip" id="credential-status">正在读取</span><p id="credential-detail">正在读取配置页保存的密钥...</p></div>
          </div>
          <div class="connection-item" id="page-state">
            <span class="connection-icon" aria-hidden="true">↗</span>
            <div><strong>目标页面</strong><span class="status-chip" id="page-status">待检查</span><p id="page-detail">填写页面链接后，检查页面访问权限</p></div>
          </div>
        </div>
      </section>

      <form id="embed-form" class="panel embed-form" novalidate>
        <h2>ProcessOn 图表</h2>
        <div class="field">
          <label for="processon-url">ProcessOn 嵌入链接或 iframe 代码</label>
          <textarea id="processon-url" rows="3" placeholder="https://www.processon.com/embed/..." aria-describedby="processon-hint processon-url-error" spellcheck="false"></textarea>
          <small id="processon-hint">在 ProcessOn 开启公开分享和「嵌入第三方」，复制嵌入链接或 iframe 代码。</small>
          <small class="input-error" id="processon-url-error"></small>
        </div>
        <div class="field">
          <label for="notion-url">Notion 页面链接或 ID</label>
          <input id="notion-url" type="text" placeholder="https://www.notion.so/..." aria-describedby="notion-hint notion-url-error" autocomplete="off" spellcheck="false" />
          <small id="notion-hint">在目标页面右上角「••• → 连接」中添加配置页使用的 Notion 集成。</small>
          <small class="input-error" id="notion-url-error"></small>
        </div>
        <div class="embed-options">
          <div class="field">
            <label for="block-title">图表标题（可选）</label>
            <input id="block-title" type="text" maxlength="80" placeholder="例如：阅读笔记思维导图" aria-describedby="title-hint block-title-error" />
            <small id="title-hint">最多 80 个字符，作为二级标题显示在图表上方。</small>
            <small class="input-error" id="block-title-error"></small>
          </div>
          <div class="field">
            <label for="position">插入位置</label>
            <select id="position" aria-describedby="position-error">
              <option value="end">页面底部</option>
              <option value="start">页面顶部</option>
            </select>
            <small class="input-error" id="position-error"></small>
          </div>
        </div>
        <div class="embed-actions">
          <div class="actions">
            <button id="check-page" type="button" class="secondary-link" disabled>检查页面连接</button>
            <button id="preview-graph" type="button" class="secondary-link">先预览图表</button>
          </div>
          <button id="embed-graph" type="submit" class="primary" disabled>嵌入到 Notion</button>
        </div>
        <p id="progress-text" class="progress-text" role="status" aria-live="polite" hidden></p>
      </form>

      <section id="result" class="panel result-panel" role="status" aria-live="polite" hidden>
        <div><h2 id="result-title"></h2><p id="result-message"></p></div>
        <a id="result-link" class="secondary-link" target="_blank" rel="noopener noreferrer" hidden>打开 Notion 页面</a>
      </section>

      <section id="preview-panel" class="panel preview-panel" hidden>
        <div class="preview-heading"><h2>图表预览</h2><div class="actions">
          <a id="preview-original" class="secondary-link" target="_blank" rel="noopener noreferrer">打开原图</a>
          <button id="close-preview" type="button" class="secondary-link">关闭预览</button>
        </div></div>
        <p class="hint">若预览无法显示，请检查公开分享、第三方嵌入权限、访问密码和有效期。</p>
        <iframe id="preview-frame" title="ProcessOn 图表预览" referrerpolicy="no-referrer" sandbox="allow-scripts allow-same-origin allow-popups"></iframe>
      </section>

      <details id="usage-guide" class="panel usage-guide">
        <summary>使用说明</summary>
        <p>Notion 密钥统一在配置页保存，本页直接使用。只嵌入图表时，保存密钥即可，无需验证书籍数据库或配置微信读书。</p>
        <p>检查页面连接只读取页面。嵌入需要 Notion 集成具备「读取内容」和「插入内容」权限。</p>
        <p>写入前会检查页面顶层的所有区块，已有相同图表时提供区块链接。折叠、分栏或 Callout 内的图表不在重复检测范围内。</p>
        <p>图表加载 ProcessOn 在线内容。保存修改后若未立即更新，请重新打开或刷新 Notion 页面。</p>
      </details>
    </main>
  `;
  document.querySelector("#open-options")?.addEventListener("click", openOptionsPage);
  document.querySelector("#embed-form")?.addEventListener("submit", (event) => {
    event.preventDefault();
    void submitEmbed();
  });
  document.querySelector("#check-page")?.addEventListener("click", () => void checkPage());
  document.querySelector("#preview-graph")?.addEventListener("click", previewGraph);
  document.querySelector("#close-preview")?.addEventListener("click", closePreview);
  for (const id of ["processon-url", "notion-url", "block-title", "position"]) {
    element(id).addEventListener("input", () => {
      clearFieldError(id);
      element("result").hidden = true;
      if (id === "notion-url") {
        connectionRevision += 1;
        resetPageConnection();
      }
      if (id === "processon-url") closePreview();
    });
  }
}

async function refreshCredentialState(): Promise<void> {
  hasToken = Boolean((await getSettings()).notionToken.trim());
  element("credential-state").classList.toggle("ready", hasToken);
  element("credential-status").textContent = hasToken ? "已配置" : "待处理";
  element("credential-detail").textContent = hasToken ? "使用配置页保存的 Notion 密钥" : "请到配置页填写密钥并保存设置";
  updateButtons();
}

function updateButtons(): void {
  element<HTMLButtonElement>("check-page").disabled = busy || !hasToken;
  element<HTMLButtonElement>("embed-graph").disabled = busy || !hasToken;
  element<HTMLButtonElement>("preview-graph").disabled = busy;
  element<HTMLButtonElement>("embed-graph").textContent = busy ? "处理中..." : "嵌入到 Notion";
}

function setBusy(value: boolean, message = ""): void {
  busy = value;
  for (const id of ["processon-url", "notion-url", "block-title", "position"]) {
    element<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(id).disabled = value;
  }
  element("embed-form").setAttribute("aria-busy", String(value));
  element("progress-text").hidden = !value;
  element("progress-text").textContent = message;
  updateButtons();
}

function prepareAction(): void {
  dismissTips();
  for (const id of ["processon-url", "notion-url", "block-title", "position"]) clearFieldError(id);
  element("result").hidden = true;
}

async function submitEmbed(): Promise<void> {
  if (busy) return;
  prepareAction();
  let pageId: string | undefined;
  const revision = connectionRevision;
  try {
    const embedUrl = normalizeProcessOn(readValue("processon-url"));
    pageId = parseNotionPage(readValue("notion-url"));
    const input: ProcessOnEmbedInput = {
      pageId,
      embedUrl,
      title: readValue("block-title"),
      position: readValue("position") as "start" | "end"
    };
    buildEmbedPayload(input);
    setBusy(true, "正在检查目标页面与已有图表，并创建嵌入区块...");
    const result = await sendBackgroundMessage<ProcessOnEmbedResult>({ type: "EMBED_PROCESSON", input });
    if (revision === connectionRevision) markPageConnected(result.pageTitle);
    const message = result.created
      ? `已添加到「${result.pageTitle}」。打开 Notion 即可查看在线图表。`
      : `「${result.pageTitle}」的页面顶层已有相同图表，本次没有重复添加。`;
    showResult(result.created ? "success" : "info", result.created ? "图表已嵌入" : "图表已存在", message, notionPageUrl(result.pageId, result.blockId));
    showTips(message, result.created ? "success" : "info");
  } catch (error) {
    setBusy(false);
    showError(error, pageId);
  } finally {
    setBusy(false);
  }
}

async function checkPage(): Promise<void> {
  if (busy) return;
  prepareAction();
  resetPageConnection();
  const revision = connectionRevision;
  try {
    const pageId = parseNotionPage(readValue("notion-url"));
    setBusy(true, "正在检查页面访问权限...");
    const result = await sendBackgroundMessage<NotionPageConnection>({ type: "CHECK_NOTION_PAGE", pageId });
    if (revision === connectionRevision) markPageConnected(result.pageTitle);
    showResult("info", "页面连接正常", `可以读取「${result.pageTitle}」。嵌入还需要「插入内容」权限，本次检查没有修改页面。`, result.pageUrl);
    showTips(`页面连接正常：${result.pageTitle}`, "success");
  } catch (error) {
    setBusy(false);
    showError(error);
  } finally {
    setBusy(false);
  }
}

function previewGraph(): void {
  prepareAction();
  try {
    const url = normalizeProcessOn(readValue("processon-url"));
    element<HTMLIFrameElement>("preview-frame").src = url;
    element<HTMLAnchorElement>("preview-original").href = url;
    element("preview-panel").hidden = false;
    element("preview-panel").scrollIntoView({ behavior: "smooth", block: "nearest" });
  } catch (error) {
    showError(error);
  }
}

function closePreview(): void {
  element("preview-panel").hidden = true;
  element("preview-frame").removeAttribute("src");
}

function markPageConnected(title: string): void {
  element("page-state").classList.add("ready");
  element("page-status").textContent = "可访问";
  element("page-detail").textContent = title;
}

function resetPageConnection(): void {
  element("page-state").classList.remove("ready");
  element("page-status").textContent = "待检查";
  element("page-detail").textContent = "填写页面链接后，检查页面访问权限";
}

function showError(error: unknown, pageId?: string): void {
  const known = error instanceof ToolError || error instanceof BackgroundError;
  const message = error instanceof Error ? error.message : "操作未完成，请稍后重试。";
  const uncertain = known && error.uncertain;
  showTips(message, "error");
  showResult("error", uncertain ? "请先确认写入结果" : "操作未完成", message, uncertain && pageId ? notionPageUrl(pageId) : undefined);
  if (known && error.field) {
    const field = document.getElementById(error.field);
    field?.setAttribute("aria-invalid", "true");
    const hint = document.getElementById(`${error.field}-error`);
    if (hint) hint.textContent = message;
    (field ?? (error.field === "notion-token" ? element("open-options") : null))?.focus();
  }
  if (known && (error.field === "notion-token" || ["restricted_resource", "object_not_found"].includes(error.code ?? ""))) {
    element<HTMLDetailsElement>("usage-guide").open = true;
    resetPageConnection();
  }
}

function showResult(kind: "success" | "info" | "error", title: string, message: string, href?: string): void {
  element("result").hidden = false;
  element("result").dataset.kind = kind;
  element("result-title").textContent = title;
  element("result-message").textContent = message;
  const link = element<HTMLAnchorElement>("result-link");
  link.hidden = !href;
  if (href) link.href = href;
  else link.removeAttribute("href");
}

function clearFieldError(id: string): void {
  element(id).removeAttribute("aria-invalid");
  element(`${id}-error`).textContent = "";
}

function readValue(id: string): string {
  return element<HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement>(id).value.trim();
}

function element<T extends HTMLElement = HTMLElement>(id: string): T {
  return document.getElementById(id) as T;
}

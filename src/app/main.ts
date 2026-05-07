import "./styles.css";

type AppTab = "sync" | "highlights" | "settings";

const app = document.querySelector<HTMLDivElement>("#app");
const tabs: Array<{ id: AppTab; label: string; src: string }> = [
  { id: "sync", label: "书架同步", src: chrome.runtime.getURL("function.html") },
  { id: "highlights", label: "划线同步", src: chrome.runtime.getURL("highlights.html") },
  { id: "settings", label: "配置页", src: chrome.runtime.getURL("options.html") }
];

let activeTab: AppTab = getInitialTab();

render();
updateActiveTab();

window.addEventListener("message", (event: MessageEvent<{ type?: string; tab?: AppTab }>) => {
  if (event.origin !== window.location.origin || event.data?.type !== "SWITCH_TAB") {
    return;
  }
  switchTab(event.data.tab);
});

function render(): void {
  if (!app) {
    return;
  }

  app.innerHTML = `
    <main class="app-shell">
      <header class="app-header">
        <div>
          <p>WeRead to Notion</p>
          <h1 id="page-title"></h1>
        </div>
        <nav class="tabs" aria-label="页面切换">
          ${tabs
            .map(
              (tab) => `
                <button
                  class="tab"
                  type="button"
                  data-tab="${tab.id}"
                  aria-selected="false"
                >
                  ${tab.label}
                </button>
              `
            )
            .join("")}
        </nav>
      </header>

      <section class="tab-panels">
        ${tabs
          .map(
            (tab) => `
              <iframe
                class="tab-panel"
                data-panel="${tab.id}"
                title="${tab.label}"
                src="${tab.src}"
              ></iframe>
            `
          )
          .join("")}
      </section>
    </main>
  `;

  document.querySelectorAll<HTMLButtonElement>("[data-tab]").forEach((button) => {
    button.addEventListener("click", () => switchTab(button.dataset.tab as AppTab | undefined));
  });
}

function switchTab(tab: AppTab | undefined): void {
  if (!tab || tab === activeTab || !tabs.some((item) => item.id === tab)) {
    return;
  }
  activeTab = tab;
  window.history.replaceState(null, "", `#${tab}`);
  updateActiveTab();
}

function updateActiveTab(): void {
  document.querySelector("#page-title")?.replaceChildren(document.createTextNode(getTabLabel(activeTab)));

  document.querySelectorAll<HTMLButtonElement>("[data-tab]").forEach((button) => {
    const selected = button.dataset.tab === activeTab;
    button.classList.toggle("active", selected);
    button.setAttribute("aria-selected", selected ? "true" : "false");
  });

  document.querySelectorAll<HTMLIFrameElement>("[data-panel]").forEach((panel) => {
    panel.classList.toggle("active", panel.dataset.panel === activeTab);
  });
}

function getInitialTab(): AppTab {
  if (window.location.hash === "#settings") {
    return "settings";
  }
  if (window.location.hash === "#highlights") {
    return "highlights";
  }
  return "sync";
}

function getTabLabel(tab: AppTab): string {
  return tabs.find((item) => item.id === tab)?.label ?? "书架同步";
}

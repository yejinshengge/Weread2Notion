import "./tips.css";

export type TipsType = "success" | "error" | "info";

let activeTips: HTMLDivElement | null = null;
let tipsTimer: number | undefined;

export function showTips(message: string, type: TipsType): void {
  dismissTips();

  const tips = document.createElement("div");
  tips.className = `tips ${type}`;
  tips.setAttribute("role", type === "error" ? "alert" : "status");
  tips.setAttribute("aria-live", type === "error" ? "assertive" : "polite");

  const icon = document.createElement("span");
  icon.className = "tips-icon";
  icon.setAttribute("aria-hidden", "true");
  icon.textContent = type === "error" ? "!" : type === "success" ? "✓" : "i";

  const content = document.createElement("div");
  content.className = "tips-message";
  content.textContent = message;

  const close = document.createElement("button");
  close.className = "tips-close";
  close.type = "button";
  close.setAttribute("aria-label", "关闭提示");
  close.textContent = "×";
  close.addEventListener("click", dismissTips);

  tips.append(icon, content, close);
  document.body.append(tips);
  activeTips = tips;
  if (content.scrollHeight > content.clientHeight) {
    content.tabIndex = 0;
  }

  // Long messages stay available while the user reads or scrolls through them.
  const persistent = message.length > 120 || message.includes("\n") || content.scrollHeight > content.clientHeight;
  const duration = type === "error" ? 6500 : 4200;
  const scheduleDismiss = (): void => {
    window.clearTimeout(tipsTimer);
    if (persistent || activeTips !== tips || tips.matches(":hover") || tips.contains(document.activeElement)) {
      return;
    }
    tipsTimer = window.setTimeout(dismissTips, duration);
  };

  tips.addEventListener("mouseenter", () => window.clearTimeout(tipsTimer));
  tips.addEventListener("mouseleave", scheduleDismiss);
  tips.addEventListener("focusin", () => window.clearTimeout(tipsTimer));
  tips.addEventListener("focusout", scheduleDismiss);
  scheduleDismiss();
}

export function dismissTips(): void {
  window.clearTimeout(tipsTimer);
  tipsTimer = undefined;
  activeTips?.remove();
  activeTips = null;
}

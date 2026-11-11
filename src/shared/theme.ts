import "./theme.css";

type ThemePreference = "system" | "light" | "dark";

const THEME_KEY = "theme";
let preference: ThemePreference = "system";

export async function initTheme(onPreferenceChange?: () => void): Promise<void> {
  const systemTheme = window.matchMedia("(prefers-color-scheme: dark)");
  let receivedStorageChange = false;

  function applyTheme(): void {
    const systemColor = systemTheme.matches ? "dark" : "light";
    document.documentElement.dataset.theme = preference === "system" ? systemColor : preference;
  }

  function applyPreference(value: unknown): void {
    preference = normalizePreference(value);
    applyTheme();
    onPreferenceChange?.();
  }

  systemTheme.addEventListener("change", applyTheme);
  chrome.storage.onChanged.addListener((changes, areaName) => {
    const change = changes[THEME_KEY];
    if (areaName !== "local" || !change) return;
    receivedStorageChange = true;
    applyPreference(change.newValue);
  });

  const stored: Record<string, unknown> = await chrome.storage.local.get(THEME_KEY).catch(() => ({}));
  if (!receivedStorageChange) applyPreference(stored[THEME_KEY]);
}

export function getThemePreference(): ThemePreference {
  return preference;
}

export function saveThemePreference(value: string): Promise<void> {
  return chrome.storage.local.set({ [THEME_KEY]: normalizePreference(value) });
}

function normalizePreference(value: unknown): ThemePreference {
  return value === "light" || value === "dark" ? value : "system";
}

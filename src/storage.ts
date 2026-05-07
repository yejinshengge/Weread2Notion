import { DEFAULT_MAPPINGS } from "./shared/fields";
import type { CachedBookList, ExtensionSettings, FieldMapping, SyncField } from "./shared/types";

const SETTINGS_KEY = "settings";
const BOOK_LIST_CACHE_KEY = "bookListCache";

export const defaultSettings: ExtensionSettings = {
  notionToken: "",
  databaseId: "",
  databaseUrl: "",
  highlightDatabaseId: "",
  highlightDatabaseUrl: "",
  mappings: cloneDefaultMappings(),
  useNotionCover: true,
  databaseProperties: [],
  highlightDatabaseProperties: []
};

export async function getSettings(): Promise<ExtensionSettings> {
  const result = await chrome.storage.local.get(SETTINGS_KEY);
  return normalizeSettings(result[SETTINGS_KEY]);
}

export async function saveSettings(settings: ExtensionSettings): Promise<void> {
  await chrome.storage.local.set({ [SETTINGS_KEY]: normalizeSettings(settings) });
}

export async function getCachedBookList(): Promise<CachedBookList | null> {
  const result = await chrome.storage.local.get(BOOK_LIST_CACHE_KEY);
  return normalizeBookListCache(result[BOOK_LIST_CACHE_KEY]);
}

export async function saveCachedBookList(cache: CachedBookList): Promise<void> {
  await chrome.storage.local.set({ [BOOK_LIST_CACHE_KEY]: normalizeBookListCache(cache) });
}

export async function clearCachedBookList(): Promise<void> {
  await chrome.storage.local.remove(BOOK_LIST_CACHE_KEY);
}

function normalizeSettings(value: Partial<ExtensionSettings> | undefined): ExtensionSettings {
  return {
    ...defaultSettings,
    ...value,
    mappings: normalizeMappings(value?.mappings),
    databaseProperties: value?.databaseProperties ?? [],
    highlightDatabaseProperties: value?.highlightDatabaseProperties ?? []
  };
}

function cloneDefaultMappings() {
  return Object.fromEntries(
    Object.entries(DEFAULT_MAPPINGS).map(([field, mapping]) => [field, { ...mapping }])
  ) as ExtensionSettings["mappings"];
}

function normalizeMappings(
  value: Partial<Record<string, Partial<FieldMapping>>> | undefined
): ExtensionSettings["mappings"] {
  return Object.fromEntries(
    Object.entries(DEFAULT_MAPPINGS).map(([field, defaultMapping]) => [
      field,
      {
        ...defaultMapping,
        ...(value?.[field] ?? {}),
        overwriteOnUpdate: field === "wereadId" ? false : Boolean(value?.[field]?.overwriteOnUpdate)
      }
    ])
  ) as Record<SyncField, FieldMapping>;
}

function normalizeBookListCache(value: Partial<CachedBookList> | undefined): CachedBookList | null {
  if (!value || !Array.isArray(value.books)) {
    return null;
  }

  const selectedIds = Array.isArray(value.selectedIds)
    ? value.selectedIds.filter((id): id is string => typeof id === "string")
    : value.books.map((book) => book.bookId).filter(Boolean);

  return {
    books: value.books,
    selectedIds,
    fetchedAt: typeof value.fetchedAt === "string" ? value.fetchedAt : new Date().toISOString()
  };
}

import { DEFAULT_FIELD_MAPPINGS, DEFAULT_HIGHLIGHT_FIELD_MAPPINGS, DEFAULT_MAPPINGS } from "./shared/fields";
import type {
  CachedBookList,
  ExtensionSettings,
  FieldMapping,
  FieldMappingEntry,
  HighlightSyncField,
  SyncField
} from "./shared/types";

const SETTINGS_KEY = "settings";
const BOOK_LIST_CACHE_KEY = "bookListCache";

export const defaultSettings: ExtensionSettings = {
  notionToken: "",
  databaseId: "",
  databaseUrl: "",
  highlightDatabaseId: "",
  highlightDatabaseUrl: "",
  fieldMappings: cloneDefaultFieldMappings(DEFAULT_FIELD_MAPPINGS),
  highlightFieldMappings: cloneDefaultFieldMappings(DEFAULT_HIGHLIGHT_FIELD_MAPPINGS),
  mappings: cloneDefaultMappings(),
  useNotionCover: true,
  useHighlightNotionCover: true,
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
    fieldMappings: normalizeFieldMappings<SyncField>(
      value?.fieldMappings,
      migrateLegacyMappings(value?.mappings),
      DEFAULT_FIELD_MAPPINGS
    ),
    highlightFieldMappings: normalizeFieldMappings<HighlightSyncField>(
      value?.highlightFieldMappings,
      undefined,
      DEFAULT_HIGHLIGHT_FIELD_MAPPINGS
    ),
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

function cloneDefaultFieldMappings<TSource extends string>(
  entries: Array<FieldMappingEntry<TSource>>
): Array<FieldMappingEntry<TSource>> {
  return entries.map((entry) => ({ ...entry }));
}

function normalizeFieldMappings<TSource extends string>(
  value: unknown,
  migratedEntries: Array<FieldMappingEntry<TSource>> | undefined,
  defaults: Array<FieldMappingEntry<TSource>>
): Array<FieldMappingEntry<TSource>> {
  const entries = Array.isArray(value) ? value : migratedEntries ?? defaults;
  return entries
    .map((entry, index) => normalizeFieldMappingEntry<TSource>(entry, index))
    .filter((entry): entry is FieldMappingEntry<TSource> => Boolean(entry));
}

function normalizeFieldMappingEntry<TSource extends string>(
  value: unknown,
  index: number
): FieldMappingEntry<TSource> | null {
  if (!value || typeof value !== "object") {
    return null;
  }

  const entry = value as Partial<FieldMappingEntry<TSource>>;
  const sourceType = entry.sourceType === "custom" ? "custom" : "field";
  const sourceField = typeof entry.sourceField === "string" ? (entry.sourceField as TSource) : "";

  return {
    id: typeof entry.id === "string" && entry.id ? entry.id : `field-${Date.now()}-${index}`,
    propertyName: typeof entry.propertyName === "string" ? entry.propertyName : "",
    sourceType,
    sourceField: sourceType === "field" ? sourceField : "",
    customValue: typeof entry.customValue === "string" ? entry.customValue : "",
    overwriteOnUpdate: Boolean(entry.overwriteOnUpdate)
  };
}

function migrateLegacyMappings(
  value: Partial<Record<string, Partial<FieldMapping>>> | undefined
): Array<FieldMappingEntry<SyncField>> | undefined {
  if (!value) {
    return undefined;
  }

  const entries: Array<FieldMappingEntry<SyncField>> = [];
  for (const field of Object.keys(DEFAULT_MAPPINGS) as SyncField[]) {
    const mapping = value[field];
    if (!mapping?.enabled || !mapping.propertyName) {
      continue;
    }
    entries.push({
      id: `legacy-${field}`,
      propertyName: mapping.propertyName,
      sourceType: "field",
      sourceField: field,
      customValue: "",
      overwriteOnUpdate: field === "wereadId" ? false : Boolean(mapping.overwriteOnUpdate)
    });
  }
  return entries;
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

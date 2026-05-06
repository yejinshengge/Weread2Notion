import { getAllowedTypes, isCompatibleProperty } from "../shared/fields";
import type {
  DatabaseProperty,
  ExtensionSettings,
  FieldMapping,
  NotionPropertyType,
  SyncProgress,
  SyncField,
  SyncSummary,
  WeReadBook
} from "../shared/types";

const NOTION_VERSION = "2022-06-28";
const NOTION_API_BASE = "https://api.notion.com/v1";

interface NotionDatabaseResponse {
  id: string;
  properties: Record<string, { id: string; type: NotionPropertyType }>;
}

interface NotionQueryResponse {
  results: Array<{ id: string }>;
}

interface NotionErrorResponse {
  message?: string;
  code?: string;
}

type NotionPropertyValue = Record<string, unknown>;
type NotionPagePayload = {
  properties?: Record<string, NotionPropertyValue>;
  cover?: {
    type: "external";
    external: { url: string };
  };
};

export interface DatabaseValidationResult {
  databaseId: string;
  properties: DatabaseProperty[];
}

interface SyncBooksOptions {
  onProgress?: (progress: SyncProgress) => void | Promise<void>;
}

export async function validateDatabase(token: string, databaseIdOrUrl: string): Promise<DatabaseValidationResult> {
  const databaseId = extractDatabaseId(databaseIdOrUrl);
  const database = await notionRequest<NotionDatabaseResponse>(token, `/databases/${databaseId}`, {
    method: "GET"
  });
  const properties = mapDatabaseProperties(database.properties);
  const titleProperty = getTitleProperty(properties);

  if (!titleProperty) {
    throw new Error("目标数据库必须包含 title 类型字段");
  }

  return {
    databaseId: database.id,
    properties
  };
}

export async function syncBooksToNotion(
  settings: ExtensionSettings,
  books: WeReadBook[],
  options: SyncBooksOptions = {}
): Promise<SyncSummary> {
  ensureSyncSettings(settings);

  const summary: SyncSummary = {
    created: 0,
    updated: 0,
    skipped: 0,
    failed: [] as Array<{ title: string; reason: string }>
  };

  let completed = 0;
  await publishProgress(options, books.length, completed, summary);

  for (const book of books) {
    await publishProgress(options, books.length, completed, summary, book.title);
    try {
      const existingPageId = await findExistingPage(settings, book);

      if (existingPageId) {
        const payload = buildPagePayload(settings, book, { existingPage: true });
        if (hasPagePayloadChanges(payload)) {
          await notionRequest(settings.notionToken, `/pages/${existingPageId}`, {
            method: "PATCH",
            body: JSON.stringify(payload)
          });
          summary.updated += 1;
        } else {
          summary.skipped += 1;
        }
      } else {
        const payload = buildPagePayload(settings, book);
        await notionRequest(settings.notionToken, "/pages", {
          method: "POST",
          body: JSON.stringify({
            parent: { database_id: settings.databaseId },
            ...payload
          })
        });
        summary.created += 1;
      }
    } catch (error) {
      summary.failed.push({ title: book.title, reason: getErrorMessage(error) });
    }
    completed += 1;
    await publishProgress(options, books.length, completed, summary);
  }

  return summary;
}

export function extractDatabaseId(databaseIdOrUrl: string): string {
  const trimmed = databaseIdOrUrl.trim();
  const compactId = trimmed.replace(/-/g, "");
  if (/^[a-f0-9]{32}$/i.test(compactId)) {
    return compactId;
  }

  const match = trimmed.match(/[a-f0-9]{32}/i);
  if (match) {
    return match[0];
  }

  throw new Error("无法识别 Notion 数据库 ID 或 URL");
}

export function getMappingError(
  field: SyncField,
  mapping: FieldMapping,
  properties: DatabaseProperty[]
): string | null {
  if (!mapping.enabled) {
    return null;
  }
  if (!mapping.propertyName) {
    return "请选择字段";
  }
  const property = properties.find((item) => item.name === mapping.propertyName);
  if (!property) {
    return "字段不存在";
  }
  if (!isCompatibleProperty(field, property.type)) {
    return `字段类型需为 ${getAllowedTypes(field).join(" / ")}`;
  }
  return null;
}

export function getTitleProperty(properties: DatabaseProperty[]): DatabaseProperty | null {
  return properties.find((property) => property.type === "title") ?? null;
}

function ensureSyncSettings(settings: ExtensionSettings): void {
  if (!settings.notionToken || !settings.databaseId) {
    throw new Error("请先完成 Notion 设置");
  }
  const titleProperty = getTitleProperty(settings.databaseProperties);
  if (!titleProperty) {
    throw new Error("目标数据库必须包含 title 类型字段");
  }

  const idMapping = settings.mappings.wereadId;
  if (!idMapping.enabled || !idMapping.propertyName) {
    throw new Error("请先映射 WeRead ID 字段以避免重复同步");
  }

  const idMappingError = getMappingError("wereadId", idMapping, settings.databaseProperties);
  if (idMappingError) {
    throw new Error(`WeRead ID 字段配置有误：${idMappingError}`);
  }
}

async function findExistingPage(settings: ExtensionSettings, book: WeReadBook): Promise<string | null> {
  const property = getMappedProperty(settings, "wereadId");
  if (!property) {
    return null;
  }

  const filter =
    property.type === "select"
      ? { property: property.name, select: { equals: book.bookId } }
      : { property: property.name, rich_text: { equals: book.bookId } };

  const response = await notionRequest<NotionQueryResponse>(settings.notionToken, `/databases/${settings.databaseId}/query`, {
    method: "POST",
    body: JSON.stringify({
      filter,
      page_size: 1
    })
  });

  return response.results[0]?.id ?? null;
}

function buildPagePayload(
  settings: ExtensionSettings,
  book: WeReadBook,
  options: { existingPage?: boolean } = {}
): NotionPagePayload {
  const titleProperty = getTitleProperty(settings.databaseProperties);
  if (!titleProperty) {
    throw new Error("目标数据库必须包含 title 类型字段");
  }

  const properties: Record<string, NotionPropertyValue> = {};

  if (!options.existingPage) {
    properties[titleProperty.name] = {
      title: [{ text: { content: book.title } }]
    };
  }

  for (const field of Object.keys(settings.mappings) as SyncField[]) {
    const mapping = settings.mappings[field];
    if (options.existingPage && (field === "wereadId" || !mapping.overwriteOnUpdate)) {
      continue;
    }
    const mappedProperty = getMappedProperty(settings, field);
    if (!mappedProperty) {
      continue;
    }
    const propertyValue = buildPropertyValue(field, mappedProperty.type, book);
    if (propertyValue) {
      properties[mappedProperty.name] = propertyValue;
    }
  }

  const payload: NotionPagePayload = {};
  if (Object.keys(properties).length > 0) {
    payload.properties = properties;
  }

  const canUpdateCover = !options.existingPage || Boolean(settings.mappings.cover?.overwriteOnUpdate);
  if (settings.useNotionCover && book.cover && canUpdateCover) {
    payload.cover = {
      type: "external",
      external: { url: book.cover }
    };
  }

  return payload;
}

function hasPagePayloadChanges(payload: NotionPagePayload): boolean {
  return Boolean((payload.properties && Object.keys(payload.properties).length > 0) || payload.cover);
}

function getMappedProperty(settings: ExtensionSettings, field: SyncField): DatabaseProperty | null {
  const mapping = settings.mappings[field];
  if (!mapping.enabled || !mapping.propertyName) {
    return null;
  }
  const property = settings.databaseProperties.find((item) => item.name === mapping.propertyName);
  if (!property || getMappingError(field, mapping, settings.databaseProperties)) {
    return null;
  }
  return property;
}

function buildPropertyValue(
  field: SyncField,
  type: NotionPropertyType,
  book: WeReadBook
): NotionPropertyValue | null {
  const value = getBookFieldValue(field, book);
  if (value === undefined || value === "") {
    return null;
  }

  switch (type) {
    case "number":
      return { number: typeof value === "number" ? value : Number(value) };
    case "url":
      return { url: String(value) };
    case "files":
      return {
        files: [
          {
            name: `${book.title} 封面`,
            type: "external",
            external: { url: String(value) }
          }
        ]
      };
    case "select":
      return { select: { name: String(value) } };
    case "status":
      return { status: { name: String(value) } };
    case "date":
      return { date: { start: String(value) } };
    case "rich_text":
      return { rich_text: [{ text: { content: String(value) } }] };
    default:
      return null;
  }
}

function getBookFieldValue(field: SyncField, book: WeReadBook): string | number | undefined {
  switch (field) {
    case "cover":
      return book.cover;
    case "progress":
      return book.progress;
    case "author":
      return book.author;
    case "url":
      return book.url;
    case "status":
      return book.status;
    case "startReadAt":
      return book.startReadAt;
    case "lastReadAt":
      return book.lastReadAt;
    case "wereadId":
      return book.bookId;
  }
}

function mapDatabaseProperties(properties: NotionDatabaseResponse["properties"]): DatabaseProperty[] {
  return Object.entries(properties).map(([name, value]) => ({
    id: value.id,
    name,
    type: value.type ?? "unknown"
  }));
}

async function publishProgress(
  options: SyncBooksOptions,
  total: number,
  completed: number,
  summary: SyncSummary,
  currentTitle?: string
): Promise<void> {
  await options.onProgress?.({
    total,
    completed,
    currentTitle,
    summary: {
      created: summary.created,
      updated: summary.updated,
      skipped: summary.skipped,
      failed: [...summary.failed]
    }
  });
}

async function notionRequest<T>(
  token: string,
  path: string,
  init: RequestInit
): Promise<T> {
  const headers = new Headers(init.headers);
  headers.set("Authorization", `Bearer ${token}`);
  headers.set("Notion-Version", NOTION_VERSION);
  headers.set("Content-Type", "application/json");

  const response = await fetch(`${NOTION_API_BASE}${path}`, {
    ...init,
    headers
  });

  if (!response.ok) {
    let message = `Notion 请求失败：${response.status}`;
    try {
      const error = (await response.json()) as NotionErrorResponse;
      message = error.message || error.code || message;
    } catch {
      // Keep the status-based message when Notion does not return JSON.
    }
    throw new Error(message);
  }

  if (response.status === 204) {
    return undefined as T;
  }

  return (await response.json()) as T;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "未知错误";
}

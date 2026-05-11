import {
  getBookAllowedTypes,
  getHighlightAllowedTypes,
  isBookEntryCompatible,
  isHighlightEntryCompatible
} from "../shared/fields";
import type {
  DatabaseProperty,
  ExtensionSettings,
  FieldMappingEntry,
  HighlightSyncField,
  FieldMapping,
  NotionPageSearchResult,
  NotionPropertyType,
  SyncProgress,
  SyncField,
  SyncSummary,
  WeReadBook,
  WeReadHighlightNote,
  WeReadNotebookBook
} from "../shared/types";

const NOTION_VERSION = "2022-06-28";
const NOTION_API_BASE = "https://api.notion.com/v1";

interface NotionDatabaseResponse {
  id: string;
  properties: Record<string, NotionDatabasePropertyResponse>;
}

interface NotionQueryResponse {
  results: Array<{ id: string; properties?: Record<string, NotionPagePropertyResponse> }>;
  has_more?: boolean;
  next_cursor?: string | null;
}

interface NotionPageResponse {
  id: string;
}

interface NotionDatabasePropertyResponse {
  id: string;
  type: NotionPropertyType;
  select?: { options?: NotionOptionResponse[] };
  status?: { options?: NotionOptionResponse[] };
  multi_select?: { options?: NotionOptionResponse[] };
  relation?: { database_id?: string };
}

interface NotionOptionResponse {
  id: string;
  name: string;
  color?: string;
}

interface NotionPagePropertyResponse {
  id?: string;
  type?: NotionPropertyType;
  title?: Array<{ plain_text?: string; text?: { content?: string } }>;
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
type NotionBlock = Record<string, unknown>;
const NOTION_CHILDREN_BATCH_SIZE = 100;

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

export async function searchDatabasePages(
  token: string,
  databaseId: string,
  query: string
): Promise<NotionPageSearchResult[]> {
  const database = await notionRequest<NotionDatabaseResponse>(token, `/databases/${databaseId}`, {
    method: "GET"
  });
  const titleProperty = Object.entries(database.properties).find(([, property]) => property.type === "title");
  if (!titleProperty) {
    return [];
  }

  const [titlePropertyName] = titleProperty;
  const trimmedQuery = query.trim();
  const response = await notionRequest<NotionQueryResponse>(token, `/databases/${databaseId}/query`, {
    method: "POST",
    body: JSON.stringify({
      ...(trimmedQuery
        ? {
            filter: {
              property: titlePropertyName,
              title: { contains: trimmedQuery }
            }
          }
        : {}),
      page_size: 20
    })
  });

  return response.results.map((page) => ({
    id: page.id,
    title: getPageTitle(page.properties?.[titlePropertyName]) || "Untitled"
  }));
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

export async function syncBookHighlightsToNotion(
  settings: ExtensionSettings,
  book: WeReadNotebookBook,
  notes: WeReadHighlightNote[]
): Promise<SyncSummary> {
  ensureHighlightSyncSettings(settings);

  const summary: SyncSummary = {
    created: 0,
    updated: 0,
    skipped: 0,
    failed: []
  };

  try {
    const existingPageId = await findExistingHighlightPage(settings, book);
    const payload = buildHighlightPagePayload(settings, book, notes, { existingPage: Boolean(existingPageId) });

    if (existingPageId) {
      await notionRequest(settings.notionToken, `/pages/${existingPageId}`, {
        method: "PATCH",
        body: JSON.stringify({ properties: payload.properties, cover: payload.cover })
      });
      await replacePageChildren(settings.notionToken, existingPageId, payload.children);
      summary.updated += 1;
    } else {
      const { children, ...pagePayload } = payload;
      const createdPage = await notionRequest<NotionPageResponse>(settings.notionToken, "/pages", {
        method: "POST",
        body: JSON.stringify({
          parent: { database_id: settings.highlightDatabaseId },
          ...pagePayload
        })
      });
      await appendPageChildren(settings.notionToken, createdPage.id, children);
      summary.created += 1;
    }
  } catch (error) {
    summary.failed.push({ title: book.title, reason: getErrorMessage(error) });
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
  if (!getBookAllowedTypes(field).includes(property.type)) {
    return `字段类型需为 ${getBookAllowedTypes(field).join(" / ")}`;
  }
  return null;
}

export function getBookFieldMappingError(
  entry: FieldMappingEntry<SyncField>,
  properties: DatabaseProperty[]
): string | null {
  return getFieldMappingEntryError(entry, properties, (field) => getBookAllowedTypes(field), isBookEntryCompatible);
}

export function getHighlightFieldMappingError(
  entry: FieldMappingEntry<HighlightSyncField>,
  properties: DatabaseProperty[]
): string | null {
  return getFieldMappingEntryError(
    entry,
    properties,
    (field) => getHighlightAllowedTypes(field),
    isHighlightEntryCompatible
  );
}

export function getTitleProperty(properties: DatabaseProperty[]): DatabaseProperty | null {
  return properties.find((property) => property.type === "title") ?? null;
}

function getFieldMappingEntryError<TSource extends string>(
  entry: FieldMappingEntry<TSource>,
  properties: DatabaseProperty[],
  getAllowedTypes: (field: TSource) => NotionPropertyType[],
  isCompatible: (entry: FieldMappingEntry<TSource>, propertyType: NotionPropertyType) => boolean
): string | null {
  if (!entry.propertyName) {
    return "请选择 Notion 字段";
  }
  if (entry.sourceType === "field" && !entry.sourceField) {
    return "请选择同步内容";
  }
  if (entry.sourceType === "custom" && !entry.customValue.trim()) {
    return "请输入自定义内容";
  }

  const property = properties.find((item) => item.name === entry.propertyName);
  if (!property) {
    return "字段不存在";
  }
  if (!isCompatible(entry, property.type)) {
    const allowedTypes = entry.sourceType === "field" && entry.sourceField ? getAllowedTypes(entry.sourceField) : [];
    return allowedTypes.length > 0 ? `字段类型需为 ${allowedTypes.join(" / ")}` : "该 Notion 字段类型不支持写入";
  }
  if (entry.sourceType === "custom") {
    return getCustomValueError(entry.customValue, property.type);
  }
  return null;
}

function getCustomValueError(value: string, propertyType: NotionPropertyType): string | null {
  const trimmed = value.trim();
  if (propertyType === "number" && !Number.isFinite(Number(trimmed))) {
    return "自定义内容需要是数字";
  }
  if (propertyType === "checkbox" && parseBooleanValue(trimmed) === null) {
    return "自定义内容需要是 true/false、是/否 或 1/0";
  }
  if (propertyType === "relation" && parseCustomRelationValue(trimmed).length === 0) {
    return "请选择关联页面";
  }
  return null;
}

function ensureSyncSettings(settings: ExtensionSettings): void {
  if (!settings.notionToken || !settings.databaseId) {
    throw new Error("请先完成 Notion 设置");
  }
  const titleProperty = getTitleProperty(settings.databaseProperties);
  if (!titleProperty) {
    throw new Error("目标数据库必须包含 title 类型字段");
  }

  const idMapping = getBookIdMapping(settings);
  if (!idMapping) {
    throw new Error("请先映射 WeRead ID 字段以避免重复同步");
  }

  const idMappingError = getBookFieldMappingError(idMapping, settings.databaseProperties);
  if (idMappingError) {
    throw new Error(`WeRead ID 字段配置有误：${idMappingError}`);
  }
}

function ensureHighlightSyncSettings(settings: ExtensionSettings): void {
  if (!settings.notionToken || !settings.highlightDatabaseId) {
    throw new Error("请先配置划线同步的 Notion 数据库");
  }
  const titleProperty = getTitleProperty(settings.highlightDatabaseProperties);
  if (!titleProperty) {
    throw new Error("划线同步数据库必须包含 title 类型字段");
  }
}

async function findExistingPage(settings: ExtensionSettings, book: WeReadBook): Promise<string | null> {
  const mapping = getBookIdMapping(settings);
  if (!mapping) {
    return null;
  }
  const property = getMappedProperty(settings.databaseProperties, mapping, getBookFieldMappingError);
  if (!property) {
    return null;
  }

  const filter = buildEqualsFilter(property, book.bookId);

  const response = await notionRequest<NotionQueryResponse>(settings.notionToken, `/databases/${settings.databaseId}/query`, {
    method: "POST",
    body: JSON.stringify({
      filter,
      page_size: 1
    })
  });

  return response.results[0]?.id ?? null;
}

async function findExistingHighlightPage(settings: ExtensionSettings, book: WeReadNotebookBook): Promise<string | null> {
  const idMapping = getHighlightBookIdMapping(settings);
  const idProperty = idMapping
    ? getMappedProperty(settings.highlightDatabaseProperties, idMapping, getHighlightFieldMappingError)
    : null;
  const titleProperty = getTitleProperty(settings.highlightDatabaseProperties);
  if (!titleProperty) {
    return null;
  }

  const filter = idProperty
    ? buildEqualsFilter(idProperty, book.bookId)
    : { property: titleProperty.name, title: { equals: getHighlightPageTitle(book) } };

  const response = await notionRequest<NotionQueryResponse>(
    settings.notionToken,
    `/databases/${settings.highlightDatabaseId}/query`,
    {
      method: "POST",
      body: JSON.stringify({
        filter,
        page_size: 1
      })
    }
  );

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

  for (const mapping of settings.fieldMappings) {
    if (options.existingPage && (mapping.sourceField === "wereadId" || !mapping.overwriteOnUpdate)) {
      continue;
    }
    const mappedProperty = getMappedProperty(settings.databaseProperties, mapping, getBookFieldMappingError);
    if (!mappedProperty) {
      continue;
    }
    const propertyValue = buildBookPropertyValue(mapping, mappedProperty.type, book);
    if (propertyValue) {
      properties[mappedProperty.name] = propertyValue;
    }
  }

  const payload: NotionPagePayload = {};
  if (Object.keys(properties).length > 0) {
    payload.properties = properties;
  }

  if (settings.useNotionCover && book.cover) {
    payload.cover = {
      type: "external",
      external: { url: book.cover }
    };
  }

  return payload;
}

function buildHighlightPagePayload(
  settings: ExtensionSettings,
  book: WeReadNotebookBook,
  notes: WeReadHighlightNote[],
  options: { existingPage?: boolean } = {}
): NotionPagePayload & { children: NotionBlock[] } {
  const titleProperty = getTitleProperty(settings.highlightDatabaseProperties);
  if (!titleProperty) {
    throw new Error("划线同步数据库必须包含 title 类型字段");
  }

  const properties: Record<string, NotionPropertyValue> = {
    [titleProperty.name]: {
      title: [{ text: { content: getHighlightPageTitle(book) } }]
    }
  };

  for (const mapping of settings.highlightFieldMappings) {
    if (options.existingPage && mapping.sourceField === "bookId" && !mapping.overwriteOnUpdate) {
      continue;
    }
    const mappedProperty = getMappedProperty(
      settings.highlightDatabaseProperties,
      mapping,
      getHighlightFieldMappingError
    );
    if (!mappedProperty) {
      continue;
    }
    const propertyValue = buildHighlightPropertyValue(mapping, mappedProperty.type, book, notes);
    if (propertyValue) {
      properties[mappedProperty.name] = propertyValue;
    }
  }

  const payload: NotionPagePayload & { children: NotionBlock[] } = {
    properties,
    children: buildHighlightPageChildren(book, notes)
  };

  if (settings.useHighlightNotionCover && book.cover) {
    payload.cover = {
      type: "external",
      external: { url: book.cover }
    };
  }

  return payload;
}

function getHighlightPageTitle(book: WeReadNotebookBook): string {
  return `《${book.title}》划线与想法`;
}

function buildHighlightPageChildren(book: WeReadNotebookBook, notes: WeReadHighlightNote[]): NotionBlock[] {
  const children: NotionBlock[] = [
    paragraphBlock(`书名：${book.title}`),
    paragraphBlock(`作者：${book.author || "未知"} · 划线 ${notes.filter((note) => note.original).length} · 想法 ${notes.filter((note) => note.thought).length}`),
    paragraphBlock(`微信读书：${book.url}`),
    dividerBlock()
  ];

  if (notes.length === 0) {
    children.push(paragraphBlock("这本书暂时没有读取到划线或想法。"));
    return children;
  }

  let currentChapter = "";
  for (const note of notes) {
    const chapterTitle = note.chapterTitle || "未分章节";
    if (chapterTitle !== currentChapter) {
      currentChapter = chapterTitle;
      children.push(headingBlock(chapterTitle));
    }
    children.push(...buildNoteBlocks(note));
    children.push(dividerBlock());
  }

  return children;
}

function buildNoteBlocks(note: WeReadHighlightNote): NotionBlock[] {
  const blocks: NotionBlock[] = [];
  const meta = [note.userName, note.createdAt ? formatDate(note.createdAt) : undefined].filter(Boolean).join(" · ");

  if (note.original) {
    blocks.push(...textBlocks("quote", note.original));
  }
  if (note.thought) {
    blocks.push(...textBlocks("paragraph", `想法：${note.thought}`));
  }
  if (meta) {
    blocks.push(paragraphBlock(meta));
  }
  return blocks;
}

function textBlocks(type: "paragraph" | "quote", text: string): NotionBlock[] {
  return splitText(text).map((content) =>
    type === "quote"
      ? {
          object: "block",
          type: "quote",
          quote: {
            rich_text: [{ type: "text", text: { content } }],
            color: "default"
          }
        }
      : paragraphBlock(content)
  );
}

function paragraphBlock(content: string): NotionBlock {
  return {
    object: "block",
    type: "paragraph",
    paragraph: {
      rich_text: [{ type: "text", text: { content } }],
      color: "default"
    }
  };
}

function headingBlock(content: string): NotionBlock {
  return {
    object: "block",
    type: "heading_2",
    heading_2: {
      rich_text: [{ type: "text", text: { content: truncateText(content, 180) } }],
      color: "default",
      is_toggleable: false
    }
  };
}

function dividerBlock(): NotionBlock {
  return {
    object: "block",
    type: "divider",
    divider: {}
  };
}

function splitText(text: string): string[] {
  const trimmed = text.trim();
  if (!trimmed) {
    return [];
  }
  const chunks: string[] = [];
  for (let index = 0; index < trimmed.length; index += 1900) {
    chunks.push(trimmed.slice(index, index + 1900));
  }
  return chunks;
}

function truncateText(text: string, maxLength: number): string {
  return text.length <= maxLength ? text : `${text.slice(0, maxLength - 1)}…`;
}

function formatDate(value: string): string {
  return new Intl.DateTimeFormat("zh-CN", {
    dateStyle: "medium",
    timeStyle: "short"
  }).format(new Date(value));
}

async function replacePageChildren(token: string, pageId: string, children: NotionBlock[]): Promise<void> {
  const existingChildren = await listPageChildren(token, pageId);
  for (const child of existingChildren) {
    await notionRequest(token, `/blocks/${child.id}`, {
      method: "PATCH",
      body: JSON.stringify({ archived: true })
    });
  }

  await appendPageChildren(token, pageId, children);
}

async function appendPageChildren(token: string, pageId: string, children: NotionBlock[]): Promise<void> {
  for (let index = 0; index < children.length; index += NOTION_CHILDREN_BATCH_SIZE) {
    await notionRequest(token, `/blocks/${pageId}/children`, {
      method: "PATCH",
      body: JSON.stringify({ children: children.slice(index, index + NOTION_CHILDREN_BATCH_SIZE) })
    });
  }
}

async function listPageChildren(token: string, pageId: string): Promise<Array<{ id: string }>> {
  const children: Array<{ id: string }> = [];
  let startCursor: string | undefined;

  do {
    const query = new URLSearchParams({ page_size: "100" });
    if (startCursor) {
      query.set("start_cursor", startCursor);
    }
    const response = await notionRequest<NotionQueryResponse>(token, `/blocks/${pageId}/children?${query.toString()}`, {
      method: "GET"
    });
    children.push(...response.results);
    startCursor = response.next_cursor ?? undefined;
    if (!response.has_more) {
      break;
    }
  } while (startCursor);

  return children;
}

function hasPagePayloadChanges(payload: NotionPagePayload): boolean {
  return Boolean((payload.properties && Object.keys(payload.properties).length > 0) || payload.cover);
}

function getMappedProperty<TSource extends string>(
  properties: DatabaseProperty[],
  mapping: FieldMappingEntry<TSource>,
  getError: (entry: FieldMappingEntry<TSource>, properties: DatabaseProperty[]) => string | null
): DatabaseProperty | null {
  if (!mapping.propertyName) {
    return null;
  }
  const property = properties.find((item) => item.name === mapping.propertyName);
  if (!property || getError(mapping, properties)) {
    return null;
  }
  return property;
}

function buildBookPropertyValue(
  mapping: FieldMappingEntry<SyncField>,
  type: NotionPropertyType,
  book: WeReadBook
): NotionPropertyValue | null {
  const value = getBookEntryValue(mapping, book);
  return buildPropertyValue(type, value, book.title);
}

function buildHighlightPropertyValue(
  mapping: FieldMappingEntry<HighlightSyncField>,
  type: NotionPropertyType,
  book: WeReadNotebookBook,
  notes: WeReadHighlightNote[]
): NotionPropertyValue | null {
  const value = getHighlightEntryValue(mapping, book, notes);
  return buildPropertyValue(type, value, book.title);
}

function buildPropertyValue(
  type: NotionPropertyType,
  value: string | number | boolean | undefined,
  fallbackName: string
): NotionPropertyValue | null {
  if (value === undefined || value === "") {
    return null;
  }

  switch (type) {
    case "number": {
      const numericValue = typeof value === "number" ? value : Number(value);
      return Number.isFinite(numericValue) ? { number: numericValue } : null;
    }
    case "url":
      return { url: String(value) };
    case "files":
      return {
        files: [
          {
            name: fallbackName,
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
    case "checkbox": {
      const checkboxValue = typeof value === "boolean" ? value : parseBooleanValue(String(value));
      return checkboxValue === null ? null : { checkbox: checkboxValue };
    }
    case "multi_select":
      return {
        multi_select: String(value)
          .split(/[,，]/)
          .map((item) => item.trim())
          .filter(Boolean)
          .map((name) => ({ name }))
      };
    case "relation": {
      const pageIds = parseCustomRelationValue(String(value));
      return pageIds.length > 0 ? { relation: pageIds.map((id) => ({ id })) } : null;
    }
    case "rich_text":
      return { rich_text: [{ text: { content: String(value) } }] };
    default:
      return null;
  }
}

function getBookEntryValue(
  mapping: FieldMappingEntry<SyncField>,
  book: WeReadBook
): string | number | boolean | undefined {
  if (mapping.sourceType === "custom") {
    return mapping.customValue;
  }
  if (!mapping.sourceField) {
    return undefined;
  }
  return getBookFieldValue(mapping.sourceField, book);
}

function getHighlightEntryValue(
  mapping: FieldMappingEntry<HighlightSyncField>,
  book: WeReadNotebookBook,
  notes: WeReadHighlightNote[]
): string | number | boolean | undefined {
  if (mapping.sourceType === "custom") {
    return mapping.customValue;
  }

  switch (mapping.sourceField) {
    case "cover":
      return book.cover;
    case "author":
      return book.author;
    case "url":
      return book.url;
    case "bookId":
      return book.bookId;
    case "noteCount":
      return notes.length;
    case "bookmarkCount":
      return notes.filter((note) => note.original).length;
    case "reviewCount":
      return notes.filter((note) => note.thought).length;
    case "lastSyncedAt":
      return new Date().toISOString();
    default:
      return undefined;
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

function getBookIdMapping(settings: ExtensionSettings): FieldMappingEntry<SyncField> | null {
  return settings.fieldMappings.find((entry) => entry.sourceType === "field" && entry.sourceField === "wereadId") ?? null;
}

function getHighlightBookIdMapping(settings: ExtensionSettings): FieldMappingEntry<HighlightSyncField> | null {
  return (
    settings.highlightFieldMappings.find((entry) => entry.sourceType === "field" && entry.sourceField === "bookId") ?? null
  );
}

function buildEqualsFilter(property: DatabaseProperty, value: string): Record<string, unknown> {
  switch (property.type) {
    case "select":
      return { property: property.name, select: { equals: value } };
    case "status":
      return { property: property.name, status: { equals: value } };
    case "title":
      return { property: property.name, title: { equals: value } };
    default:
      return { property: property.name, rich_text: { equals: value } };
  }
}

function parseBooleanValue(value: string): boolean | null {
  const normalized = value.trim().toLowerCase();
  if (["true", "yes", "y", "1", "是", "对"].includes(normalized)) {
    return true;
  }
  if (["false", "no", "n", "0", "否", "不"].includes(normalized)) {
    return false;
  }
  return null;
}

function parseCustomRelationValue(value: string): string[] {
  const trimmed = value.trim();
  if (!trimmed) {
    return [];
  }

  try {
    const parsed = JSON.parse(trimmed) as unknown;
    if (Array.isArray(parsed)) {
      return parsed
        .map((item) => {
          if (typeof item === "string") {
            return item;
          }
          if (item && typeof item === "object" && typeof (item as { id?: unknown }).id === "string") {
            return (item as { id: string }).id;
          }
          return "";
        })
        .filter(Boolean);
    }
  } catch {
    // Legacy/custom text values fall back to comma separated page ids.
  }

  return trimmed
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function getPropertyOptions(value: NotionDatabasePropertyResponse): NotionOptionResponse[] | undefined {
  switch (value.type) {
    case "select":
      return value.select?.options;
    case "status":
      return value.status?.options;
    case "multi_select":
      return value.multi_select?.options;
    default:
      return undefined;
  }
}

function getPageTitle(property: NotionPagePropertyResponse | undefined): string {
  return (
    property?.title
      ?.map((item) => item.plain_text ?? item.text?.content ?? "")
      .join("")
      .trim() ?? ""
  );
}

function mapDatabaseProperties(properties: NotionDatabaseResponse["properties"]): DatabaseProperty[] {
  return Object.entries(properties).map(([name, value]) => ({
    id: value.id,
    name,
    type: value.type ?? "unknown",
    options: getPropertyOptions(value),
    relationDatabaseId: value.type === "relation" ? value.relation?.database_id : undefined
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

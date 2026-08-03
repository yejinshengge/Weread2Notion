import {
  getBookAllowedTypes,
  isBookEntryCompatible
} from "../shared/fields";
import type {
  DatabaseProperty,
  DatabasePropertyOption,
  ExtensionSettings,
  FieldMappingEntry,
  FieldMapping,
  NotionPageSearchResult,
  NotionPropertyType,
  SyncProgress,
  SyncField,
  SyncSummary,
  WeReadBook,
  WeReadHighlightNote
} from "../shared/types";

const NOTION_VERSION = "2025-09-03";
const NOTION_API_BASE = "https://api.notion.com/v1";

interface NotionDatabaseResponse {
  id: string;
  data_sources?: Array<{ id: string; name?: string }>;
}

interface NotionDataSourceResponse {
  id: string;
  properties: Record<string, NotionDatabasePropertyResponse>;
}

interface NotionQueryResponse {
  results: Array<{ id: string; properties?: Record<string, NotionPagePropertyResponse> }>;
  has_more?: boolean;
  next_cursor?: string | null;
}

interface NotionBlockResponse {
  id: string;
  type?: string;
  toggle?: {
    rich_text?: Array<{ plain_text?: string; text?: { content?: string } }>;
  };
  heading_1?: {
    rich_text?: Array<{ plain_text?: string; text?: { content?: string } }>;
  };
}

interface NotionBlockChildrenResponse {
  results: NotionBlockResponse[];
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
  status?: {
    options?: NotionOptionResponse[];
    groups?: NotionStatusGroupResponse[];
  };
  multi_select?: { options?: NotionOptionResponse[] };
  relation?: { database_id?: string; data_source_id?: string };
}

interface NotionOptionResponse {
  id: string;
  name: string;
  color?: string;
}

interface NotionStatusGroupResponse {
  id: string;
  name: string;
  color?: string;
  option_ids?: string[];
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
  dataSourceId: string;
  properties: DatabaseProperty[];
}

interface SyncBooksOptions {
  onProgress?: (progress: SyncProgress) => void | Promise<void>;
  getHighlights?: (book: WeReadBook) => Promise<WeReadHighlightNote[]>;
}

interface HighlightWriteProgress {
  total: number;
  completed: number;
  currentHighlight?: string;
}

type HighlightProgressHandler = (progress: HighlightWriteProgress) => void | Promise<void>;

type ReadingStatusOptionIds = Map<string, Partial<Record<WeReadBook["status"], string>>>;

const HIGHLIGHTS_TITLE = "微信读书划线与想法";
const LEGACY_MANAGED_HIGHLIGHTS_TITLE = "微信读书划线与想法（由 WeRead to Notion 管理）";

export async function validateDatabase(token: string, databaseIdOrUrl: string): Promise<DatabaseValidationResult> {
  const databaseId = extractDatabaseId(databaseIdOrUrl);
  const database = await notionRequest<NotionDatabaseResponse>(token, `/databases/${databaseId}`, {
    method: "GET"
  });
  const dataSourceId = database.data_sources?.[0]?.id;
  if (!dataSourceId) {
    throw new Error("目标 Notion 数据库没有可用的数据源");
  }
  const dataSource = await notionRequest<NotionDataSourceResponse>(token, `/data_sources/${dataSourceId}`, {
    method: "GET"
  });
  const properties = mapDatabaseProperties(dataSource.properties);
  const titleProperty = getTitleProperty(properties);

  if (!titleProperty) {
    throw new Error("目标数据库必须包含 title 类型字段");
  }

  return {
    databaseId: database.id,
    dataSourceId: dataSource.id,
    properties
  };
}

export async function searchDatabasePages(
  token: string,
  dataSourceId: string,
  query: string
): Promise<NotionPageSearchResult[]> {
  const dataSource = await notionRequest<NotionDataSourceResponse>(token, `/data_sources/${dataSourceId}`, {
    method: "GET"
  });
  const titleProperty = Object.entries(dataSource.properties).find(([, property]) => property.type === "title");
  if (!titleProperty) {
    return [];
  }

  const [titlePropertyName] = titleProperty;
  const trimmedQuery = query.trim();
  const response = await notionRequest<NotionQueryResponse>(token, `/data_sources/${dataSourceId}/query`, {
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
  const summary: SyncSummary = {
    created: 0,
    updated: 0,
    skipped: 0,
    failed: [] as Array<{ title: string; reason: string }>
  };

  let completed = 0;
  let highlightCompleted = 0;
  await publishProgress(
    options,
    books.length,
    completed,
    summary,
    "正在准备同步 Notion...",
    { total: 0, completed: 0 },
    "preparing"
  );

  const syncContext = await prepareSyncContext(settings);
  const liveSettings = syncContext.settings;
  const highlightsByBook = new Map<string, WeReadHighlightNote[]>();
  const highlightErrors = new Map<string, string>();
  let highlightTotal = 0;

  for (const book of books) {
    await publishProgress(
      options,
      books.length,
      completed,
      summary,
      `正在读取划线：${book.title}`,
      { total: 0, completed: 0 },
      "readingHighlights"
    );
    try {
      const notes = options.getHighlights ? await options.getHighlights(book) : [];
      highlightsByBook.set(book.bookId, notes);
      highlightTotal += notes.length;
    } catch (error) {
      const message = getErrorMessage(error);
      highlightErrors.set(book.bookId, message);
      highlightsByBook.set(book.bookId, []);
      summary.failed.push({ title: book.title, reason: message });
      await publishProgress(
        options,
        books.length,
        completed,
        summary,
        `读取划线失败：${book.title}`,
        { total: 0, completed: 0 },
        "readingHighlights"
      );
    }
  }

  await publishProgress(
    options,
    books.length,
    completed,
    summary,
    "正在开始写入 Notion...",
    { total: highlightTotal, completed: highlightCompleted },
    "writing"
  );

  for (const book of books) {
    const notes = highlightsByBook.get(book.bookId) ?? [];
    const highlightStart = highlightCompleted;
    let highlightProgress: HighlightWriteProgress = {
      total: highlightTotal,
      completed: highlightCompleted
    };

    const reportHighlightProgress: HighlightProgressHandler = async (progress) => {
      highlightCompleted = highlightStart + progress.completed;
      highlightProgress = {
        total: highlightTotal,
        completed: highlightCompleted,
        currentHighlight: progress.currentHighlight
      };
      await publishProgress(
        options,
        books.length,
        completed,
        summary,
        `正在写入 Notion：${book.title}`,
        highlightProgress,
        "writing"
      );
    };

    await publishProgress(
      options,
      books.length,
      completed,
      summary,
      `正在写入 Notion：${book.title}`,
      highlightProgress,
      "writing"
    );

    const highlightError = highlightErrors.get(book.bookId);
    if (highlightError) {
      completed += 1;
      await publishProgress(options, books.length, completed, summary, undefined, highlightProgress, "writing");
      continue;
    }

    let bookWriteSucceeded = true;
    try {
      const existingPageId = await findExistingPage(liveSettings, book);

      if (existingPageId) {
        const payload = buildPagePayload(
          liveSettings,
          book,
          syncContext.statusOptionIds,
          { existingPage: true }
        );
        let pageChanged = false;
        if (hasPagePayloadChanges(payload)) {
          await notionRequest(liveSettings.notionToken, `/pages/${existingPageId}`, {
            method: "PATCH",
            body: JSON.stringify(payload)
          });
          pageChanged = true;
        }
        const highlightsChanged = await replaceManagedHighlights(
          liveSettings.notionToken,
          existingPageId,
          book,
          notes,
          reportHighlightProgress
        );
        if (pageChanged || highlightsChanged) {
          summary.updated += 1;
        } else {
          summary.skipped += 1;
        }
      } else {
        const payload = buildPagePayload(liveSettings, book, syncContext.statusOptionIds);
        const createdPage = await notionRequest<NotionPageResponse>(liveSettings.notionToken, "/pages", {
          method: "POST",
          body: JSON.stringify({
            parent: { type: "data_source_id", data_source_id: liveSettings.dataSourceId },
            ...payload
          })
        });
        if (notes.length > 0) {
          await appendManagedHighlights(
            liveSettings.notionToken,
            createdPage.id,
            book,
            notes,
            reportHighlightProgress
          );
        }
        summary.created += 1;
      }
    } catch (error) {
      bookWriteSucceeded = false;
      summary.failed.push({ title: book.title, reason: getErrorMessage(error) });
    }
    completed += 1;
    highlightCompleted = bookWriteSucceeded ? highlightStart + notes.length : highlightProgress.completed;
    highlightProgress = { total: highlightTotal, completed: highlightCompleted };
    await publishProgress(options, books.length, completed, summary, undefined, highlightProgress, "writing");
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

async function prepareSyncContext(settings: ExtensionSettings): Promise<{
  settings: ExtensionSettings;
  statusOptionIds: ReadingStatusOptionIds;
}> {
  if (!settings.notionToken || !settings.dataSourceId) {
    throw new Error("请先重新验证 Notion 数据库");
  }

  const dataSource = await notionRequest<NotionDataSourceResponse>(
    settings.notionToken,
    `/data_sources/${settings.dataSourceId}`,
    { method: "GET" }
  );
  let liveSettings: ExtensionSettings = {
    ...settings,
    databaseProperties: mapDatabaseProperties(dataSource.properties)
  };
  ensureSyncSettings(liveSettings);

  const preparedStatuses = await prepareReadingStatusOptions(liveSettings);
  liveSettings = {
    ...liveSettings,
    databaseProperties: preparedStatuses.properties
  };

  return {
    settings: liveSettings,
    statusOptionIds: preparedStatuses.optionIds
  };
}

async function prepareReadingStatusOptions(settings: ExtensionSettings): Promise<{
  properties: DatabaseProperty[];
  optionIds: ReadingStatusOptionIds;
}> {
  const statusPropertyNames = [
    ...new Set(
      settings.fieldMappings
        .filter(
          (mapping) =>
            mapping.sourceType === "field" &&
            mapping.sourceField === "status" &&
            Boolean(mapping.propertyName)
        )
        .map((mapping) => mapping.propertyName)
    )
  ];
  const properties = settings.databaseProperties;
  const optionIds: ReadingStatusOptionIds = new Map();

  for (const propertyName of statusPropertyNames) {
    const property = properties.find((item) => item.name === propertyName);
    if (!property || property.type !== "status") {
      continue;
    }

    optionIds.set(property.name, resolveReadingStatusOptionIds(property));
  }

  return { properties, optionIds };
}

function resolveReadingStatusOptionIds(
  property: DatabaseProperty
): Partial<Record<WeReadBook["status"], string>> {
  const statuses: WeReadBook["status"][] = ["未开始", "阅读中", "已读完"];
  const optionIds: Partial<Record<WeReadBook["status"], string>> = {};

  statuses.forEach((status, index) => {
    const option = getStatusGroupOption(property, index);
    if (option) {
      optionIds[status] = option.id;
    }
  });

  return optionIds;
}

function getStatusGroupOption(
  property: DatabaseProperty,
  groupIndex: number
): DatabasePropertyOption | undefined {
  const optionId = property.statusGroups?.[groupIndex]?.optionIds[0];
  return optionId ? property.options?.find((option) => option.id === optionId) : undefined;
}

function ensureSyncSettings(settings: ExtensionSettings): void {
  if (!settings.notionToken || !settings.databaseId || !settings.dataSourceId) {
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

  const response = await notionRequest<NotionQueryResponse>(
    settings.notionToken,
    `/data_sources/${settings.dataSourceId}/query`,
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
  statusOptionIds: ReadingStatusOptionIds,
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
    const propertyValue =
      mappedProperty.type === "status" && mapping.sourceType === "field" && mapping.sourceField === "status"
        ? buildReadingStatusPropertyValue(mappedProperty, book, statusOptionIds)
        : buildBookPropertyValue(mapping, mappedProperty.type, book);
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

async function replaceManagedHighlights(
  token: string,
  pageId: string,
  book: WeReadBook,
  notes: WeReadHighlightNote[],
  onProgress?: HighlightProgressHandler
): Promise<boolean> {
  const existingChildren = await listPageChildren(token, pageId);
  const managedBlocks = findManagedHighlightsBlocks(existingChildren);

  for (const block of managedBlocks) {
    await notionRequest(token, `/blocks/${block.id}`, {
      method: "PATCH",
      body: JSON.stringify({ archived: true })
    });
  }

  if (notes.length === 0) {
    return managedBlocks.length > 0;
  }

  await appendManagedHighlights(token, pageId, book, notes, onProgress);
  return true;
}

async function appendManagedHighlights(
  token: string,
  pageId: string,
  book: WeReadBook,
  notes: WeReadHighlightNote[],
  onProgress?: HighlightProgressHandler
): Promise<void> {
  await appendPageChildren(token, pageId, [
    headingOneBlock(HIGHLIGHTS_TITLE),
    paragraphBlock(`作者：${book.author || "未知"} · 划线 ${notes.filter((note) => note.original).length} · 想法 ${notes.filter((note) => note.thought).length}`),
    paragraphBlock(`微信读书：${book.url}`),
    dividerBlock()
  ]);

  let currentChapter = "";
  for (let index = 0; index < notes.length; index += 1) {
    const note = notes[index];
    await onProgress?.({
      total: notes.length,
      completed: index,
      currentHighlight: getHighlightProgressText(note)
    });

    const chapterTitle = note.chapterTitle || "未分章节";
    const children: NotionBlock[] = [];
    if (chapterTitle !== currentChapter) {
      currentChapter = chapterTitle;
      children.push(headingBlock(chapterTitle));
    }
    children.push(...buildNoteBlocks(note), dividerBlock());
    await appendPageChildren(token, pageId, children);

    await onProgress?.({
      total: notes.length,
      completed: index + 1
    });
  }
}

function getHighlightProgressText(note: WeReadHighlightNote): string {
  const content = note.original?.trim() || note.thought?.trim() || "无文本内容";
  return truncateText(content.replace(/\s+/g, " "), 120);
}

function headingOneBlock(content: string): NotionBlock {
  return {
    object: "block",
    type: "heading_1",
    heading_1: {
      rich_text: [{ type: "text", text: { content } }],
      color: "default",
      is_toggleable: false
    }
  };
}

function findManagedHighlightsBlocks(blocks: NotionBlockResponse[]): NotionBlockResponse[] {
  const managedBlocks = new Map<string, NotionBlockResponse>();

  for (const block of blocks) {
    if (block.type === "toggle" && getBlockRichText(block.toggle?.rich_text) === LEGACY_MANAGED_HIGHLIGHTS_TITLE) {
      managedBlocks.set(block.id, block);
    }
  }

  for (let index = 0; index < blocks.length; index += 1) {
    const block = blocks[index];
    if (block.type !== "heading_1" || getBlockRichText(block.heading_1?.rich_text) !== HIGHLIGHTS_TITLE) {
      continue;
    }
    managedBlocks.set(block.id, block);
    for (let childIndex = index + 1; childIndex < blocks.length; childIndex += 1) {
      const child = blocks[childIndex];
      if (child.type === "heading_1") {
        break;
      }
      managedBlocks.set(child.id, child);
    }
  }

  return [...managedBlocks.values()];
}

function getBlockRichText(
  richText: Array<{ plain_text?: string; text?: { content?: string } }> | undefined
): string {
  return richText?.map((item) => item.plain_text ?? item.text?.content ?? "").join("") ?? "";
}

async function appendPageChildren(
  token: string,
  pageId: string,
  children: NotionBlock[],
): Promise<void> {
  for (let index = 0; index < children.length; index += NOTION_CHILDREN_BATCH_SIZE) {
    await notionRequest(token, `/blocks/${pageId}/children`, {
      method: "PATCH",
      body: JSON.stringify({ children: children.slice(index, index + NOTION_CHILDREN_BATCH_SIZE) })
    });
  }
}

async function listPageChildren(token: string, pageId: string): Promise<NotionBlockResponse[]> {
  const children: NotionBlockResponse[] = [];
  let startCursor: string | undefined;

  do {
    const query = new URLSearchParams({ page_size: "100" });
    if (startCursor) {
      query.set("start_cursor", startCursor);
    }
    const response = await notionRequest<NotionBlockChildrenResponse>(
      token,
      `/blocks/${pageId}/children?${query.toString()}`,
      {
        method: "GET"
      }
    );
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

function buildReadingStatusPropertyValue(
  property: DatabaseProperty,
  book: WeReadBook,
  statusOptionIds: ReadingStatusOptionIds
): NotionPropertyValue | null {
  const optionId = statusOptionIds.get(property.name)?.[book.status];
  return optionId ? { status: { id: optionId } } : null;
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

function mapDatabaseProperties(properties: NotionDataSourceResponse["properties"]): DatabaseProperty[] {
  return Object.entries(properties).map(([name, value]) => ({
    id: value.id,
    name,
    type: value.type ?? "unknown",
    options: getPropertyOptions(value),
    statusGroups:
      value.type === "status"
        ? value.status?.groups?.map((group) => ({
            id: group.id,
            name: group.name,
            optionIds: group.option_ids ?? [],
            color: group.color
          }))
        : undefined,
    relationDatabaseId:
      value.type === "relation" ? value.relation?.data_source_id ?? value.relation?.database_id : undefined
  }));
}

async function publishProgress(
  options: SyncBooksOptions,
  total: number,
  completed: number,
  summary: SyncSummary,
  currentTitle?: string,
  highlightProgress?: HighlightWriteProgress,
  stage?: SyncProgress["stage"]
): Promise<void> {
  await options.onProgress?.({
    total,
    completed,
    currentTitle,
    stage,
    highlightTotal: highlightProgress?.total,
    highlightCompleted: highlightProgress?.completed,
    currentHighlight: highlightProgress?.currentHighlight,
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

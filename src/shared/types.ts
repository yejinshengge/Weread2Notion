export type ReadingStatus = "未开始" | "阅读中" | "已读完";

export interface WeReadBook {
  bookId: string;
  title: string;
  cover?: string;
  progress: number;
  author?: string;
  category?: string;
  url: string;
  status: ReadingStatus;
  startReadAt?: string;
  lastReadAt?: string;
}

export interface WeReadNotebookBook {
  bookId: string;
  title: string;
  author?: string;
  cover?: string;
  url: string;
  noteCount: number;
  bookmarkCount: number;
  reviewCount: number;
  sort?: number;
}

export type HighlightNoteType = "bookmark" | "review";

export interface WeReadHighlightNote {
  id: string;
  bookId: string;
  type: HighlightNoteType;
  chapterUid?: string;
  chapterIdx?: number;
  chapterTitle?: string;
  original: string;
  thought?: string;
  userName?: string;
  userVid?: string;
  range?: string;
  createTime?: number;
  createdAt?: string;
}

export type SyncField =
  | "cover"
  | "progress"
  | "author"
  | "url"
  | "status"
  | "startReadAt"
  | "lastReadAt"
  | "wereadId";

export type NotionPropertyType =
  | "title"
  | "rich_text"
  | "number"
  | "url"
  | "files"
  | "select"
  | "status"
  | "checkbox"
  | "date"
  | "multi_select"
  | "people"
  | "email"
  | "phone_number"
  | "formula"
  | "relation"
  | "rollup"
  | "created_time"
  | "created_by"
  | "last_edited_time"
  | "last_edited_by"
  | "unique_id"
  | "unknown";

export interface DatabasePropertyOption {
  id: string;
  name: string;
  color?: string;
}

export interface DatabaseStatusGroup {
  id: string;
  name: string;
  optionIds: string[];
  color?: string;
}

export interface DatabaseProperty {
  id: string;
  name: string;
  type: NotionPropertyType;
  options?: DatabasePropertyOption[];
  statusGroups?: DatabaseStatusGroup[];
  relationDatabaseId?: string;
}

export interface FieldMapping {
  enabled: boolean;
  propertyName: string;
  overwriteOnUpdate: boolean;
}

export type FieldMappings = Record<SyncField, FieldMapping>;

export interface FieldMappingEntry<TSource extends string = string> {
  id: string;
  propertyName: string;
  sourceType: "field" | "custom";
  sourceField: TSource | "";
  customValue: string;
  overwriteOnUpdate: boolean;
}

export interface ExtensionSettings {
  wereadApiKey: string;
  notionToken: string;
  databaseId: string;
  dataSourceId: string;
  databaseUrl: string;
  fieldMappings: Array<FieldMappingEntry<SyncField>>;
  mappings: FieldMappings;
  useNotionCover: boolean;
  databaseProperties: DatabaseProperty[];
  lastValidatedAt?: string;
}

export interface SyncSummary {
  created: number;
  updated: number;
  skipped: number;
  failed: Array<{ title: string; reason: string }>;
}

export interface SyncProgress {
  total: number;
  completed: number;
  currentTitle?: string;
  stage?: "preparing" | "readingHighlights" | "writing";
  highlightTotal?: number;
  highlightCompleted?: number;
  currentHighlight?: string;
  summary: SyncSummary;
}

export interface CachedBookList {
  books: WeReadBook[];
  selectedIds: string[];
  fetchedAt: string;
}

export interface NotionPageSearchResult {
  id: string;
  title: string;
}

export type BackgroundRequest =
  | { type: "FETCH_WEREAD_BOOKS" }
  | { type: "VALIDATE_NOTION"; token: string; databaseIdOrUrl: string }
  | { type: "SEARCH_NOTION_PAGES"; databaseId: string; query: string }
  | { type: "SYNC_BOOKS"; books: WeReadBook[] };

export type BackgroundResponse<T> =
  | { ok: true; data: T }
  | { ok: false; error: string };

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

export interface DatabaseProperty {
  id: string;
  name: string;
  type: NotionPropertyType;
}

export interface FieldMapping {
  enabled: boolean;
  propertyName: string;
  overwriteOnUpdate: boolean;
}

export type FieldMappings = Record<SyncField, FieldMapping>;

export interface ExtensionSettings {
  notionToken: string;
  databaseId: string;
  databaseUrl: string;
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
  summary: SyncSummary;
}

export interface CachedBookList {
  books: WeReadBook[];
  selectedIds: string[];
  fetchedAt: string;
}

export type BackgroundRequest =
  | { type: "FETCH_WEREAD_BOOKS" }
  | { type: "VALIDATE_NOTION"; token: string; databaseIdOrUrl: string }
  | { type: "SYNC_BOOKS"; books: WeReadBook[] };

export type BackgroundResponse<T> =
  | { ok: true; data: T }
  | { ok: false; error: string };

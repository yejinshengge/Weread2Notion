import type {
  FieldMappingEntry,
  FieldMappings,
  NotionPropertyType,
  SyncField
} from "./types";

export const FIELD_LABELS: Record<SyncField, string> = {
  cover: "封面",
  progress: "阅读进度",
  author: "作者",
  url: "URL",
  status: "阅读状态",
  startReadAt: "开始阅读时间",
  lastReadAt: "最近阅读时间",
  wereadId: "WeRead ID"
};

export const SYNC_FIELDS: SyncField[] = [
  "cover",
  "progress",
  "author",
  "url",
  "status",
  "startReadAt",
  "lastReadAt",
  "wereadId"
];

export const DEFAULT_MAPPINGS: FieldMappings = {
  cover: { enabled: false, propertyName: "", overwriteOnUpdate: false },
  progress: { enabled: false, propertyName: "", overwriteOnUpdate: false },
  author: { enabled: false, propertyName: "", overwriteOnUpdate: false },
  url: { enabled: false, propertyName: "", overwriteOnUpdate: false },
  status: { enabled: false, propertyName: "", overwriteOnUpdate: false },
  startReadAt: { enabled: false, propertyName: "", overwriteOnUpdate: false },
  lastReadAt: { enabled: false, propertyName: "", overwriteOnUpdate: false },
  wereadId: { enabled: true, propertyName: "WeRead ID", overwriteOnUpdate: false }
};

export const DEFAULT_FIELD_MAPPINGS: Array<FieldMappingEntry<SyncField>> = [];

export const WRITABLE_PROPERTY_TYPES: NotionPropertyType[] = [
  "rich_text",
  "number",
  "url",
  "files",
  "select",
  "status",
  "checkbox",
  "date",
  "multi_select",
  "relation"
];

export function getAllowedTypes(field: SyncField): NotionPropertyType[] {
  return getBookAllowedTypes(field);
}

export function getBookAllowedTypes(field: SyncField): NotionPropertyType[] {
  switch (field) {
    case "progress":
      return ["number"];
    case "cover":
      return ["url", "files"];
    case "url":
      return ["url", "rich_text"];
    case "status":
      return ["select", "status", "rich_text"];
    case "startReadAt":
    case "lastReadAt":
      return ["date", "rich_text"];
    case "author":
    case "wereadId":
      return ["rich_text", "select"];
  }
}

export function isCompatibleProperty(field: SyncField, propertyType: NotionPropertyType): boolean {
  return getBookAllowedTypes(field).includes(propertyType);
}

export function getCustomAllowedTypes(): NotionPropertyType[] {
  return WRITABLE_PROPERTY_TYPES;
}

export function isWritablePropertyType(type: NotionPropertyType): boolean {
  return WRITABLE_PROPERTY_TYPES.includes(type);
}

export function isBookEntryCompatible(
  entry: FieldMappingEntry<SyncField>,
  propertyType: NotionPropertyType
): boolean {
  if (entry.sourceType === "custom") {
    return isWritablePropertyType(propertyType);
  }
  return Boolean(entry.sourceField && getBookAllowedTypes(entry.sourceField).includes(propertyType));
}

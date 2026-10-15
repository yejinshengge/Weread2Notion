import { SYNC_FIELDS } from "./fields";
import type {
  DatabaseProperty,
  ExtensionSettings,
  FieldMappingEntry,
  FieldMappings,
  NotionPropertyType,
  SyncField
} from "./types";

const BACKUP_FORMAT = "weread2notion-settings";
const BACKUP_VERSION = 1;
export const MAX_SETTINGS_BACKUP_SIZE = 5 * 1024 * 1024;

const PROPERTY_TYPES = {
  title: true, rich_text: true, number: true, url: true, files: true,
  select: true, status: true, checkbox: true, date: true, multi_select: true,
  people: true, email: true, phone_number: true, formula: true, relation: true,
  rollup: true, created_time: true, created_by: true, last_edited_time: true,
  last_edited_by: true, unique_id: true, unknown: true
} satisfies Record<NotionPropertyType, true>;

export function serializeSettingsBackup(settings: ExtensionSettings, now = new Date()): string {
  const text = JSON.stringify({
    format: BACKUP_FORMAT,
    version: BACKUP_VERSION,
    exportedAt: now.toISOString(),
    settings: readSettings(settings)
  }, null, 2) + "\n";
  checkSize(text);
  return text;
}

export function parseSettingsBackup(text: string): ExtensionSettings {
  checkSize(text);
  let value: unknown;
  try {
    value = JSON.parse(text.replace(/^\uFEFF/, ""));
  } catch {
    throw new Error("配置文件不是有效的 JSON，请选择本扩展导出的配置文件。");
  }
  const backup = readObject(value, "文件");
  if (backup.format !== BACKUP_FORMAT) {
    throw new Error("无法识别配置文件，请选择本扩展导出的配置文件。");
  }
  if (backup.version !== BACKUP_VERSION) {
    throw new Error("不支持此配置文件版本，请使用兼容版本的扩展导入。");
  }
  readDate(backup.exportedAt, "exportedAt");
  return readSettings(backup.settings);
}

function readSettings(value: unknown): ExtensionSettings {
  const settings = readObject(value, "settings");
  const mappings = readObject(settings.mappings, "mappings");
  const fieldMappings = readArray(settings.fieldMappings, "fieldMappings").map(readFieldMapping);
  const ids = fieldMappings.map((entry) => entry.id);
  if (new Set(ids).size !== ids.length) {
    throw new Error("配置文件中的字段条目 ID 重复，请重新导出配置。");
  }
  return {
    wereadApiKey: readString(settings.wereadApiKey, "wereadApiKey").trim(),
    notionToken: readString(settings.notionToken, "notionToken"),
    databaseId: readString(settings.databaseId, "databaseId"),
    dataSourceId: readString(settings.dataSourceId, "dataSourceId"),
    databaseUrl: readString(settings.databaseUrl, "databaseUrl"),
    fieldMappings,
    mappings: Object.fromEntries(SYNC_FIELDS.map((field) => {
      const mapping = readObject(mappings[field], `mappings.${field}`);
      return [field, {
        enabled: readBoolean(mapping.enabled, `mappings.${field}.enabled`),
        propertyName: readString(mapping.propertyName, `mappings.${field}.propertyName`),
        overwriteOnUpdate: readBoolean(mapping.overwriteOnUpdate, `mappings.${field}.overwriteOnUpdate`)
      }];
    })) as FieldMappings,
    useNotionCover: readBoolean(settings.useNotionCover, "useNotionCover"),
    databaseProperties: readArray(settings.databaseProperties, "databaseProperties").map(readProperty),
    ...(settings.lastValidatedAt === undefined ? {} : {
      lastValidatedAt: readDate(settings.lastValidatedAt, "lastValidatedAt")
    })
  };
}

function readFieldMapping(value: unknown, index: number): FieldMappingEntry<SyncField> {
  const path = `fieldMappings[${index}]`;
  const entry = readObject(value, path);
  const id = readString(entry.id, `${path}.id`);
  if (!id) throw invalidField(`${path}.id`);
  if (entry.sourceType !== "field" && entry.sourceType !== "custom") {
    throw invalidField(`${path}.sourceType`);
  }
  const sourceField = readString(entry.sourceField, `${path}.sourceField`);
  if (sourceField !== "" && !SYNC_FIELDS.includes(sourceField as SyncField)) {
    throw invalidField(`${path}.sourceField`);
  }
  if (entry.sourceType === "custom" && sourceField !== "") {
    throw invalidField(`${path}.sourceField`);
  }
  return {
    id,
    propertyName: readString(entry.propertyName, `${path}.propertyName`),
    sourceType: entry.sourceType,
    sourceField: sourceField as SyncField | "",
    customValue: readString(entry.customValue, `${path}.customValue`),
    overwriteOnUpdate: readBoolean(entry.overwriteOnUpdate, `${path}.overwriteOnUpdate`)
  };
}

function readProperty(value: unknown, index: number): DatabaseProperty {
  const path = `databaseProperties[${index}]`;
  const property = readObject(value, path);
  const type = readString(property.type, `${path}.type`);
  if (!Object.hasOwn(PROPERTY_TYPES, type)) throw invalidField(`${path}.type`);
  return {
    id: readString(property.id, `${path}.id`),
    name: readString(property.name, `${path}.name`),
    type: type as NotionPropertyType,
    ...(property.options === undefined ? {} : {
      options: readArray(property.options, `${path}.options`).map((value, index) => {
        const optionPath = `${path}.options[${index}]`;
        const option = readObject(value, optionPath);
        return {
          id: readString(option.id, `${optionPath}.id`),
          name: readString(option.name, `${optionPath}.name`),
          ...readColor(option, optionPath)
        };
      })
    }),
    ...(property.statusGroups === undefined ? {} : {
      statusGroups: readArray(property.statusGroups, `${path}.statusGroups`).map((value, index) => {
        const groupPath = `${path}.statusGroups[${index}]`;
        const group = readObject(value, groupPath);
        return {
          id: readString(group.id, `${groupPath}.id`),
          name: readString(group.name, `${groupPath}.name`),
          optionIds: readArray(group.optionIds, `${groupPath}.optionIds`)
            .map((id) => readString(id, `${groupPath}.optionIds`)),
          ...readColor(group, groupPath)
        };
      })
    }),
    ...(property.relationDatabaseId === undefined ? {} : {
      relationDatabaseId: readString(property.relationDatabaseId, `${path}.relationDatabaseId`)
    })
  };
}

function readColor(value: Record<string, unknown>, path: string): { color?: string } {
  return value.color === undefined ? {} : { color: readString(value.color, `${path}.color`) };
}

function readObject(value: unknown, path: string): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw invalidField(path);
  return value as Record<string, unknown>;
}

function readArray(value: unknown, path: string): unknown[] {
  if (!Array.isArray(value)) throw invalidField(path);
  return value;
}

function readString(value: unknown, path: string): string {
  if (typeof value !== "string") throw invalidField(path);
  return value;
}

function readBoolean(value: unknown, path: string): boolean {
  if (typeof value !== "boolean") throw invalidField(path);
  return value;
}

function readDate(value: unknown, path: string): string {
  const date = readString(value, path);
  if (!Number.isFinite(Date.parse(date))) throw invalidField(path);
  return date;
}

function invalidField(path: string): Error {
  return new Error(`配置文件中的 ${path} 缺失或格式错误，请重新导出配置。`);
}

function checkSize(text: string): void {
  if (new TextEncoder().encode(text).byteLength > MAX_SETTINGS_BACKUP_SIZE) {
    throw new Error("配置文件过大，请选择不超过 5 MB 的配置文件。");
  }
}

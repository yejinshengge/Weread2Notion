import test from "node:test";
import assert from "node:assert/strict";
import { build } from "esbuild";

const bundled = await build({
  entryPoints: ["src/shared/settingsBackup.ts"], bundle: true, write: false, format: "esm", platform: "node"
});
const { serializeSettingsBackup, parseSettingsBackup, MAX_SETTINGS_BACKUP_SIZE } = await import(
  `data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString("base64")}`
);
const storageBundle = await build({
  entryPoints: ["src/storage.ts"], bundle: true, write: false, format: "esm", platform: "node"
});
const { defaultSettings, getSettings, saveSettings } = await import(
  `data:text/javascript;base64,${Buffer.from(storageBundle.outputFiles[0].text).toString("base64")}`
);

const completeSettings = () => ({
  ...structuredClone(defaultSettings),
  wereadApiKey: "wrk-backup-test",
  notionToken: "ntn-backup-test",
  databaseId: "database-test",
  dataSourceId: "data-source-test",
  databaseUrl: "https://www.notion.so/database-test",
  useNotionCover: false,
  lastValidatedAt: "2026-10-15T00:30:00.000Z",
  fieldMappings: [
    { id: "id", propertyName: "WeRead ID", sourceType: "field", sourceField: "wereadId", customValue: "", overwriteOnUpdate: false },
    { id: "progress", propertyName: "进度", sourceType: "field", sourceField: "progress", customValue: "", overwriteOnUpdate: true },
    { id: "tag", propertyName: "标签", sourceType: "custom", sourceField: "", customValue: "阅读, 科学", overwriteOnUpdate: false },
    { id: "relation", propertyName: "关联", sourceType: "custom", sourceField: "", customValue: '[{"id":"page-id","title":"读书笔记"}]', overwriteOnUpdate: true }
  ],
  databaseProperties: [
    { id: "title", name: "书名", type: "title" },
    { id: "id", name: "WeRead ID", type: "rich_text" },
    { id: "progress", name: "进度", type: "number" },
    { id: "tag", name: "标签", type: "multi_select", options: [{ id: "opt", name: "科学", color: "green" }] },
    { id: "status", name: "状态", type: "status", options: [{ id: "reading", name: "阅读中" }], statusGroups: [{ id: "group", name: "进行中", color: "blue", optionIds: ["reading"] }] },
    { id: "relation", name: "关联", type: "relation", relationDatabaseId: "related-database" }
  ]
});

test("配置备份完整恢复密钥、字段映射、自定义内容、数据库字段与封面开关", () => {
  const settings = completeSettings();
  const before = structuredClone(settings);
  const text = serializeSettingsBackup(settings, new Date("2026-10-15T01:00:00.000Z"));
  const backup = JSON.parse(text);
  assert.equal(backup.version, 1);
  assert.equal(backup.exportedAt, "2026-10-15T01:00:00.000Z");
  assert.deepEqual(parseSettingsBackup(text), settings);
  assert.deepEqual(settings, before);
  assert.deepEqual(parseSettingsBackup(serializeSettingsBackup(defaultSettings)), defaultSettings);
  assert.deepEqual(parseSettingsBackup(`\uFEFF${text}`), settings);
});

test("拒绝损坏、无关或不兼容的文件，错误消息不会回显文件中的密钥", () => {
  for (const text of ["", '{"notionToken":"private-token",', "null", "[]", "{}", '{"settings":{}}']) {
    assert.throws(() => parseSettingsBackup(text), (error) => {
      assert.ok(!error.message.includes("private-token"));
      return true;
    });
  }
  const backup = JSON.parse(serializeSettingsBackup(completeSettings()));
  backup.version = 2;
  assert.throws(() => parseSettingsBackup(JSON.stringify(backup)), /版本/);
  backup.version = "1";
  assert.throws(() => parseSettingsBackup(JSON.stringify(backup)), /版本/);
  assert.throws(() => parseSettingsBackup(" ".repeat(MAX_SETTINGS_BACKUP_SIZE + 1)), /5 MB/);
});

test("拒绝会破坏界面或同步的字段类型、重复条目、缺失字段和无效时间", () => {
  const mutations = [
    (b) => { delete b.settings.notionToken; },
    (b) => { b.settings.wereadApiKey = 42; },
    (b) => { b.settings.useNotionCover = "false"; },
    (b) => { b.settings.fieldMappings = {}; },
    (b) => { b.settings.fieldMappings[1].sourceField = "unsupported"; },
    (b) => { b.settings.fieldMappings[1].overwriteOnUpdate = "true"; },
    (b) => { b.settings.fieldMappings[1].id = "id"; },
    (b) => { b.settings.fieldMappings[2].sourceField = "author"; },
    (b) => { b.settings.mappings.wereadId.enabled = null; },
    (b) => { b.settings.databaseProperties = null; },
    (b) => { b.settings.databaseProperties[0].type = "toString"; },
    (b) => { b.settings.databaseProperties[3].options[0].name = {}; },
    (b) => { b.settings.databaseProperties[4].statusGroups[0].optionIds = [42]; },
    (b) => { b.settings.lastValidatedAt = "invalid-date"; },
    (b) => { b.exportedAt = "invalid-date"; }
  ];
  for (const mutate of mutations) {
    const backup = JSON.parse(serializeSettingsBackup(completeSettings()));
    mutate(backup);
    assert.throws(() => parseSettingsBackup(JSON.stringify(backup)), /格式错误|重复/);
  }
});

test("导入只恢复配置白名单，不带入书架缓存和未知字段", () => {
  const backup = JSON.parse(serializeSettingsBackup(completeSettings()));
  backup.bookListCache = { books: ["unrelated"] };
  backup.settings.extra = "ignored";
  backup.settings.fieldMappings[0].extra = "ignored";
  backup.settings.databaseProperties[0].extra = "ignored";
  backup.settings.mappings.wereadId.extra = "ignored";
  assert.deepEqual(parseSettingsBackup(JSON.stringify(backup)), completeSettings());
});

test("导入配置经过现有存储后仍可完整读回，且保留书架缓存", async () => {
  const previousChrome = globalThis.chrome;
  const cache = { books: [{ bookId: "keep" }], selectedIds: ["keep"] };
  const stored = { settings: defaultSettings, bookListCache: cache };
  globalThis.chrome = { storage: { local: {
    async get(key) { return { [key]: structuredClone(stored[key]) }; },
    async set(values) { Object.assign(stored, structuredClone(values)); }
  } } };
  try {
    await saveSettings(parseSettingsBackup(serializeSettingsBackup(completeSettings())));
    assert.deepEqual(await getSettings(), completeSettings());
    assert.deepEqual(stored.bookListCache, cache);
  } finally {
    globalThis.chrome = previousChrome;
  }
});

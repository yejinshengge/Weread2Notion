import assert from "node:assert/strict";
import { build } from "esbuild";

const bundled = await build({ entryPoints: ["src/services/notion.ts"], bundle: true, write: false, format: "esm", platform: "node" });
const { syncBooksToNotion } = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString("base64")}`);
const settings = {
  notionToken: "test", databaseId: "db", dataSourceId: "ds", useNotionCover: false,
  fieldMappings: [{ propertyName: "ID", sourceType: "field", sourceField: "wereadId", overwriteOnUpdate: false }]
};
const book = { bookId: "book", title: "测试书", author: "作者", url: "https://weread.qq.com/book", status: "阅读中", progress: 10 };
const note = (i) => ({ id: String(i), bookId: "book", type: "bookmark", chapterTitle: "第一章", original: `划线 ${i}` });
let blocks = [], requests = [], nextId = 0, failAppend = false, rateLimit = false;
const response = (body, status = 200, headers) => new Response(JSON.stringify(body), { status, headers });
globalThis.fetch = async (url, init) => {
  const path = new URL(url).pathname;
  const body = init.body ? JSON.parse(init.body) : {};
  requests.push({ path, method: init.method, body, bytes: new TextEncoder().encode(init.body ?? "").length });
  if (path === "/v1/data_sources/ds") return response({ properties: { Name: { id: "title", type: "title" }, ID: { id: "id", type: "rich_text" } } });
  if (path.endsWith("/query")) return response({ results: [{ id: "page" }] });
  if (path.endsWith("/children")) {
    if (init.method === "GET") {
      const start = Number(new URL(url).searchParams.get("start_cursor") ?? 0);
      return response({ results: structuredClone(blocks.slice(start, start + 100)), has_more: start + 100 < blocks.length, next_cursor: String(start + 100) });
    }
    if (failAppend) { failAppend = false; return response({ message: "injected failure" }, 503); }
    if (rateLimit) { rateLimit = false; return response({ message: "rate limited" }, 429, { "Retry-After": "0.001" }); }
    assert.ok(body.children.length <= 100);
    assert.ok(new TextEncoder().encode(init.body).length < 500_000);
    const added = body.children.map((block) => ({ ...structuredClone(block), id: `block-${++nextId}` }));
    const anchor = body.after ? blocks.findIndex((block) => block.id === body.after) : blocks.length - 1;
    assert.ok(!body.after || anchor >= 0);
    blocks.splice(anchor + 1, 0, ...added);
    return response({ results: added });
  }
  const index = blocks.findIndex((block) => block.id === path.split("/").at(-1));
  assert.ok(index >= 0, path);
  if (body.archived) blocks.splice(index, 1);
  else Object.assign(blocks[index], structuredClone(body));
  return response({});
};
const sync = async (notes, succeeds = true) => {
  requests = [];
  const progress = [];
  const result = await syncBooksToNotion(settings, [book], { getHighlights: async () => notes, onProgress: (value) => { progress.push(value); } });
  assert.equal(result.failed.length, succeeds ? 0 : 1);
  if (succeeds) assert.equal(progress.at(-1).highlightCompleted, notes.length);
  return requests.filter((req) => req.method === "PATCH");
};
const content = () => blocks.map(({ id, ...block }) => block);
const expectedFor = async (notes) => {
  const saved = blocks;
  blocks = [];
  await sync(notes);
  const expected = content();
  blocks = saved;
  return expected;
};
let notes = Array.from({ length: 1000 }, (_, i) => note(i));
const firstWrites = await sync(notes);
assert.equal(firstWrites.length, 21); // 2005 blocks, batched by 100.
const oldIds = blocks.map((block) => block.id);
assert.equal((await sync(notes)).length, 0);
assert.deepEqual(blocks.map((block) => block.id), oldIds);
console.log("1000 highlights: initial 21 writes; unchanged repeat 0 writes (21 paginated reads)");

// New highlights stay inside the managed section, ahead of unrelated manual content.
const manual = { id: "manual", type: "heading_1", heading_1: { rich_text: [{ text: { content: "手工内容" } }] } };
blocks.push(manual);
notes = [...notes, note(1000)];
assert.equal((await sync(notes)).length, 2); // Count metadata + one batch.
assert.equal(blocks.at(-1).id, "manual");
assert.deepEqual(blocks.filter((block) => oldIds.includes(block.id)).map((block) => block.id), oldIds);
blocks.pop();
console.log("One new highlight: 2 writes; existing block IDs and following manual section preserved");

notes = notes.map((value, i) => i === 400 ? { ...value, original: "修改后的划线" } : value);
assert.equal((await sync(notes)).length, 1);
assert.deepEqual(content(), await expectedFor(notes));
notes.splice(250, 0, { ...note("insert"), thought: "新想法", chapterTitle: "新增章节" });
await sync(notes);
assert.deepEqual(content(), await expectedFor(notes));
notes.splice(700, 4);
await sync(notes);
assert.deepEqual(content(), await expectedFor(notes));
console.log("Editing, middle insertion, deletion and chapter transitions match a fresh rendering");

// Failed inserts can be reconciled on retry, without duplicate notes.
const extra = Array.from({ length: 150 }, (_, i) => note(`extra-${i}`));
notes = [...notes, ...extra];
failAppend = true;
await sync(notes, false);
rateLimit = true;
await sync(notes);
assert.deepEqual(content(), await expectedFor(notes));
assert.equal((await sync(notes)).length, 0);
console.log("Append failure recovery and 429 retry passed");

// Large CJK batches must respect byte limits, not just block counts.
blocks = [];
notes = Array.from({ length: 100 }, (_, i) => ({ ...note(i), original: "中".repeat(4000), thought: "文".repeat(4000) }));
await sync(notes);
assert.equal((await sync(notes)).length, 0);
await sync([]);
assert.equal(blocks.length, 0);
console.log("Large CJK payload batching and clearing highlights passed");

blocks = [{ id: "legacy", type: "toggle", toggle: { rich_text: [{ text: { content: "微信读书划线与想法（由 WeRead to Notion 管理）" } }] } }, manual];
failAppend = true;
await sync([note(1)], false);
assert.equal(blocks[0].id, "legacy");
await sync([note(1)]);
assert.ok(!blocks.some((block) => block.id === "legacy"));
assert.equal(blocks[0].id, "manual");
assert.equal((await sync([note(1)])).length, 0);
console.log("Legacy toggle migration preserves old content on failed writes");

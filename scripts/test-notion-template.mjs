import assert from "node:assert/strict";
import { build } from "esbuild";

const bundled = await build({ entryPoints: ["src/services/notion.ts"], bundle: true, write: false, format: "esm", platform: "node" });
const { syncBooksToNotion } = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString("base64")}`);

const settings = {
  notionToken: "test", databaseId: "db", dataSourceId: "ds", useNotionCover: false,
  fieldMappings: [{ propertyName: "ID", sourceType: "field", sourceField: "wereadId", overwriteOnUpdate: false }]
};
const book = { bookId: "book", title: "测试书", url: "https://weread.qq.com/book", status: "阅读中", progress: 10 };
const note = { id: "highlight", bookId: "book", type: "bookmark", original: "一条划线" };
const templateBlocks = [
  { id: "template-heading", type: "heading_1", heading_1: { rich_text: [{ text: { content: "模板区域" } }] } },
  { id: "template-paragraph", type: "paragraph", paragraph: { rich_text: [{ text: { content: "保留模板内容" } }] } }
];
const response = (body) => new Response(JSON.stringify(body), { status: 200 });

async function runCase({ hasDefault, hasNotes }) {
  const requests = [];
  let pageBlocks = [];
  let pageReads = 0;
  let nextBlockId = 0;

  globalThis.fetch = async (url, init) => {
    const parsedUrl = new URL(url);
    const path = parsedUrl.pathname;
    const body = init.body ? JSON.parse(init.body) : {};
    requests.push({ path, method: init.method, body });

    if (path === "/v1/data_sources/ds") {
      return response({ properties: { Name: { id: "title", type: "title" }, ID: { id: "id", type: "rich_text" } } });
    }
    if (path === "/v1/data_sources/ds/query") return response({ results: [] });
    if (path === "/v1/data_sources/ds/templates") {
      if (hasDefault && !parsedUrl.searchParams.has("start_cursor")) {
        return response({ templates: [{ id: "other", is_default: false }], has_more: true, next_cursor: "next" });
      }
      return response({ templates: hasDefault ? [{ id: "template", is_default: true }] : [], has_more: false });
    }
    if (path === "/v1/blocks/template/children") {
      return response({ results: structuredClone(templateBlocks), has_more: false });
    }
    if (path === "/v1/pages") return response({ id: "page" });
    if (path === "/v1/blocks/page/children" && init.method === "GET") {
      pageReads++;
      if (hasDefault && pageReads === 2) pageBlocks = structuredClone(templateBlocks);
      return response({ results: structuredClone(pageBlocks), has_more: false });
    }
    if (path === "/v1/blocks/page/children" && init.method === "PATCH") {
      assert.ok(!hasDefault || pageReads >= 2, "划线不能在模板内容出现前写入");
      const added = body.children.map((block) => ({ ...structuredClone(block), id: `new-${++nextBlockId}` }));
      pageBlocks.push(...added);
      return response({ results: added });
    }
    throw new Error(`Unexpected ${init.method} ${path}`);
  };

  const summary = await syncBooksToNotion(settings, [book], { getHighlights: async () => hasNotes ? [note] : [] });
  assert.deepEqual(summary, { created: 1, updated: 0, skipped: 0, failed: [] });
  const create = requests.find((request) => request.path === "/v1/pages");
  assert.deepEqual(create.body.parent, { type: "data_source_id", data_source_id: "ds" });
  assert.equal(create.body.properties.Name.title[0].text.content, book.title);
  assert.equal(create.body.properties.ID.rich_text[0].text.content, book.bookId);
  assert.deepEqual(create.body.template, hasDefault ? { type: "default" } : undefined);
  assert.equal(requests.filter((request) => request.path === "/v1/data_sources/ds/templates").length, hasDefault ? 2 : 1);
  assert.equal(requests.filter((request) => request.path === "/v1/blocks/template/children").length, hasDefault && hasNotes ? 1 : 0);
  if (hasDefault && hasNotes) {
    assert.ok(pageReads >= 3);
    assert.deepEqual(pageBlocks.slice(0, 2), templateBlocks);
  }
  if (hasNotes) {
    assert.ok(pageBlocks.some((block) => block.heading_1?.rich_text?.[0]?.text?.content === "微信读书划线与想法"));
    assert.ok(pageBlocks.some((block) => block.quote?.rich_text?.[0]?.text?.content === note.original));
  } else {
    assert.equal(pageReads, 0);
  }
}

await runCase({ hasDefault: true, hasNotes: true });
await runCase({ hasDefault: true, hasNotes: false });
await runCase({ hasDefault: false, hasNotes: true });
console.log("Default template creation, delayed template content, and no-template fallback passed");

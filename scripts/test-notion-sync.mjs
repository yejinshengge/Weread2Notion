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
const title = "微信读书划线与想法（自动同步）";
const calloutPrefix = "微信读书同步信息 · ";
const response = (body, status = 200, headers) => new Response(JSON.stringify(body), { status, headers });
const textOf = (block) => block[block.type]?.rich_text?.map((text) => text.plain_text ?? text.text?.content ?? "").join("") ?? "";

let pageBlocks = [], requests = [], nextId = 0;
let failNextChildAppend = false, commitThenFailAppend = false, corruptNextChildAppend = false;
let failNextArchive = false, rateLimit = false;
let staleChildReadCount = 0, emptyParagraphOnRead = false, normalizeLineBreakOnAppend = false, stripZeroWidthSpaceOnAppend = false;

function childrenOf(parentId) {
  if (parentId === "page") return pageBlocks;
  const stack = [...pageBlocks];
  while (stack.length) {
    const block = stack.pop();
    if (block.id === parentId) return block.children;
    stack.push(...block.children);
  }
  throw new Error(`Unknown parent ${parentId}`);
}

function findBlock(id) {
  const stack = [...pageBlocks];
  while (stack.length) {
    const block = stack.pop();
    if (block.id === id) return block;
    stack.push(...block.children);
  }
  return undefined;
}

const publicBlock = ({ children, ...block }) => ({ ...structuredClone(block), has_children: children.length > 0 });
const createBlock = (block) => {
  const created = { ...structuredClone(block), id: `block-${++nextId}`, children: [] };
  if (normalizeLineBreakOnAppend && created.type === "quote") {
    created.quote.rich_text[0].text.content = created.quote.rich_text[0].text.content.replace(/\r\n?/g, "\n");
  }
  if (stripZeroWidthSpaceOnAppend && created.type === "quote") {
    created.quote.rich_text[0].text.content = created.quote.rich_text[0].text.content.replace(/\u200B/g, "");
  }
  return created;
};
const roots = () => pageBlocks.filter((block) => block.type === "callout" && textOf(block).startsWith(calloutPrefix));
const manual = { id: "manual", type: "heading_1", heading_1: { rich_text: [{ text: { content: "手工内容" } }] }, children: [] };
const manualParagraph = { id: "manual-paragraph", type: "paragraph", paragraph: { rich_text: [{ text: { content: "单独的手工段落" } }] }, children: [] };

globalThis.fetch = async (url, init) => {
  const parsed = new URL(url);
  const path = parsed.pathname;
  const body = init.body ? JSON.parse(init.body) : {};
  requests.push({ path, method: init.method, body, bytes: new TextEncoder().encode(init.body ?? "").length });
  if (path === "/v1/data_sources/ds") return response({ properties: { Name: { id: "title", type: "title" }, ID: { id: "id", type: "rich_text" } } });
  if (path.endsWith("/query")) return response({ results: [{ id: "page" }] });
  const childrenMatch = path.match(/^\/v1\/blocks\/([^/]+)\/children$/);
  if (childrenMatch) {
    const parentId = childrenMatch[1];
    const children = childrenOf(parentId);
    if (init.method === "GET") {
      let visible = children;
      if (parentId !== "page" && staleChildReadCount > 0) {
        staleChildReadCount--;
        visible = children.slice(0, -1);
      }
      if (parentId !== "page" && emptyParagraphOnRead) {
        visible = [...visible, { id: "notion-empty-paragraph", type: "paragraph", paragraph: { rich_text: [] }, children: [] }];
      }
      const start = Number(parsed.searchParams.get("start_cursor") ?? 0);
      return response({
        results: visible.slice(start, start + 100).map(publicBlock),
        has_more: start + 100 < visible.length,
        next_cursor: String(start + 100)
      });
    }
    if (rateLimit) { rateLimit = false; return response({ message: "rate limited" }, 429, { "Retry-After": "0.001" }); }
    if (parentId !== "page" && failNextChildAppend) {
      failNextChildAppend = false;
      return response({ message: "injected failure" }, 503);
    }
    assert.ok(body.children.length <= 100);
    assert.ok(new TextEncoder().encode(init.body).length < 500_000);
    const added = body.children.map(createBlock);
    const anchor = body.after ? children.findIndex((block) => block.id === body.after) : children.length - 1;
    assert.ok(!body.after || anchor >= 0);
    children.splice(anchor + 1, 0, ...added);
    if (parentId !== "page" && corruptNextChildAppend) {
      corruptNextChildAppend = false;
      [children[0], children[1]] = [children[1], children[0]];
    }
    if (parentId !== "page" && commitThenFailAppend) {
      commitThenFailAppend = false;
      return response({ message: "saved but response failed" }, 503);
    }
    return response({ results: added.map(publicBlock) });
  }
  const blockId = path.split("/").at(-1);
  assert.ok(findBlock(blockId), path);
  if (body.archived) {
    if (failNextArchive) { failNextArchive = false; return response({ message: "injected archive failure" }, 503); }
    const parent = pageBlocks.includes(findBlock(blockId)) ? pageBlocks : undefined;
    assert.ok(parent, "Only managed top-level blocks should be archived");
    parent.splice(parent.findIndex((block) => block.id === blockId), 1);
  } else {
    Object.assign(findBlock(blockId), structuredClone(body));
  }
  return response({});
};

async function sync(notes, succeeds = true) {
  requests = [];
  const progress = [];
  const result = await syncBooksToNotion(settings, [book], {
    getHighlights: async () => notes,
    onProgress: (value) => { progress.push(value); }
  });
  assert.equal(result.failed.length, succeeds ? 0 : 1, JSON.stringify(result.failed));
  if (succeeds) assert.equal(progress.at(-1).highlightCompleted, notes.length);
  return requests;
}

let notes = Array.from({ length: 1000 }, (_, i) => note(i));
let writes = (await sync(notes)).filter((request) => request.method === "PATCH");
assert.equal(roots().length, 1);
assert.equal(roots()[0].children.length, 2004);
assert.equal(roots()[0].callout.color, "default");
assert.equal(roots()[0].callout.icon.emoji, "📖");
assert.equal(roots()[0].children[0].type, "heading_1");
assert.equal(textOf(roots()[0].children[0]), title);
assert.equal(roots()[0].children[0].heading_1.is_toggleable, false);
assert.equal(roots()[0].children.find((block) => block.type === "heading_2")?.heading_2.is_toggleable, false);
assert.equal(writes.filter((request) => request.path === "/v1/blocks/page/children").length, 1);
assert.equal(writes.filter((request) => request.path === `/v1/blocks/${roots()[0].id}/children`).length, 21);
assert.ok(writes.filter((request) => request.path === `/v1/blocks/${roots()[0].id}/children`).every((request) => !request.body.after));
assert.equal(writes.filter((request) => request.body.archived).length, 0);
const firstRootId = roots()[0].id;
writes = (await sync(notes)).filter((request) => request.method === "PATCH");
assert.equal(roots().length, 1);
assert.notEqual(roots()[0].id, firstRootId);
assert.equal(writes.filter((request) => request.body.archived).length, 1);
assert.ok(!writes.some((request) => request.path === `/v1/blocks/${firstRootId}/children`));
console.log("Full replacement writes into one new root, verifies it, then archives one old root");

pageBlocks.push(manualParagraph, manual);
notes.splice(400, 0, { ...note("insert"), chapterTitle: "第一篇 阅读的层次", subtitleTitle: "第五章 如何做一个自我要求的读者" });
roots()[0].children.reverse(); // Existing content and order have no authority over the next sync.
await sync(notes);
assert.equal(pageBlocks.at(-1).id, "manual");
assert.ok(findBlock("manual-paragraph"));
assert.deepEqual(roots()[0].children.filter((block) => block.type === "quote").map(textOf), notes.map((value) => value.original));
const childTexts = roots()[0].children.map(textOf);
assert.ok(childTexts.indexOf("第五章 如何做一个自我要求的读者") < childTexts.indexOf("划线 insert"));
console.log("Existing disorder, middle insertion and chapter title are repaired without touching manual content");

const preservedRoot = roots()[0].id;
failNextChildAppend = true;
await sync(notes, false);
assert.ok(findBlock(preservedRoot));
assert.equal(roots().length, 2);
rateLimit = true;
await sync(notes);
assert.equal(roots().length, 1);
assert.ok(!findBlock(preservedRoot));
console.log("Failed append keeps the old root; retry clears the incomplete root");

const beforeCorruption = roots()[0].id;
corruptNextChildAppend = true;
await sync(notes, false);
assert.ok(findBlock(beforeCorruption));
assert.equal(roots().length, 2);
await sync(notes);
assert.equal(roots().length, 1);
assert.deepEqual(roots()[0].children.filter((block) => block.type === "quote").map(textOf), notes.map((value) => value.original));
console.log("Read-back catches a successful but misordered write before old content is archived");

const beforeArchiveFailure = roots()[0].id;
failNextArchive = true;
await sync(notes, false);
assert.ok(findBlock(beforeArchiveFailure));
assert.equal(roots().length, 2);
await sync(notes);
assert.equal(roots().length, 1);
console.log("Archive failure leaves both copies recoverable and the next sync removes stale roots");

const beforeUnknownCommit = roots()[0].id;
commitThenFailAppend = true;
await sync(notes, false);
assert.ok(findBlock(beforeUnknownCommit));
assert.equal(roots().length, 2);
await sync(notes);
assert.equal(roots().length, 1);
console.log("An append committed before a 503 is reconciled on retry without deleting the old root");

await sync([]);
assert.equal(roots().length, 0);
assert.deepEqual(pageBlocks.map((block) => block.id), ["manual-paragraph", "manual"]);
console.log("Clearing all source highlights removes only the managed root");

pageBlocks = [
  { id: "old-callout", type: "callout", callout: { rich_text: [{ text: { content: title } }], color: "default" }, children: [
    { id: "old-callout-quote", type: "quote", quote: { rich_text: [{ text: { content: "旧划线" } }] }, children: [] }
  ] },
  manual
];
await sync([note(1)]);
assert.equal(roots().length, 1);
assert.ok(!findBlock("old-callout"));
assert.equal(roots()[0].children[0].type, "heading_1");
console.log("The previous Callout title is replaced by a heading inside the new Callout");

pageBlocks = [
  { id: "old-toggle-heading", type: "heading_1", heading_1: { rich_text: [{ text: { content: title } }], is_toggleable: true }, children: [
    { id: "old-toggle-quote", type: "quote", quote: { rich_text: [{ text: { content: "旧划线" } }] }, children: [] }
  ] },
  manual
];
staleChildReadCount = 1;
await sync([note(1)]);
assert.equal(roots().length, 1);
assert.ok(!findBlock("old-toggle-heading"));
assert.equal(pageBlocks.at(-1).id, "manual");
assert.equal(staleChildReadCount, 0);
console.log("A stale first read is retried before the previous toggle heading is retired");

emptyParagraphOnRead = true;
await sync([note(1)]);
assert.equal(roots().length, 1);
emptyParagraphOnRead = false;
console.log("A Notion blank paragraph does not make complete content fail verification");

normalizeLineBreakOnAppend = true;
await sync([{ ...note("line-break"), original: "第一行\r\n第二行" }]);
assert.equal(roots().length, 1);
normalizeLineBreakOnAppend = false;
console.log("Line-ending normalization does not report an otherwise complete write as failed");

stripZeroWidthSpaceOnAppend = true;
await sync([{ ...note("zero-width"), original: "说过：\u200B“有些书可以浅尝即止。\u200B”" }]);
assert.equal(roots().length, 1);
assert.equal(roots()[0].children.find((block) => block.type === "quote")?.quote.rich_text[0].text.content.includes("\u200B"), false);
stripZeroWidthSpaceOnAppend = false;
console.log("Notion removing invisible U+200B from a quote does not fail verification");

pageBlocks = [
  { id: "old-heading", type: "heading_1", heading_1: { rich_text: [{ text: { content: "微信读书划线与想法" } }], is_toggleable: false }, children: [] },
  { id: "old-quote", type: "quote", quote: { rich_text: [{ text: { content: "旧划线" } }] }, children: [] },
  { id: "old-divider", type: "divider", divider: {}, children: [] },
  manual
];
await sync([note(1)]);
assert.equal(roots().length, 1);
assert.equal(pageBlocks.at(-1).id, "manual");
assert.ok(!findBlock("old-heading") && !findBlock("old-quote") && !findBlock("old-divider"));
console.log("The old flat section is retired after the first successful Callout write");

pageBlocks = [];
notes = Array.from({ length: 100 }, (_, i) => ({ ...note(i), original: "中".repeat(4000), thought: "文".repeat(4000) }));
writes = (await sync(notes)).filter((request) => request.path.endsWith("/children") && request.method === "PATCH");
assert.ok(writes.every((request) => request.bytes < 500_000 && request.body.children.length <= 100));
assert.equal(roots().length, 1);
console.log("Large CJK content stays within Notion batch limits");

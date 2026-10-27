import test from "node:test";
import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
import { build } from "esbuild";

const bundled = await build({ entryPoints: ["src/background/index.ts"], bundle: true, write: false, format: "iife", platform: "node" });
const book = { bookId: "book", title: "测试书", author: "作者", cover: "https://example.com/cover.jpg", status: "阅读中", progress: 10 };
const textOf = (block) => block[block.type]?.rich_text?.map((text) => text.plain_text ?? text.text?.content ?? "").join("") ?? "";
const json = (body) => new Response(JSON.stringify(body));
const list = (results = []) => json({ results, has_more: false, next_cursor: null });

function createBackground({ existingPage = true, overwrite = true, useNotionCover = true } = {}) {
  let listener;
  let nextId = 0;
  const requests = [];
  const progress = [];
  const pageBlocks = [
    { id: "manual", type: "paragraph", paragraph: { rich_text: [{ text: { content: "手工内容" } }] } },
    { id: "old-highlights", type: "callout", callout: { rich_text: [{ text: { content: "微信读书同步信息 · 已有划线" } }] } }
  ];
  const childrenById = new Map([["page", pageBlocks]]);
  const settings = {
    wereadApiKey: "wrk-test", notionToken: "test", databaseId: "db", dataSourceId: "ds", useNotionCover,
    fieldMappings: [
      { propertyName: "ID", sourceType: "field", sourceField: "wereadId", overwriteOnUpdate: false },
      { propertyName: "Author", sourceType: "field", sourceField: "author", overwriteOnUpdate: overwrite }
    ]
  };
  const chrome = {
    action: { onClicked: { addListener() {} } },
    runtime: {
      onMessage: { addListener(callback) { listener = callback; } },
      async sendMessage(message) { progress.push(JSON.parse(JSON.stringify(message.progress))); }
    },
    storage: { local: { async get() { return { settings: structuredClone(settings) }; } } }
  };
  const fetch = async (url, init) => {
    const { hostname, pathname: path } = new URL(url);
    const body = init.body ? JSON.parse(init.body) : {};
    requests.push({ hostname, path, method: init.method, body });
    if (hostname === "i.weread.qq.com") {
      switch (body.api_name) {
        case "/user/notebooks": return json({ books: [{ book, noteCount: 1 }], hasMore: 0 });
        case "/book/chapterinfo": return json({ chapters: [{ chapterUid: 1, title: "第一章" }] });
        case "/book/bookmarklist": return json({ updated: [{ bookmarkId: "note", chapterUid: 1, markText: "最新划线" }] });
        case "/review/list/mine": return json({ reviews: [], hasMore: 0 });
        default: assert.fail(`Unexpected WeRead API: ${body.api_name}`);
      }
    }
    assert.equal(hostname, "api.notion.com");
    if (path === "/v1/data_sources/ds") {
      return json({ properties: {
        Name: { id: "title", type: "title" }, ID: { id: "id", type: "rich_text" }, Author: { id: "author", type: "rich_text" }
      } });
    }
    if (path === "/v1/data_sources/ds/query") return list(existingPage ? [{ id: "page" }] : []);
    if (path === "/v1/data_sources/ds/templates") return json({ templates: [{ id: "template", is_default: true }], has_more: false });
    if (path === "/v1/pages") return json({ id: "page" });
    if (path === "/v1/pages/page") return json({});
    const childrenMatch = path.match(/^\/v1\/blocks\/([^/]+)\/children$/);
    if (childrenMatch) {
      const children = childrenById.get(childrenMatch[1]);
      assert.ok(children, `Unexpected parent: ${childrenMatch[1]}`);
      if (init.method === "GET") return list(structuredClone(children));
      const added = body.children.map((block) => ({ ...structuredClone(block), id: `new-${++nextId}` }));
      for (const block of added) childrenById.set(block.id, []);
      children.push(...added);
      return list(added);
    }
    if (path === "/v1/blocks/old-highlights" && body.archived) {
      pageBlocks.splice(pageBlocks.findIndex((block) => block.id === "old-highlights"), 1);
      return json({});
    }
    assert.fail(`Unexpected ${init.method} ${path}`);
  };
  runInNewContext(bundled.outputFiles[0].text, {
    chrome, fetch, URL, URLSearchParams, TextEncoder, AbortController, Headers, setTimeout, clearTimeout
  });
  return {
    requests, progress, pageBlocks, childrenById,
    send(syncHighlights) {
      return new Promise((resolve) => {
        assert.equal(listener({ type: "SYNC_BOOKS", books: [book], syncHighlights }, {}, (response) => {
          resolve(JSON.parse(JSON.stringify(response)));
        }), true);
      });
    }
  };
}

function assertBooksOnly(background) {
  assert.ok(background.requests.every((request) => request.hostname === "api.notion.com"));
  assert.ok(background.requests.every((request) => !request.path.startsWith("/v1/blocks/")));
  assert.ok(background.progress.every((value) => value.stage !== "readingHighlights"));
  assert.equal(background.progress.at(-1).completed, 1);
}

test("取消同步划线时只更新书籍属性和封面，保留原划线及手工内容", async () => {
  const background = createBackground();
  const before = structuredClone(background.pageBlocks);
  assert.deepEqual(await background.send(false), {
    ok: true, data: { created: 0, updated: 1, skipped: 0, failed: [] }
  });
  assertBooksOnly(background);
  assert.deepEqual(background.pageBlocks, before);
  const update = background.requests.find((request) => request.method === "PATCH");
  assert.equal(update.path, "/v1/pages/page");
  assert.equal(update.body.properties.Author.rich_text[0].text.content, book.author);
  assert.equal(update.body.cover.external.url, book.cover);
});

test("取消同步划线时新建书籍仍使用默认模板，并写入书名及去重字段", async () => {
  const background = createBackground({ existingPage: false });
  assert.deepEqual(await background.send(false), {
    ok: true, data: { created: 1, updated: 0, skipped: 0, failed: [] }
  });
  assertBooksOnly(background);
  const create = background.requests.find((request) => request.path === "/v1/pages");
  assert.equal(create.body.properties.Name.title[0].text.content, book.title);
  assert.equal(create.body.properties.ID.rich_text[0].text.content, book.bookId);
  assert.deepEqual(create.body.template, { type: "default" });
});

test("仅同步书籍且没有可覆盖字段或封面时跳过写入", async () => {
  const background = createBackground({ overwrite: false, useNotionCover: false });
  assert.deepEqual(await background.send(false), {
    ok: true, data: { created: 0, updated: 0, skipped: 1, failed: [] }
  });
  assertBooksOnly(background);
  assert.ok(background.requests.every((request) => request.method !== "PATCH"));
});

test("勾选同步划线时仍读取笔记本和划线，写入并替换原划线区", async () => {
  const background = createBackground();
  assert.deepEqual(await background.send(true), {
    ok: true, data: { created: 0, updated: 1, skipped: 0, failed: [] }
  });
  const wereadApis = background.requests.filter((request) => request.hostname === "i.weread.qq.com").map((request) => request.body.api_name);
  assert.deepEqual(wereadApis.sort(), ["/user/notebooks", "/book/chapterinfo", "/book/bookmarklist", "/review/list/mine"].sort());
  assert.ok(background.progress.some((value) => value.stage === "readingHighlights"));
  assert.equal(background.progress.at(-1).highlightCompleted, 1);
  assert.ok(background.pageBlocks.some((block) => block.id === "manual"));
  assert.ok(!background.pageBlocks.some((block) => block.id === "old-highlights"));
  const root = background.pageBlocks.find((block) => block.type === "callout");
  assert.ok(background.childrenById.get(root.id).some((block) => textOf(block) === "最新划线"));
});

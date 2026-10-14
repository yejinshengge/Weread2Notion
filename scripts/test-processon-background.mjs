import test from "node:test";
import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
import { build } from "esbuild";

const bundled = await build({ entryPoints: ["src/background/index.ts"], bundle: true, write: false, format: "iife", platform: "node" });
const PAGE = "00000000-0000-4000-8000-000000000001";
const BLOCK = "00000000-0000-4000-8000-000000000002";
const GRAPH = "https://www.processon.com/embed/0123456789abcdef01234567";
const TOKEN = "saved_credential_for_background_tests";
const page = { object: "page", properties: { Name: { type: "title", title: [{ plain_text: "测试页面" }] } } };
const list = (results = []) => ({ results, has_more: false, next_cursor: null });
const embed = { id: BLOCK, type: "embed", embed: { url: GRAPH } };
const json = (body, status = 200) => new Response(JSON.stringify(body), { status });

function createBackground(fetchImpl, saved = { notionToken: TOKEN }) {
  let listener;
  let settings = saved;
  const chrome = {
    action: { onClicked: { addListener() {} } },
    runtime: { onMessage: { addListener(callback) { listener = callback; } } },
    storage: { local: { async get() { return { settings: structuredClone(settings) }; } } }
  };
  runInNewContext(bundled.outputFiles[0].text, {
    chrome, fetch: fetchImpl, URL, URLSearchParams, AbortController, Headers, setTimeout, clearTimeout
  });
  return {
    save(value) { settings = value; },
    send(request) {
      return new Promise((resolve) => {
        const retained = listener(request, {}, (response) => resolve(JSON.parse(JSON.stringify(response))));
        if (retained === false) resolve(undefined);
        else assert.equal(retained, true);
      });
    }
  };
}

test("后台使用配置页的当前凭据，页面检查只读且不依赖书籍配置", async () => {
  const requests = [];
  const background = createBackground(async (url, options) => {
    requests.push({ url, options });
    return json(page);
  });
  const check = { type: "CHECK_NOTION_PAGE", pageId: `https://www.notion.so/Notes-${PAGE.replaceAll("-", "")}` };
  assert.deepEqual(await background.send(check), {
    ok: true, data: { pageId: PAGE, pageTitle: "测试页面", pageUrl: `https://app.notion.com/p/${PAGE.replaceAll("-", "")}` }
  });
  assert.equal(requests[0].options.headers.Authorization, `Bearer ${TOKEN}`);
  background.save({ notionToken: "updated_credential_for_background_tests" });
  assert.equal((await background.send(check)).ok, true);
  assert.equal(requests[1].options.headers.Authorization, "Bearer updated_credential_for_background_tests");
  assert.ok(requests.every(({ url, options }) => url === `https://api.notion.com/v1/pages/${PAGE}` && options.method === "GET"));
});

test("未配置凭据时返回配置页提示，不发送网络请求", async () => {
  const background = createBackground(async () => assert.fail("Missing token must not fetch"), {});
  const result = await background.send({ type: "CHECK_NOTION_PAGE", pageId: PAGE });
  assert.equal(result.ok, false);
  assert.equal(result.field, "notion-token");
  assert.match(result.error, /配置页.*保存/);
});

test("嵌入通过后台读取保存的密钥，并使用顶部位置和可选标题", async () => {
  const requests = [];
  const responses = [json(page), json(list()), json(list([embed]))];
  const background = createBackground(async (url, options) => {
    requests.push({ url, options });
    return responses.shift();
  });
  const result = await background.send({ type: "EMBED_PROCESSON", input: { pageId: PAGE, embedUrl: GRAPH, title: "思维导图", position: "start" } });
  assert.equal(result.ok, true);
  assert.equal(result.data.created, true);
  const write = requests.find(({ options }) => options.method === "PATCH");
  assert.ok(write);
  const payload = JSON.parse(write.options.body);
  assert.deepEqual(payload.position, { type: "start" });
  assert.equal(payload.children[0].heading_2.rich_text[0].text.content, "思维导图");
  assert.equal(payload.children[1].embed.url, GRAPH);
  assert.ok(requests.every(({ options }) => options.headers.Authorization === `Bearer ${TOKEN}`));
  assert.ok(!JSON.stringify(result).includes(TOKEN));
});

test("同时提交同一页面和图表只写入一次", async () => {
  let writes = 0;
  let calls = 0;
  const background = createBackground(async (_url, options) => {
    calls++;
    await new Promise((resolve) => setTimeout(resolve, 5));
    if (options.method === "PATCH") { writes++; return json(list([embed])); }
    return json(calls === 1 ? page : list());
  });
  const request = { type: "EMBED_PROCESSON", input: { pageId: PAGE, embedUrl: GRAPH } };
  const results = await Promise.all([background.send(request), background.send(request)]);
  assert.ok(results.every((result) => result.ok && result.data.created));
  assert.equal(writes, 1);
  assert.equal(calls, 3);
});

test("未确认的写入结果保留错误元数据，重试时重新检查且释放任务锁", async () => {
  let writes = 0;
  const background = createBackground(async (url, options) => {
    if (options.method === "PATCH") { writes++; throw new Error(TOKEN); }
    return json(url.includes("/pages/") ? page : list());
  });
  const request = { type: "EMBED_PROCESSON", input: { pageId: PAGE, embedUrl: GRAPH } };
  const result = await background.send(request);
  assert.equal(result.ok, false);
  assert.equal(result.uncertain, true);
  assert.equal(result.code, "uncertain_write");
  assert.ok(!result.error.includes(TOKEN));
  assert.equal(writes, 1);
  await background.send(request);
  assert.equal(writes, 2);
});

test("共享消息客户端保留后台错误元数据", async () => {
  const runtimeBundle = await build({ entryPoints: ["src/shared/runtime.ts"], bundle: true, write: false, format: "esm", platform: "node" });
  const { sendBackgroundMessage, BackgroundError } = await import(`data:text/javascript;base64,${Buffer.from(runtimeBundle.outputFiles[0].text).toString("base64")}`);
  const previousChrome = globalThis.chrome;
  globalThis.chrome = { runtime: { sendMessage: async () => ({ ok: false, error: "请先确认写入结果", code: "uncertain_write", uncertain: true }) } };
  try {
    await assert.rejects(sendBackgroundMessage({ type: "EMBED_PROCESSON", input: { pageId: PAGE, embedUrl: GRAPH } }), (error) => {
      assert.ok(error instanceof BackgroundError);
      assert.equal(error.uncertain, true);
      assert.equal(error.code, "uncertain_write");
      return true;
    });
  } finally {
    globalThis.chrome = previousChrome;
  }
});

test("空标题在顶部与底部只创建 embed，并返回完整的页面结果", async () => {
  for (const title of [undefined, "", "   "]) {
    for (const position of ["start", "end"]) {
      const requests = [];
      const responses = [json(page), json(list()), json(list([embed]))];
      const background = createBackground(async (_url, options) => {
        requests.push(options);
        return responses.shift();
      });
      const result = await background.send({ type: "EMBED_PROCESSON", input: { pageId: PAGE, embedUrl: GRAPH, title, position } });
      assert.deepEqual(result, { ok: true, data: { created: true, pageTitle: "测试页面", pageId: PAGE, blockId: BLOCK, url: GRAPH } });
      const payload = JSON.parse(requests.find((request) => request.method === "PATCH").body);
      assert.deepEqual(payload.position, { type: position });
      assert.equal(payload.children.length, 1);
      assert.equal(payload.children[0].type, "embed");
    }
  }
});

test("后台忽略无关消息，不返回带空数据的成功响应", async () => {
  const background = createBackground(async () => assert.fail("Unrelated message must not fetch"));
  assert.equal(await background.send({ type: "SYNC_PROGRESS", progress: {} }), undefined);
  assert.equal(await background.send({ type: "UNSUPPORTED_REQUEST" }), undefined);
});

test("消息客户端拒绝缺失的嵌入结果，提供核对与重新加载指引", async () => {
  const runtimeBundle = await build({ entryPoints: ["src/shared/runtime.ts"], bundle: true, write: false, format: "esm", platform: "node" });
  const { sendBackgroundMessage, BackgroundError } = await import(`data:text/javascript;base64,${Buffer.from(runtimeBundle.outputFiles[0].text).toString("base64")}`);
  const previousChrome = globalThis.chrome;
  try {
    for (const response of [undefined, null, { ok: true }, { ok: true, data: null }, { ok: true, data: {} }, { ok: true, data: { created: true } }]) {
      globalThis.chrome = { runtime: { sendMessage: async () => response } };
      await assert.rejects(sendBackgroundMessage({ type: "EMBED_PROCESSON", input: { pageId: PAGE, embedUrl: GRAPH, title: "" } }), (error) => {
        assert.ok(error instanceof BackgroundError);
        assert.equal(error.code, "invalid_response");
        assert.equal(error.uncertain, true);
        assert.match(error.message, /核对/);
        assert.match(error.message, /重新加载/);
        return true;
      });
    }
  } finally {
    globalThis.chrome = previousChrome;
  }
});

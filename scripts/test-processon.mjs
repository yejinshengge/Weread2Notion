// Core behavior regression cases adapted from processon-notion-embed (MIT).
// See public/licenses/processon-notion-embed.txt.
import test from 'node:test';
import assert from 'node:assert/strict';
import { build } from 'esbuild';

const bundled = await build({ entryPoints: ['src/services/processon.ts'], bundle: true, write: false, format: 'esm', platform: 'node' });
const {
  NOTION_API, NOTION_VERSION, ToolError, normalizeProcessOn, parseNotionPage,
  normalizeToken, buildEmbedPayload, notionPageUrl, readPageTitle, NotionClient, embedGraph
} = await import(`data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString('base64')}`);

const PAGE = '00000000-0000-4000-8000-000000000001';
const BLOCK = '00000000-0000-4000-8000-000000000002';
const RAW_PAGE = PAGE.replaceAll('-', '');
const GRAPH = 'https://www.processon.com/embed/0123456789abcdef01234567';
const TOKEN = 'test_credential_for_unit_tests_only';
const page = { object: 'page', id: PAGE, properties: { Name: { type: 'title', title: [{ plain_text: '阅读' }, { text: { content: '笔记' } }] } } };
const embed = { object: 'block', id: BLOCK, type: 'embed', embed: { url: GRAPH } };
const json = (data, status = 200, headers = {}) => new Response(JSON.stringify(data), { status, headers });
const list = (results = [], extra = {}) => ({ object: 'list', results, has_more: false, next_cursor: null, ...extra });

function sequence(responses) {
  const requests = [];
  const fetchImpl = async (url, options) => {
    requests.push({ url, options });
    assert.ok(responses.length, 'Unexpected extra request');
    const response = responses.shift();
    if (response instanceof Error) throw response;
    return response;
  };
  return { requests, fetchImpl };
}

test('ProcessOn 官方嵌入链接和 iframe 可规范化', () => {
  assert.equal(normalizeProcessOn(`  ${GRAPH}  `), GRAPH);
  assert.equal(normalizeProcessOn('https://processon.com/embed/0123456789ABCDEF01234567/?utm=test#view'), GRAPH);
  assert.equal(normalizeProcessOn(`<iframe width="100%" src='${GRAPH}?a=1&amp;b=2'></iframe>`), GRAPH);
});

test('拒绝非官方域名、非 HTTPS、凭证、端口和普通分享链接', () => {
  for (const input of [
    'javascript:alert(1)', GRAPH.replace('https:', 'http:'),
    GRAPH.replace('www.processon.com', 'www.processon.com.evil.test'),
    GRAPH.replace('www.processon.com', 'user@www.processon.com'),
    GRAPH.replace('www.processon.com', 'www.processon.com:8443'),
    GRAPH.replace('/embed/', '/view/'), `${GRAPH}/extra`,
    '<iframe data-src="https://www.processon.com/embed/0123456789abcdef01234567"></iframe>',
    '<iframe></iframe>', '', 'https://www.processon.com/embed/not-a-file'
  ]) assert.throws(() => normalizeProcessOn(input), error => error instanceof ToolError && error.field === 'processon-url');
});

test('识别 Notion 多种页面链接，视图查询和区块锚点不取代页面 ID', () => {
  for (const input of [
    PAGE, RAW_PAGE.toUpperCase(), `https://app.notion.com/p/${RAW_PAGE}?source=copy_link`,
    `https://www.notion.so/Reading-${RAW_PAGE}?v=ffffffffffffffffffffffffffffffff#${BLOCK}`,
    `https://example.notion.site/${PAGE}`, `https://notion.so/%E7%AC%94%E8%AE%B0-${RAW_PAGE}/`
  ]) assert.equal(parseNotionPage(input), PAGE);
  assert.equal(notionPageUrl(PAGE, BLOCK), `https://app.notion.com/p/${RAW_PAGE}#${BLOCK.replaceAll('-', '')}`);
});

test('拒绝伪造 Notion 域名、不完整 ID 和缺少页面 ID 的视图链接', () => {
  for (const input of [
    'not-an-id', `https://notion.so.evil.test/${RAW_PAGE}`, `https://evilnotion.site/${RAW_PAGE}`,
    `http://notion.so/${RAW_PAGE}`, `https://user@notion.so/${RAW_PAGE}`,
    `https://notion.so:8443/${RAW_PAGE}`, `https://notion.so/workspace?v=${RAW_PAGE}`,
    `https://notion.so/f${RAW_PAGE}`, 'https://notion.so/%ZZ'
  ]) assert.throws(() => parseNotionPage(input), error => error.field === 'notion-url');
});

test('凭证去空白且支持 Bearer 前缀，拒绝空值和不可用格式', () => {
  assert.equal(normalizeToken(` Bearer ${TOKEN} `), TOKEN);
  for (const input of ['', 'short', 'a'.repeat(501), 'test token with spaces long enough', '测试凭证'.repeat(8)]) {
    assert.throws(() => normalizeToken(input), error => error.field === 'notion-token');
  }
});

test('生成原生 embed，可选二级标题和顶部/底部位置', () => {
  const minimal = buildEmbedPayload({ embedUrl: GRAPH });
  assert.deepEqual(minimal, { children: [{ object: 'block', type: 'embed', embed: { url: GRAPH, caption: [] } }], position: { type: 'end' } });
  const titled = buildEmbedPayload({ embedUrl: GRAPH, title: ' 思维导图 ', position: 'start' });
  assert.equal(titled.children[0].heading_2.rich_text[0].text.content, '思维导图');
  assert.equal(titled.children[1].type, 'embed');
  assert.deepEqual(titled.position, { type: 'start' });
  assert.throws(() => buildEmbedPayload({ embedUrl: GRAPH, title: 'a'.repeat(81) }), error => error.field === 'block-title');
  assert.throws(() => buildEmbedPayload({ embedUrl: GRAPH, position: 'other' }), error => error.field === 'position');
  assert.equal(readPageTitle(page), '阅读笔记');
  assert.equal(readPageTitle({ properties: {} }), '未命名页面');
});

test('先检查页面和重复，再写入；凭证只发送到固定的 Notion API', async () => {
  const mock = sequence([json(page), json(list()), json(list([embed]))]);
  const progress = [];
  const result = await embedGraph({ token: TOKEN, pageId: PAGE, embedUrl: GRAPH, title: '导图', position: 'start', fetchImpl: mock.fetchImpl, onProgress: step => progress.push(step) });
  assert.deepEqual(result, { created: true, pageTitle: '阅读笔记', pageId: PAGE, blockId: BLOCK, url: GRAPH });
  assert.deepEqual(progress, ['page', 'duplicates', 'insert']);
  assert.deepEqual(mock.requests.map(request => request.options.method), ['GET', 'GET', 'PATCH']);
  for (const { url, options } of mock.requests) {
    assert.equal(new URL(url).origin, 'https://api.notion.com');
    assert.equal(options.headers.Authorization, `Bearer ${TOKEN}`);
    assert.equal(options.headers['Notion-Version'], NOTION_VERSION);
    assert.equal(options.credentials, 'omit');
    assert.equal(options.redirect, 'error');
    assert.equal(options.referrerPolicy, 'no-referrer');
    assert.ok(!url.includes(TOKEN));
    assert.ok(!options.body?.includes(TOKEN));
  }
  assert.deepEqual(JSON.parse(mock.requests[2].options.body), buildEmbedPayload({ embedUrl: GRAPH, title: '导图', position: 'start' }));
});

test('重复图表即使在分页第二页也不会再次写入', async () => {
  const mock = sequence([
    json(page), json(list([{ type: 'paragraph' }], { has_more: true, next_cursor: BLOCK })),
    json(list([{ ...embed, embed: { url: GRAPH.replace('www.processon.com', 'processon.com') } }]))
  ]);
  const result = await embedGraph({ token: TOKEN, pageId: PAGE, embedUrl: GRAPH, fetchImpl: mock.fetchImpl });
  assert.equal(result.created, false);
  assert.equal(result.blockId, BLOCK);
  assert.equal(mock.requests.length, 3);
  assert.ok(mock.requests.every(request => request.options.method === 'GET'));
  assert.equal(new URL(mock.requests[2].url).searchParams.get('start_cursor'), BLOCK);
});

test('归档的旧嵌入和 bookmark 卡片不会阻止原生 embed 创建', async () => {
  const mock = sequence([json(page), json(list([{ ...embed, archived: true }, { type: 'bookmark', bookmark: { url: GRAPH } }])), json(list([embed]))]);
  assert.equal((await embedGraph({ token: TOKEN, pageId: PAGE, embedUrl: GRAPH, fetchImpl: mock.fetchImpl })).created, true);
});

test('分页缺失或循环时停止操作，没有写入', async () => {
  for (const pages of [
    [json(list([], { has_more: true, next_cursor: null }))],
    [json(list([], { has_more: true, next_cursor: BLOCK })), json(list([], { has_more: true, next_cursor: BLOCK }))],
    [json({ results: null })]
  ]) {
    const mock = sequence([json(page), ...pages]);
    await assert.rejects(embedGraph({ token: TOKEN, pageId: PAGE, embedUrl: GRAPH, fetchImpl: mock.fetchImpl }), error => error.code === 'invalid_response');
    assert.ok(mock.requests.every(request => request.options.method === 'GET'));
  }
});

test('非页面或垃圾箱中的页面不会写入', async () => {
  for (const target of [{ object: 'database' }, { ...page, in_trash: true }, { ...page, archived: true }]) {
    const mock = sequence([json(target)]);
    await assert.rejects(embedGraph({ token: TOKEN, pageId: PAGE, embedUrl: GRAPH, fetchImpl: mock.fetchImpl }), error => error.field === 'notion-url');
    assert.equal(mock.requests.length, 1);
  }
});

test('未授权、权限不足、不可见页面提供可操作提示且不泄露响应内容', async () => {
  for (const [status, code, field] of [[401, 'unauthorized', 'notion-token'], [403, 'restricted_resource', undefined], [404, 'object_not_found', 'notion-url']]) {
    const mock = sequence([json({ message: `Server echoed ${TOKEN}` }, status)]);
    const client = new NotionClient(TOKEN, { fetchImpl: mock.fetchImpl });
    await assert.rejects(client.page(PAGE), error => error.code === code && error.field === field && !error.message.includes(TOKEN));
    assert.equal(mock.requests.length, 1);
  }
});

test('读取限流最多重试两次，等待时间有上限', async () => {
  const waits = [];
  const mock = sequence([json({}, 429, { 'Retry-After': '1' }), json({}, 429, { 'Retry-After': '999' }), json(page)]);
  const client = new NotionClient(TOKEN, { fetchImpl: mock.fetchImpl, sleep: async ms => waits.push(ms) });
  assert.equal((await client.page(PAGE)).id, PAGE);
  assert.deepEqual(waits, [1000, 3000]);
  const limited = sequence([json({}, 429), json({}, 429), json({}, 429)]);
  await assert.rejects(new NotionClient(TOKEN, { fetchImpl: limited.fetchImpl, sleep: async () => {} }).page(PAGE), error => error.code === 'rate_limited');
  assert.equal(limited.requests.length, 3);
});

test('写入限流、冲突和服务错误均不自动重试', async () => {
  for (const [status, code, uncertain] of [[429, 'rate_limited', false], [409, 'conflict_error', true], [500, 'uncertain_write', true], [503, 'uncertain_write', true]]) {
    const mock = sequence([json({}, status)]);
    const client = new NotionClient(TOKEN, { fetchImpl: mock.fetchImpl, sleep: async () => assert.fail('Writes must not retry') });
    await assert.rejects(client.request(`/blocks/${PAGE}/children`, { method: 'PATCH', body: buildEmbedPayload({ embedUrl: GRAPH }) }), error => error.code === code && error.uncertain === uncertain);
    assert.equal(mock.requests.length, 1);
  }
});

test('网络中断和写入超时报告未确认结果，不自动重试', async () => {
  for (const method of ['GET', 'PATCH']) {
    let calls = 0;
    const client = new NotionClient(TOKEN, {
      timeoutMs: 5,
      fetchImpl: async (_url, { signal }) => {
        calls += 1;
        return new Promise((_resolve, reject) => signal.addEventListener('abort', () => reject(new Error('timeout')), { once: true }));
      }
    });
    await assert.rejects(client.request(`/blocks/${PAGE}/children`, { method }), error => error.code === (method === 'GET' ? 'network_error' : 'uncertain_write') && error.uncertain === (method === 'PATCH'));
    assert.equal(calls, 1);
  }
  const client = new NotionClient(TOKEN, { fetchImpl: async () => { throw new Error(TOKEN); } });
  await assert.rejects(client.page(PAGE), error => error.code === 'network_error' && !error.message.includes(TOKEN));
});

test('不完整写入响应提示先确认结果，不会盲目重复', async () => {
  for (const response of [new Response('invalid-json'), json(list([{ type: 'bookmark', id: BLOCK }]))]) {
    const mock = sequence([json(page), json(list()), response]);
    await assert.rejects(embedGraph({ token: TOKEN, pageId: PAGE, embedUrl: GRAPH, fetchImpl: mock.fetchImpl }), error => error.code === 'invalid_response' && error.uncertain);
    assert.equal(mock.requests.length, 3);
  }
});

test('固定请求路径拒绝代理、非 Notion 路径和自定义来源', async () => {
  const client = new NotionClient(TOKEN, { fetchImpl: async () => assert.fail('Invalid paths must never fetch') });
  for (const path of ['https://evil.test', '//evil.test', '/users/me', `/pages/${PAGE}/../users/me`]) {
    await assert.rejects(client.request(path), error => error.code === 'invalid_path');
  }
  assert.equal(NOTION_API, 'https://api.notion.com/v1');
});

test('注入的原生 fetch 保留浏览器全局接收者，避免 Illegal invocation', async () => {
  const client = new NotionClient(TOKEN, {
    fetchImpl: async function () {
      assert.equal(this, globalThis);
      return json(page);
    }
  });
  assert.equal((await client.page(PAGE)).id, PAGE);
});

test('不完整的读取列表不会绕过重复检测或写入', async () => {
  for (const malformed of [
    { results: [], has_more: 'false' },
    list([null]), list([{ id: BLOCK }]), list([{ ...embed, id: undefined }]),
    list([{ ...embed, id: 'invalid-block' }]),
    { results: [], has_more: true, next_cursor: 42 }
  ]) {
    const mock = sequence([json(page), json(malformed)]);
    await assert.rejects(embedGraph({ token: TOKEN, pageId: PAGE, embedUrl: GRAPH, fetchImpl: mock.fetchImpl }), error => error.code === 'invalid_response' && !error.uncertain);
    assert.equal(mock.requests.length, 2);
    assert.ok(mock.requests.every(request => request.options.method === 'GET'));
  }
});

test('畸形的成功写入响应仍须先核对结果', async () => {
  for (const malformed of [{ results: {} }, { results: null }, list([{ ...embed, id: 'invalid-block' }])]) {
    const mock = sequence([json(page), json(list()), json(malformed)]);
    await assert.rejects(embedGraph({ token: TOKEN, pageId: PAGE, embedUrl: GRAPH, fetchImpl: mock.fetchImpl }), error => error.code === 'invalid_response' && error.uncertain);
    assert.equal(mock.requests.filter(request => request.options.method === 'PATCH').length, 1);
  }
});

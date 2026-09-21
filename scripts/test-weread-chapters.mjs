import assert from "node:assert/strict";
import { build } from "esbuild";

const bundled = await build({
  entryPoints: ["src/services/weread.ts"],
  bundle: true,
  write: false,
  format: "esm",
  platform: "node"
});
const { fetchWeReadHighlights } = await import(
  `data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString("base64")}`
);

const response = (body) => new Response(JSON.stringify(body));
globalThis.fetch = async (_url, init) => {
  const { api_name } = JSON.parse(init.body);
  if (api_name === "/book/chapterinfo") {
    return response({ chapters: [
      { chapterUid: 1, chapterIdx: 1, level: 1, title: "第一章" },
      { chapterUid: 11, chapterIdx: 2, level: 2, title: "第一节" },
      { chapterUid: 111, chapterIdx: 3, level: 3, title: "小标题" },
      { chapterUid: 2, chapterIdx: 4, level: 1, title: "第二章", anchors: [
        { chapterUid: 21, title: "章内子标题" },
        { chapterUid: 2, title: "重复 UID 不应覆盖章节" }
      ] }
    ] });
  }
  if (api_name === "/book/bookmarklist") {
    return response({ updated: [
      { bookmarkId: "root", chapterUid: 1, markText: "根章节划线", range: "1-2" },
      { bookmarkId: "section", chapterUid: 11, chapterTitle: "第一节", markText: "子标题划线", range: "3-4" },
      { bookmarkId: "nested", chapterUid: 111, markText: "三级标题划线", range: "5-6" },
      { bookmarkId: "anchor", chapterUid: 21, markText: "锚点划线", range: "7-8" },
      { bookmarkId: "next", chapterUid: 2, markText: "第二章划线", range: "9-10" },
      { bookmarkId: "fallback", chapterUid: 99, chapterTitle: "未知章节", markText: "回退划线", range: "11-12" }
    ] });
  }
  if (api_name === "/review/list/mine") {
    return response({ reviews: [
      { review: { reviewId: "thought", chapterUid: 11, abstract: "想法原文", content: "想法内容", range: "13-14" } }
    ], hasMore: 0 });
  }
  throw new Error(`Unexpected API: ${api_name}`);
};

const notes = await fetchWeReadHighlights("wrk-test", "book");
const location = (id) => {
  const { chapterTitle, subtitleTitle } = notes.find((note) => note.id === id);
  return [chapterTitle, subtitleTitle];
};
assert.deepEqual(location("root"), ["第一章", undefined]);
assert.deepEqual(location("section"), ["第一章", "第一节"]);
assert.deepEqual(location("nested"), ["第一章", "第一节 / 小标题"]);
assert.deepEqual(location("anchor"), ["第二章", "章内子标题"]);
assert.deepEqual(location("next"), ["第二章", undefined]);
assert.deepEqual(location("fallback"), ["未知章节", undefined]);
assert.deepEqual(location("thought"), ["第一章", "第一节"]);
console.log("Chapter hierarchy is preserved for chapter and anchor highlights");

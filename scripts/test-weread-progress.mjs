import assert from "node:assert/strict";
import { build } from "esbuild";

const bundled = await build({
  entryPoints: ["src/services/weread.ts"],
  bundle: true,
  write: false,
  format: "esm",
  platform: "node"
});
const { fetchWeReadBooks } = await import(
  `data:text/javascript;base64,${Buffer.from(bundled.outputFiles[0].text).toString("base64")}`
);

const response = (body) => new Response(JSON.stringify(body));

globalThis.fetch = async (_url, init) => {
  const request = JSON.parse(init.body);
  if (request.api_name === "/shelf/sync") {
    return response({
      books: [
        { bookId: "finished", title: "已读完", progress: 67, finishReading: 1 },
        { bookId: "reading", title: "阅读中", progress: 0.67, finishReading: 0 }
      ]
    });
  }
  if (request.api_name === "/book/getprogress") {
    return response({
      book: request.bookId === "finished"
        ? { progress: 67, isStartReading: 1 }
        : { progress: 0.67, isStartReading: 1 }
    });
  }
  throw new Error(`Unexpected API: ${request.api_name}`);
};

const books = await fetchWeReadBooks("wrk-test");
assert.deepEqual(
  books.map(({ bookId, progress, status }) => ({ bookId, progress, status })),
  [
    { bookId: "finished", progress: 100, status: "已读完" },
    { bookId: "reading", progress: 67, status: "阅读中" }
  ]
);

console.log("Finished books normalize to 100%; fractional progress remains supported");

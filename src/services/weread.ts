import type { ReadingStatus, WeReadBook, WeReadHighlightNote, WeReadNotebookBook } from "../shared/types";

interface WeReadGatewayResponse {
  errcode?: number;
  errmsg?: string;
  message?: string;
  upgrade_info?: {
    message?: string;
    upgrade_url?: string;
  };
}

interface WeReadShelfResponse extends WeReadGatewayResponse {
  books?: unknown[];
}

interface BookLike {
  bookId?: string | number;
  title?: string;
  name?: string;
  cover?: string;
  author?: string;
  category?: unknown;
  categories?: unknown[];
  progress?: number;
  readingProgress?: number;
  finishReading?: boolean | number;
  readUpdateTime?: number;
  updateTime?: number;
  deepLink?: string;
}

interface ProgressLike {
  bookId?: string | number;
  progress?: number;
  readingProgress?: number;
  finishReading?: boolean | number;
  updateTime?: number;
  startReadingTime?: number;
  isStartReading?: boolean | number;
}

interface WeReadProgressResponse extends WeReadGatewayResponse {
  book?: ProgressLike;
}

interface NotebookBookLike {
  bookId?: string | number;
  book?: BookLike;
  noteCount?: number;
  bookmarkCount?: number;
  reviewCount?: number;
  sort?: number;
}

interface WeReadNotebookResponse extends WeReadGatewayResponse {
  books?: unknown[];
  hasMore?: boolean | number;
}

interface WeReadBookmarkListResponse extends WeReadGatewayResponse {
  updated?: unknown[];
}

interface BookmarkLike {
  bookmarkId?: string;
  bookId?: string | number;
  markText?: string;
  text?: string;
  content?: string;
  chapterUid?: string | number;
  chapterIdx?: number;
  chapterTitle?: string;
  chapterName?: string;
  range?: string;
  createTime?: number;
  updateTime?: number;
}

interface ReviewLike {
  reviewId?: string;
  bookId?: string | number;
  content?: string;
  abstract?: string;
  chapterUid?: string | number;
  chapterIdx?: number;
  chapterTitle?: string;
  range?: string;
  createTime?: number;
  userVid?: string | number;
  author?: {
    userVid?: string | number;
    name?: string;
  };
}

interface WeReadReviewListResponse extends WeReadGatewayResponse {
  reviews?: unknown[];
  hasMore?: boolean | number;
  synckey?: number;
}

interface ChapterInfoLike {
  chapterUid?: string | number;
  chapterIdx?: number;
  title?: string;
  level?: number;
  anchors?: ChapterInfoLike[];
}

interface ChapterLocation {
  chapterIdx?: number;
  chapterTitle: string;
  subtitleTitle?: string;
}

interface ChapterInfosResponse extends WeReadGatewayResponse {
  chapters?: ChapterInfoLike[];
}

const WEREAD_GATEWAY_URL = "https://i.weread.qq.com/api/agent/gateway";
const WEREAD_SKILL_VERSION = "1.0.4";
const WEREAD_PAGE_SIZE = 100;
const PROGRESS_CONCURRENCY = 8;
const READER_URL_PREFIX = "https://weread.qq.com/web/reader/";

class WeReadUpgradeRequiredError extends Error {}

export async function fetchWeReadBooks(
  apiKey: string,
  options: { includeStartReadAt?: boolean } = {}
): Promise<WeReadBook[]> {
  const payload = await callWeReadGateway<WeReadShelfResponse>(apiKey, "/shelf/sync");
  const books = Array.isArray(payload.books) ? payload.books : [];
  const normalizedBooks = books
    .map((item) => normalizeBook(item as BookLike))
    .filter((book): book is WeReadBook => Boolean(book));

  return enrichBooksWithProgress(apiKey, normalizedBooks, options);
}

async function enrichBooksWithProgress(
  apiKey: string,
  books: WeReadBook[],
  options: { includeStartReadAt?: boolean }
): Promise<WeReadBook[]> {
  const enrichedBooks = [...books];
  let nextIndex = 0;

  async function worker(): Promise<void> {
    while (nextIndex < books.length) {
      const index = nextIndex;
      nextIndex += 1;
      const book = books[index];

      try {
        const payload = await fetchBookProgress(apiKey, book.bookId);
        const progressRecord = payload.book;
        const finishReading = Boolean(progressRecord?.finishReading) || book.status === "已读完";
        const progress = normalizeProgress(firstNumber(progressRecord?.progress, book.progress), finishReading);
        const started = Boolean(progressRecord?.isStartReading) || progress > 0;
        enrichedBooks[index] = {
          ...book,
          progress,
          status: getReadingStatus(progress, finishReading, started),
          startReadAt: options.includeStartReadAt
            ? unixSecondsToIso(progressRecord?.startReadingTime) ?? book.startReadAt
            : undefined,
          lastReadAt: started ? unixSecondsToIso(progressRecord?.updateTime) ?? book.lastReadAt : undefined
        };
      } catch (error) {
        if (error instanceof WeReadUpgradeRequiredError) {
          throw error;
        }
        enrichedBooks[index] = book;
      }
    }
  }

  const workerCount = Math.min(PROGRESS_CONCURRENCY, books.length);
  await Promise.all(Array.from({ length: workerCount }, () => worker()));
  return enrichedBooks;
}

export async function fetchWeReadNotebooks(apiKey: string): Promise<WeReadNotebookBook[]> {
  const books: unknown[] = [];
  const seenCursors = new Set<number>();
  let lastSort: number | undefined;

  while (true) {
    const payload = await callWeReadGateway<WeReadNotebookResponse>(apiKey, "/user/notebooks", {
      count: WEREAD_PAGE_SIZE,
      ...(lastSort === undefined ? {} : { lastSort })
    });
    const pageBooks = Array.isArray(payload.books) ? payload.books : [];
    books.push(...pageBooks);

    if (!payload.hasMore) {
      break;
    }

    const nextLastSort = firstNumberOrUndefined((pageBooks.at(-1) as NotebookBookLike | undefined)?.sort);
    if (nextLastSort === undefined || seenCursors.has(nextLastSort)) {
      throw new Error("微信读书笔记分页游标无效，已停止读取以避免重复数据");
    }
    seenCursors.add(nextLastSort);
    lastSort = nextLastSort;
  }

  return books
    .map((item) => normalizeNotebookBook(item as NotebookBookLike))
    .filter((book): book is WeReadNotebookBook => Boolean(book))
    .sort((first, second) => (second.sort ?? 0) - (first.sort ?? 0));
}

export async function fetchWeReadHighlights(
  apiKey: string,
  bookId: string,
  expectedCounts?: Pick<WeReadNotebookBook, "bookmarkCount" | "reviewCount">
): Promise<WeReadHighlightNote[]> {
  const [chapterResult, bookmarkResult, reviewResult] = await Promise.allSettled([
    fetchChapterInfo(apiKey, bookId),
    fetchBookmarkList(apiKey, bookId),
    fetchReviewList(apiKey, bookId)
  ]);

  for (const result of [chapterResult, bookmarkResult, reviewResult]) {
    if (result.status === "rejected" && result.reason instanceof WeReadUpgradeRequiredError) {
      throw result.reason;
    }
  }

  if (chapterResult.status === "rejected" || bookmarkResult.status === "rejected" || reviewResult.status === "rejected") {
    const reasons = [
      chapterResult.status === "rejected" ? `章节：${getErrorMessage(chapterResult.reason)}` : "",
      bookmarkResult.status === "rejected" ? `划线：${getErrorMessage(bookmarkResult.reason)}` : "",
      reviewResult.status === "rejected" ? `想法：${getErrorMessage(reviewResult.reason)}` : ""
    ].filter(Boolean);
    throw new Error(`读取章节、划线或想法失败：${reasons.join("；")}`);
  }

  if (expectedCounts && (
    bookmarkResult.value.length < expectedCounts.bookmarkCount ||
    reviewResult.value.length < expectedCounts.reviewCount
  )) {
    throw new Error(
      `微信读书笔记明细少于笔记本概览：划线 ${bookmarkResult.value.length}/${expectedCounts.bookmarkCount}，` +
      `想法 ${reviewResult.value.length}/${expectedCounts.reviewCount}；请稍后重试`
    );
  }

  return mergeHighlightNotes(bookId, bookmarkResult.value, reviewResult.value, chapterResult.value);
}

function normalizeBook(book: BookLike): WeReadBook | null {
  const bookId = toStringValue(book.bookId);
  const title = book.title || book.name;
  if (!bookId || !title) {
    return null;
  }

  const finishReading = Boolean(book.finishReading);
  const progress = normalizeProgress(firstNumber(book.progress, book.readingProgress), finishReading);
  const status = getReadingStatus(progress, finishReading);
  const started = status !== "未开始";

  return {
    bookId,
    title,
    cover: normalizeCover(book.cover),
    progress,
    author: emptyToUndefined(book.author),
    category: normalizeCategory(book),
    url: emptyToUndefined(book.deepLink) ?? `${READER_URL_PREFIX}${bookId}`,
    status,
    lastReadAt: started ? unixSecondsToIso(firstNumberOrUndefined(book.readUpdateTime, book.updateTime)) : undefined
  };
}

function normalizeNotebookBook(item: NotebookBookLike): WeReadNotebookBook | null {
  const book = item.book;
  const bookId = toStringValue(item.bookId ?? book?.bookId);
  const title = book?.title || book?.name;
  if (!bookId || !title) {
    return null;
  }

  const highlightCount = firstNumber(item.noteCount);
  const bookmarkCount = firstNumber(item.bookmarkCount);
  const reviewCount = firstNumber(item.reviewCount);

  return {
    bookId,
    title,
    cover: normalizeCover(book?.cover),
    author: emptyToUndefined(book?.author),
    url: emptyToUndefined(book?.deepLink) ?? `${READER_URL_PREFIX}${bookId}`,
    noteCount: highlightCount + bookmarkCount + reviewCount,
    bookmarkCount: highlightCount,
    reviewCount,
    sort: firstNumberOrUndefined(item.sort)
  };
}

async function fetchBookProgress(apiKey: string, bookId: string): Promise<WeReadProgressResponse> {
  return callWeReadGateway<WeReadProgressResponse>(apiKey, "/book/getprogress", { bookId });
}

async function fetchBookmarkList(apiKey: string, bookId: string): Promise<BookmarkLike[]> {
  const payload = await callWeReadGateway<WeReadBookmarkListResponse>(apiKey, "/book/bookmarklist", { bookId });
  const bookmarks = Array.isArray(payload.updated) ? payload.updated : [];
  return bookmarks.map(normalizeBookmark).filter((item): item is BookmarkLike => Boolean(item));
}

async function fetchReviewList(apiKey: string, bookId: string): Promise<ReviewLike[]> {
  const reviews: ReviewLike[] = [];
  const seenCursors = new Set<number>([0]);
  let synckey = 0;

  while (true) {
    const payload = await callWeReadGateway<WeReadReviewListResponse>(apiKey, "/review/list/mine", {
      bookid: bookId,
      synckey,
      count: WEREAD_PAGE_SIZE
    });
    if (Array.isArray(payload.reviews)) {
      reviews.push(...payload.reviews.map(unwrapReview).filter((item): item is ReviewLike => Boolean(item)));
    }

    if (!payload.hasMore) {
      break;
    }

    const nextSynckey = firstNumberOrUndefined(payload.synckey);
    if (nextSynckey === undefined || seenCursors.has(nextSynckey)) {
      throw new Error(`读取《${bookId}》想法时分页游标无效`);
    }
    seenCursors.add(nextSynckey);
    synckey = nextSynckey;
  }

  return reviews;
}

async function fetchChapterInfo(apiKey: string, bookId: string): Promise<Map<string, ChapterLocation>> {
  const payload = await callWeReadGateway<ChapterInfosResponse>(apiKey, "/book/chapterinfo", { bookId });
  const chapters = new Map<string, ChapterLocation>();
  const ancestors: Array<{ level: number; title: string }> = [];
  for (const item of payload.chapters ?? []) {
    const level = typeof item.level === "number" && Number.isInteger(item.level) && item.level >= 0
      ? item.level
      : undefined;
    if (level === undefined) {
      ancestors.length = 0;
    } else {
      while (ancestors.length && ancestors[ancestors.length - 1].level >= level) {
        ancestors.pop();
      }
    }
    addChapter(chapters, item, ancestors.map((ancestor) => ancestor.title));
    const title = emptyToUndefined(item.title);
    if (title && level !== undefined) {
      ancestors.push({ level, title });
    }
  }
  return chapters;
}

function addChapter(
  chapters: Map<string, ChapterLocation>,
  chapter: ChapterInfoLike,
  parentTitles: string[],
  parentIdx?: number
): void {
  const title = emptyToUndefined(chapter.title);
  const titles = title ? [...parentTitles, title] : parentTitles;
  const chapterUid = toStringValue(chapter.chapterUid);
  const chapterIdx = firstNumberOrUndefined(chapter.chapterIdx, parentIdx);
  if (chapterUid && titles.length && !chapters.has(chapterUid)) {
    chapters.set(chapterUid, {
      chapterIdx,
      chapterTitle: titles[0],
      subtitleTitle: titles.length > 1 ? titles.slice(1).join(" / ") : undefined
    });
  }
  for (const anchor of chapter.anchors ?? []) {
    addChapter(chapters, anchor, titles, chapterIdx);
  }
}

async function callWeReadGateway<T extends WeReadGatewayResponse>(
  apiKey: string,
  apiName: string,
  params: Record<string, unknown> = {}
): Promise<T> {
  const normalizedApiKey = apiKey.trim();
  if (!normalizedApiKey) {
    throw new Error("请先在配置页填写 WEREAD_API_KEY");
  }
  if (!normalizedApiKey.startsWith("wrk-")) {
    throw new Error("WEREAD_API_KEY 格式无效，应以 wrk- 开头");
  }

  const response = await fetch(WEREAD_GATEWAY_URL, {
    method: "POST",
    headers: {
      Accept: "application/json",
      Authorization: `Bearer ${normalizedApiKey}`,
      "Content-Type": "application/json"
    },
    body: JSON.stringify({
      ...params,
      api_name: apiName,
      skill_version: WEREAD_SKILL_VERSION
    })
  });

  let payload: WeReadGatewayResponse;
  try {
    payload = (await response.json()) as WeReadGatewayResponse;
  } catch {
    throw new Error(`微信读书接口返回了无法解析的响应（HTTP ${response.status}）`);
  }

  if (payload.upgrade_info) {
    const upgradeMessage = payload.upgrade_info.message?.trim() || "当前微信读书技能版本需要升级";
    throw new WeReadUpgradeRequiredError(`微信读书接口已暂停：${upgradeMessage}`);
  }

  if (!response.ok || (typeof payload.errcode === "number" && payload.errcode !== 0)) {
    const detail = payload.errmsg?.trim() || payload.message?.trim();
    throw new Error(detail || `微信读书接口调用失败（HTTP ${response.status}）`);
  }

  return payload as T;
}

function unwrapReview(item: unknown): ReviewLike | null {
  if (!item || typeof item !== "object") {
    return null;
  }

  const record = item as Record<string, unknown>;
  const review = record.review;
  if (review && typeof review === "object") {
    const reviewRecord = review as Record<string, unknown>;
    if (reviewRecord.review && typeof reviewRecord.review === "object") {
      return reviewRecord.review as ReviewLike;
    }
    return review as ReviewLike;
  }

  if (typeof record.content === "string" || typeof record.abstract === "string") {
    return item as ReviewLike;
  }

  return null;
}

function normalizeBookmark(item: unknown): BookmarkLike | null {
  if (!item || typeof item !== "object") {
    return null;
  }

  const record = item as BookmarkLike;
  const markText = emptyToUndefined(record.markText) ?? emptyToUndefined(record.text) ?? emptyToUndefined(record.content);
  if (!markText) {
    return null;
  }

  return {
    ...record,
    markText,
    chapterTitle: emptyToUndefined(record.chapterTitle) ?? emptyToUndefined(record.chapterName),
    createTime: firstNumberOrUndefined(record.createTime, record.updateTime)
  };
}

function mergeHighlightNotes(
  bookId: string,
  bookmarks: BookmarkLike[],
  reviews: ReviewLike[],
  chapters: Map<string, ChapterLocation>
): WeReadHighlightNote[] {
  const notesByKey = new Map<string, WeReadHighlightNote>();

  for (const bookmark of bookmarks) {
    const original = emptyToUndefined(bookmark.markText);
    if (!original) {
      continue;
    }
    const note = buildBookmarkNote(bookId, bookmark, chapters);
    notesByKey.set(getNoteMergeKey(note), note);
  }

  for (const review of reviews) {
    const note = buildReviewNote(bookId, review, chapters);
    if (!note.original && !note.thought) {
      continue;
    }
    const key = getNoteMergeKey(note);
    const existing = notesByKey.get(key);
    notesByKey.set(key, existing ? mergeNote(existing, note) : note);
  }

  return [...notesByKey.values()].sort(compareNotes);
}

function buildBookmarkNote(
  bookId: string,
  bookmark: BookmarkLike,
  chapters: Map<string, ChapterLocation>
): WeReadHighlightNote {
  const chapterUid = toStringValue(bookmark.chapterUid);
  const chapter = chapterUid ? chapters.get(chapterUid) : undefined;
  return {
    id: bookmark.bookmarkId || `${bookId}-${chapterUid}-${bookmark.range || bookmark.createTime || "bookmark"}`,
    bookId,
    type: "bookmark",
    chapterUid: emptyToUndefined(chapterUid),
    chapterIdx: firstNumberOrUndefined(bookmark.chapterIdx, chapter?.chapterIdx),
    chapterTitle: chapter?.chapterTitle ?? emptyToUndefined(bookmark.chapterTitle),
    subtitleTitle: chapter?.subtitleTitle,
    original: bookmark.markText?.trim() ?? "",
    range: emptyToUndefined(bookmark.range),
    createTime: firstNumberOrUndefined(bookmark.createTime),
    createdAt: unixSecondsToIso(bookmark.createTime)
  };
}

function buildReviewNote(
  bookId: string,
  review: ReviewLike,
  chapters: Map<string, ChapterLocation>
): WeReadHighlightNote {
  const chapterUid = toStringValue(review.chapterUid);
  const chapter = chapterUid ? chapters.get(chapterUid) : undefined;
  const createTime = firstNumberOrUndefined(review.createTime);
  return {
    id: review.reviewId || `${bookId}-${chapterUid}-${review.range || createTime || "review"}`,
    bookId,
    type: "review",
    chapterUid: emptyToUndefined(chapterUid),
    chapterIdx: firstNumberOrUndefined(review.chapterIdx, chapter?.chapterIdx),
    chapterTitle: chapter?.chapterTitle ?? emptyToUndefined(review.chapterTitle),
    subtitleTitle: chapter?.subtitleTitle,
    original: review.abstract?.trim() ?? "",
    thought: emptyToUndefined(review.content),
    userName: emptyToUndefined(review.author?.name),
    userVid: toStringValue(review.userVid ?? review.author?.userVid) || undefined,
    range: emptyToUndefined(review.range),
    createTime,
    createdAt: unixSecondsToIso(createTime)
  };
}

function getNoteMergeKey(note: WeReadHighlightNote): string {
  if (note.chapterUid && note.range) {
    return `${note.chapterUid}:${note.range}`;
  }
  return note.id;
}

function mergeNote(base: WeReadHighlightNote, incoming: WeReadHighlightNote): WeReadHighlightNote {
  return {
    ...base,
    type: base.type === "review" || incoming.type === "review" ? "review" : "bookmark",
    original: base.original || incoming.original,
    thought: incoming.thought || base.thought,
    userName: incoming.userName || base.userName,
    userVid: incoming.userVid || base.userVid,
    createTime: Math.max(base.createTime ?? 0, incoming.createTime ?? 0) || base.createTime || incoming.createTime,
    createdAt: incoming.createdAt || base.createdAt
  };
}

function compareNotes(first: WeReadHighlightNote, second: WeReadHighlightNote): number {
  const chapterDiff = (first.chapterIdx ?? Number.MAX_SAFE_INTEGER) - (second.chapterIdx ?? Number.MAX_SAFE_INTEGER);
  if (chapterDiff !== 0) {
    return chapterDiff;
  }

  const rangeDiff = (getRangeStart(first.range) ?? Number.MAX_SAFE_INTEGER)
    - (getRangeStart(second.range) ?? Number.MAX_SAFE_INTEGER);
  if (rangeDiff !== 0) {
    return rangeDiff;
  }

  return (first.createTime ?? 0) - (second.createTime ?? 0);
}

function getRangeStart(range: string | undefined): number | undefined {
  const start = range?.split("-", 1)[0];
  if (!start) {
    return undefined;
  }

  const value = Number(start);
  return Number.isFinite(value) ? value : undefined;
}

function getReadingStatus(progress: number, finishReading: boolean, isStartReading = false): ReadingStatus {
  if (finishReading || progress >= 100) {
    return "已读完";
  }
  if (progress <= 0 && !isStartReading) {
    return "未开始";
  }
  return "阅读中";
}

function clampProgress(value: number): number {
  if (!Number.isFinite(value)) {
    return 0;
  }
  if (value > 0 && value <= 1) {
    return Math.round(value * 100);
  }
  return Math.min(100, Math.max(0, Math.round(value)));
}

function normalizeProgress(value: number, finishReading: boolean): number {
  return finishReading ? 100 : clampProgress(value);
}

function firstNumber(...values: Array<number | undefined>): number {
  return values.find((value) => typeof value === "number" && Number.isFinite(value)) ?? 0;
}

function firstNumberOrUndefined(...values: Array<number | undefined>): number | undefined {
  return values.find((value) => typeof value === "number" && Number.isFinite(value) && value > 0);
}

function unixSecondsToIso(value: number | undefined): string | undefined {
  if (!value || !Number.isFinite(value)) {
    return undefined;
  }
  return new Date(value * 1000).toISOString();
}

function normalizeCategory(book: BookLike): string | undefined {
  if (Array.isArray(book.categories) && book.categories.length > 0) {
    return emptyToUndefined(book.categories.map(categoryToLabel).filter(Boolean).join(" / "));
  }
  return categoryToLabel(book.category);
}

function normalizeCover(cover: string | undefined): string | undefined {
  if (!cover) {
    return undefined;
  }
  if (cover.startsWith("//")) {
    return `https:${cover}`;
  }
  return cover;
}

function emptyToUndefined(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  return trimmed ? trimmed : undefined;
}

function toStringValue(value: string | number | undefined): string {
  return value === undefined || value === null ? "" : String(value);
}

function categoryToLabel(value: unknown): string | undefined {
  if (typeof value === "string") {
    return emptyToUndefined(value);
  }
  if (typeof value === "number") {
    return String(value);
  }
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  const preferredKeys = ["title", "name", "categoryName", "shortTitle", "label"];
  for (const key of preferredKeys) {
    const label = categoryToLabel(record[key]);
    if (label) {
      return label;
    }
  }

  return undefined;
}

function getErrorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "未知错误";
}

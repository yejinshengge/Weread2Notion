import type { ReadingStatus, WeReadBook, WeReadHighlightNote, WeReadNotebookBook } from "../shared/types";

interface WeReadShelfResponse {
  books?: unknown[];
  bookProgress?: unknown[] | Record<string, unknown>;
  synckey?: number;
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
}

interface ProgressLike {
  bookId?: string | number;
  progress?: number;
  readingProgress?: number;
  finishReading?: boolean | number;
  updateTime?: number;
  startReadingTime?: number;
}

interface WeReadProgressResponse {
  book?: {
    updateTime?: number;
    startReadingTime?: number;
  };
}

interface NotebookBookLike {
  bookId?: string | number;
  book?: BookLike;
  noteCount?: number;
  bookmarkCount?: number;
  reviewCount?: number;
  sort?: number;
}

interface WeReadNotebookResponse {
  books?: unknown[];
}

interface BookmarkLike {
  bookmarkId?: string;
  bookId?: string | number;
  markText?: string;
  chapterUid?: string | number;
  chapterIdx?: number;
  chapterTitle?: string;
  range?: string;
  createTime?: number;
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

interface ChapterInfoLike {
  chapterUid?: string | number;
  chapterIdx?: number;
  title?: string;
  anchors?: ChapterInfoLike[];
}

interface ChapterInfosResponse {
  data?: Array<{
    updated?: ChapterInfoLike[];
  }>;
}

const WEREAD_SHELF_URL = "https://weread.qq.com/web/shelf/sync";
const WEREAD_PROGRESS_URL = "https://weread.qq.com/web/book/getProgress";
const WEREAD_NOTEBOOK_URL = "https://weread.qq.com/api/user/notebook";
const WEREAD_BOOKMARK_LIST_URL = "https://weread.qq.com/api/book/bookmarklist";
const WEREAD_REVIEW_LIST_URL = "https://weread.qq.com/api/review/list";
const WEREAD_CHAPTER_INFOS_URL = "https://weread.qq.com/web/book/chapterInfos";
const READER_URL_PREFIX = "https://weread.qq.com/web/reader/";

export async function fetchWeReadBooks(options: { includeStartReadAt?: boolean } = {}): Promise<WeReadBook[]> {
  const response = await fetch(WEREAD_SHELF_URL, {
    method: "GET",
    credentials: "include",
    headers: {
      Accept: "application/json"
    }
  });

  if (!response.ok) {
    throw new Error("微信读书接口不可用或登录已失效");
  }

  const payload = (await response.json()) as WeReadShelfResponse;
  const books = Array.isArray(payload.books) ? payload.books : [];
  const progressList = normalizeProgressList(payload.bookProgress);
  const progressByBookId = new Map<string, ProgressLike>();

  for (const item of progressList) {
    const progress = item as ProgressLike;
    const bookId = toStringValue(progress.bookId);
    if (bookId) {
      progressByBookId.set(bookId, progress);
    }
  }

  const normalizedBooks = books
    .map((item) => normalizeBook(item as BookLike, progressByBookId))
    .filter((book): book is WeReadBook => Boolean(book));

  return options.includeStartReadAt ? enrichBooksWithProgress(normalizedBooks) : normalizedBooks;
}

export async function enrichBooksWithProgress(books: WeReadBook[]): Promise<WeReadBook[]> {
  const enrichedBooks: WeReadBook[] = [];

  for (const book of books) {
    if (isUnreadBook(book)) {
      enrichedBooks.push({
        ...book,
        startReadAt: undefined,
        lastReadAt: undefined
      });
      continue;
    }

    if (book.startReadAt) {
      enrichedBooks.push(book);
      continue;
    }

    try {
      const progress = await fetchBookProgress(book.bookId);
      enrichedBooks.push({
        ...book,
        startReadAt: unixSecondsToIso(progress.book?.startReadingTime) ?? book.startReadAt,
        lastReadAt: unixSecondsToIso(progress.book?.updateTime) ?? book.lastReadAt
      });
    } catch {
      enrichedBooks.push(book);
    }
  }

  return enrichedBooks;
}

export async function fetchWeReadNotebooks(): Promise<WeReadNotebookBook[]> {
  const response = await fetch(WEREAD_NOTEBOOK_URL, {
    method: "GET",
    credentials: "include",
    headers: {
      Accept: "application/json"
    }
  });

  if (!response.ok) {
    throw new Error("微信读书笔记接口不可用或登录已失效");
  }

  const payload = (await response.json()) as WeReadNotebookResponse;
  const books = Array.isArray(payload.books) ? payload.books : [];

  return books
    .map((item) => normalizeNotebookBook(item as NotebookBookLike))
    .filter((book): book is WeReadNotebookBook => Boolean(book))
    .sort((first, second) => (second.sort ?? 0) - (first.sort ?? 0));
}

export async function fetchWeReadHighlights(bookId: string): Promise<WeReadHighlightNote[]> {
  const [chapterResult, bookmarkResult, reviewResult] = await Promise.allSettled([
    fetchChapterInfo(bookId),
    fetchBookmarkList(bookId),
    fetchReviewList(bookId)
  ]);

  const chapters = chapterResult.status === "fulfilled" ? chapterResult.value : new Map<string, ChapterInfoLike>();
  const bookmarks = bookmarkResult.status === "fulfilled" ? bookmarkResult.value : [];
  const reviews = reviewResult.status === "fulfilled" ? reviewResult.value : [];

  if (bookmarkResult.status === "rejected" && reviewResult.status === "rejected") {
    throw new Error("读取划线和想法失败，请确认微信读书网页版已登录");
  }

  return mergeHighlightNotes(bookId, bookmarks, reviews, chapters);
}

function normalizeBook(book: BookLike, progressByBookId: Map<string, ProgressLike>): WeReadBook | null {
  const bookId = toStringValue(book.bookId);
  const title = book.title || book.name;
  if (!bookId || !title) {
    return null;
  }

  const progressRecord = progressByBookId.get(bookId);
  const progress = clampProgress(
    firstNumber(progressRecord?.progress, progressRecord?.readingProgress, book.progress, book.readingProgress)
  );
  const finishReading = Boolean(progressRecord?.finishReading || book.finishReading);
  const status = getReadingStatus(progress, finishReading);
  const started = status !== "未开始";

  return {
    bookId,
    title,
    cover: normalizeCover(book.cover),
    progress,
    author: emptyToUndefined(book.author),
    category: normalizeCategory(book),
    url: `${READER_URL_PREFIX}${bookId}`,
    status,
    startReadAt: started ? unixSecondsToIso(progressRecord?.startReadingTime) : undefined,
    lastReadAt: started
      ? unixSecondsToIso(firstNumberOrUndefined(progressRecord?.updateTime, book.readUpdateTime))
      : undefined
  };
}

function normalizeNotebookBook(item: NotebookBookLike): WeReadNotebookBook | null {
  const book = item.book;
  const bookId = toStringValue(item.bookId ?? book?.bookId);
  const title = book?.title || book?.name;
  if (!bookId || !title) {
    return null;
  }

  return {
    bookId,
    title,
    cover: normalizeCover(book?.cover),
    author: emptyToUndefined(book?.author),
    url: `${READER_URL_PREFIX}${bookId}`,
    noteCount: firstNumber(item.noteCount),
    bookmarkCount: firstNumber(item.bookmarkCount),
    reviewCount: firstNumber(item.reviewCount),
    sort: firstNumberOrUndefined(item.sort)
  };
}

async function fetchBookProgress(bookId: string): Promise<WeReadProgressResponse> {
  const response = await fetch(`${WEREAD_PROGRESS_URL}?bookId=${encodeURIComponent(bookId)}`, {
    method: "GET",
    credentials: "include",
    headers: {
      Accept: "application/json"
    }
  });

  if (!response.ok) {
    throw new Error(`读取《${bookId}》阅读时间失败`);
  }

  return (await response.json()) as WeReadProgressResponse;
}

async function fetchBookmarkList(bookId: string): Promise<BookmarkLike[]> {
  const response = await fetch(`${WEREAD_BOOKMARK_LIST_URL}?bookId=${encodeURIComponent(bookId)}`, {
    method: "GET",
    credentials: "include",
    headers: {
      Accept: "application/json"
    }
  });

  if (!response.ok) {
    throw new Error(`读取《${bookId}》划线失败`);
  }

  const payload = (await response.json()) as { updated?: unknown[] };
  return Array.isArray(payload.updated) ? (payload.updated as BookmarkLike[]) : [];
}

async function fetchReviewList(bookId: string): Promise<ReviewLike[]> {
  const response = await fetch(
    `${WEREAD_REVIEW_LIST_URL}?bookId=${encodeURIComponent(bookId)}&listType=11&mine=1&synckey=0`,
    {
      method: "GET",
      credentials: "include",
      headers: {
        Accept: "application/json"
      }
    }
  );

  if (!response.ok) {
    throw new Error(`读取《${bookId}》想法失败`);
  }

  const payload = (await response.json()) as { reviews?: unknown[] };
  return Array.isArray(payload.reviews)
    ? payload.reviews.map(unwrapReview).filter((item): item is ReviewLike => Boolean(item))
    : [];
}

async function fetchChapterInfo(bookId: string): Promise<Map<string, ChapterInfoLike>> {
  const response = await fetch(WEREAD_CHAPTER_INFOS_URL, {
    method: "POST",
    credentials: "include",
    headers: {
      Accept: "application/json, text/plain, */*",
      "Content-Type": "application/json;charset=UTF-8"
    },
    body: JSON.stringify({
      bookIds: [bookId],
      synckeys: [0],
      teenmode: 0
    })
  });

  if (!response.ok) {
    throw new Error(`读取《${bookId}》章节失败`);
  }

  const payload = (await response.json()) as ChapterInfosResponse;
  const chapters = new Map<string, ChapterInfoLike>();
  for (const item of payload.data?.[0]?.updated ?? []) {
    addChapter(chapters, item);
    for (const anchor of item.anchors ?? []) {
      addChapter(chapters, anchor);
    }
  }
  return chapters;
}

function addChapter(chapters: Map<string, ChapterInfoLike>, chapter: ChapterInfoLike): void {
  const chapterUid = toStringValue(chapter.chapterUid);
  if (chapterUid) {
    chapters.set(chapterUid, chapter);
  }
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

function mergeHighlightNotes(
  bookId: string,
  bookmarks: BookmarkLike[],
  reviews: ReviewLike[],
  chapters: Map<string, ChapterInfoLike>
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
  chapters: Map<string, ChapterInfoLike>
): WeReadHighlightNote {
  const chapterUid = toStringValue(bookmark.chapterUid);
  const chapter = chapterUid ? chapters.get(chapterUid) : undefined;
  return {
    id: bookmark.bookmarkId || `${bookId}-${chapterUid}-${bookmark.range || bookmark.createTime || "bookmark"}`,
    bookId,
    type: "bookmark",
    chapterUid: emptyToUndefined(chapterUid),
    chapterIdx: firstNumberOrUndefined(bookmark.chapterIdx, chapter?.chapterIdx),
    chapterTitle: emptyToUndefined(bookmark.chapterTitle || chapter?.title),
    original: bookmark.markText?.trim() ?? "",
    range: emptyToUndefined(bookmark.range),
    createTime: firstNumberOrUndefined(bookmark.createTime),
    createdAt: unixSecondsToIso(bookmark.createTime)
  };
}

function buildReviewNote(
  bookId: string,
  review: ReviewLike,
  chapters: Map<string, ChapterInfoLike>
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
    chapterTitle: emptyToUndefined(review.chapterTitle || chapter?.title),
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
  return (first.createTime ?? 0) - (second.createTime ?? 0);
}

function normalizeProgressList(bookProgress: WeReadShelfResponse["bookProgress"]): unknown[] {
  if (Array.isArray(bookProgress)) {
    return bookProgress;
  }
  if (bookProgress && typeof bookProgress === "object") {
    return Object.entries(bookProgress).map(([bookId, value]) => ({
      ...(typeof value === "object" && value !== null ? value : {}),
      bookId
    }));
  }
  return [];
}

function getReadingStatus(progress: number, finishReading: boolean): ReadingStatus {
  if (finishReading || progress >= 100) {
    return "已读完";
  }
  if (progress <= 0) {
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

function isUnreadBook(book: WeReadBook): boolean {
  return book.status === "未开始" || book.progress <= 0;
}

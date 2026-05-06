import type { ReadingStatus, WeReadBook } from "../shared/types";

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

const WEREAD_SHELF_URL = "https://weread.qq.com/web/shelf/sync";
const WEREAD_PROGRESS_URL = "https://weread.qq.com/web/book/getProgress";
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

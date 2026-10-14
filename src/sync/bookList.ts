import type { WeReadBook } from "../shared/types";

type BookSortField = "lastReadAt" | "progress" | "title" | "author";
export type BookSort = `${BookSortField}-${"asc" | "desc"}`;

export const BOOK_SORT_FIELDS: Array<{ value: BookSortField; label: string }> = [
  { value: "lastReadAt", label: "最近阅读时间" },
  { value: "progress", label: "进度" },
  { value: "title", label: "书名" },
  { value: "author", label: "作者" }
];

export const BOOK_SORT_DIRECTIONS: Array<{ value: "asc" | "desc"; label: string }> = [
  { value: "asc", label: "升序" },
  { value: "desc", label: "降序" }
];

const bookCollator = new Intl.Collator("zh-CN", { numeric: true, sensitivity: "base" });

export function getVisibleBooks(
  books: WeReadBook[],
  query = "",
  sort: BookSort = "lastReadAt-desc"
): WeReadBook[] {
  const keyword = normalizeSearchText(query);
  const field = sort.split("-")[0] as BookSortField;
  const direction = sort.endsWith("-asc") ? 1 : -1;

  return books
    .filter((book) =>
      normalizeSearchText(book.title).includes(keyword) || normalizeSearchText(book.author ?? "").includes(keyword)
    )
    .sort((first, second) => {
      const firstValue = getSortValue(first, field);
      const secondValue = getSortValue(second, field);
      if (firstValue === null) {
        return secondValue === null ? 0 : 1;
      }
      if (secondValue === null) {
        return -1;
      }
      const comparison = typeof firstValue === "number" && typeof secondValue === "number"
        ? firstValue - secondValue
        : bookCollator.compare(String(firstValue), String(secondValue));
      return comparison * direction;
    });
}

function normalizeSearchText(value: string): string {
  return value.normalize("NFKC").trim().toLocaleLowerCase("zh-CN");
}

function getSortValue(book: WeReadBook, field: BookSortField): string | number | null {
  if (field === "lastReadAt") {
    const time = book.lastReadAt ? new Date(book.lastReadAt).getTime() : NaN;
    return Number.isFinite(time) ? time : null;
  }
  if (field === "progress") {
    return Number.isFinite(book.progress) ? book.progress : null;
  }
  return book[field]?.trim() || null;
}

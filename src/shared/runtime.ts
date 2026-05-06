import type { BackgroundRequest, BackgroundResponse } from "./types";

export async function sendBackgroundMessage<T>(request: BackgroundRequest): Promise<T> {
  const response = (await chrome.runtime.sendMessage(request)) as BackgroundResponse<T> | undefined;
  if (!response) {
    throw new Error("后台服务未响应");
  }
  if (!response.ok) {
    throw new Error(response.error);
  }
  return response.data;
}

export function openOptionsPage(): void {
  chrome.runtime.openOptionsPage();
}

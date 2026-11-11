import type { ShareContext } from '../types/share';

const SHARE_PATH_REGEX = /^\/s\/([a-zA-Z0-9_-]{1,20})\/?$/;

export function parseShareContext(pathname: string, search: string = ''): ShareContext | null {
  void search;
  const match = pathname.match(SHARE_PATH_REGEX);
  if (!match) {
    return null;
  }

  return {
    shareId: match[1],
  };
}

export function buildShareUrl(baseUrl: string, shareId: string): string {
  return new URL(`/s/${shareId}`, baseUrl).toString();
}

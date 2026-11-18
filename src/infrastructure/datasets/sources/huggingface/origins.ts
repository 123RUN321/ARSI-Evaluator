export const HUGGING_FACE_OFFICIAL_ORIGIN = "https://huggingface.co";

const DEFAULT_HUGGING_FACE_MIRROR = "https://hf-mirror.com";

export function huggingFaceFallbackUrls(url: string, publicMirror?: string): string[] {
  if (url.startsWith(DEFAULT_HUGGING_FACE_MIRROR + "/"))
    return [HUGGING_FACE_OFFICIAL_ORIGIN + url.slice(DEFAULT_HUGGING_FACE_MIRROR.length)];
  if (!publicMirror || publicMirror === HUGGING_FACE_OFFICIAL_ORIGIN || !url.startsWith(publicMirror + "/")) return [];
  const path = url.slice(publicMirror.length);
  return [DEFAULT_HUGGING_FACE_MIRROR + path, HUGGING_FACE_OFFICIAL_ORIGIN + path];
}

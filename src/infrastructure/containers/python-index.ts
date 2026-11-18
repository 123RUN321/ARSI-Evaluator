export type PythonIndexLink = { url: string; filename?: string; sha256?: string; metadata?: true | string };

function record(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

function hash(value: unknown): string | undefined {
  const digest = record(value)?.sha256;
  return typeof digest === "string" && /^[a-f0-9]{64}$/iu.test(digest) ? digest.toLowerCase() : undefined;
}

function htmlAttribute(value: string): string {
  const named: Record<string, string> = { amp: "&", quot: '"', apos: "'", lt: "<", gt: ">" };
  return value.replace(/&(?:amp|quot|apos|lt|gt|#\d{1,7}|#x[a-f0-9]{1,6});/giu, entity => {
    const code = entity.slice(1, -1).toLowerCase();
    const character = named[code];
    if (character) return character;
    const number = code.startsWith("#x") ? Number.parseInt(code.slice(2), 16) : Number(code.slice(1));
    return number > 0 && number <= 0x10ffff ? String.fromCodePoint(number) : entity;
  });
}

/** Preserve both Simple API representations, including per-file metadata and selection attributes. */
export function rewritePythonIndex(contents: string, replace: (link: PythonIndexLink) => string | undefined): string {
  if (contents.trimStart().startsWith("{")) {
    const page = record(JSON.parse(contents));
    if (!page || !Array.isArray(page.files)) throw new Error("Invalid Python Simple API project response");
    for (const entry of page.files as unknown[]) {
      const file = record(entry);
      if (!file || typeof file.url !== "string") continue;
      const sha256 = hash(file.hashes);
      const core = file["core-metadata"] ?? file["dist-info-metadata"] ?? file["data-dist-info-metadata"];
      const metadata = hash(core) ?? (core === true ? true : undefined);
      const replacement = replace({ url: file.url,
        ...(typeof file.filename === "string" ? { filename: file.filename } : {}),
        ...(sha256 ? { sha256 } : {}), ...(metadata ? { metadata } : {}) });
      if (replacement !== undefined) file.url = replacement;
    }
    return JSON.stringify(page);
  }
  return contents.replace(/<a(?=\s|>)(?:[^"'<>]|"[^"]*"|'[^']*')*>/giu, tag => {
    const metadataAttribute = /\sdata-(?:core|dist-info)-metadata\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'<>]+))/iu.exec(tag);
    const value = metadataAttribute?.[1] ?? metadataAttribute?.[2] ?? metadataAttribute?.[3];
    const digest = /^sha256=([a-f0-9]{64})$/iu.exec(value ?? "")?.[1]?.toLowerCase();
    const metadata = digest ?? (value?.toLowerCase() === "true" ? true : undefined);
    return tag.replace(/(\shref\s*=\s*)(?:"([^"]*)"|'([^']*)'|([^\s"'<>]+))/iu, (attribute: string, prefix: string,
      double: string | undefined, single: string | undefined, unquoted: string | undefined) => {
      const url = htmlAttribute(double ?? single ?? unquoted ?? "");
      const sha256 = /#sha256=([a-f0-9]{64})$/iu.exec(url)?.[1]?.toLowerCase();
      const replacement = replace({ url, ...(sha256 ? { sha256 } : {}), ...(metadata ? { metadata } : {}) });
      return replacement === undefined ? attribute : prefix + '"' + replacement.replaceAll("&", "&amp;").replaceAll('"', "&quot;") + '"';
    });
  });
}

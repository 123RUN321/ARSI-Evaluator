import type { AptSources } from "../../core/contracts/network.js";

/** Bootstrap CA trust using signed APT packages before selecting an HTTPS mirror. */
export function aptSourceInstructions(sources: AptSources): string[] {
  // Fill only unset options. Existing image configuration and later task
  // settings, including apt-get -o arguments, keep their explicit values.
  const defaults = [
    ["Acquire::Retries", "3"],
    ["Acquire::http::Timeout", "30"],
    ["Acquire::https::Timeout", "30"],
    ["APT::Update::Error-Mode", "any"],
  ].map(([key, value]) =>
    `configured=$(apt-config shell evaluator_value ${key}) || exit $?; if [ -z "$configured" ]; then printf '%s\\n' '${key} "${value}";' >> /etc/apt/apt.conf.d/00-evaluator-network-defaults; fi`).join("; ");
  const downloads = `RUN if command -v apt-get >/dev/null 2>&1 && [ "$(id -u)" = 0 ]; then mkdir -p /etc/apt/apt.conf.d; ${defaults}; fi`;
  const repositories: [keyof AptSources, string][] = [
    ["debianSecurity", "https\\?://deb\\.debian\\.org/debian-security"],
    ["debianSecurity", "https\\?://security\\.debian\\.org/debian-security"],
    ["debian", "https\\?://deb\\.debian\\.org/debian"],
    ["ubuntu", "https\\?://archive\\.ubuntu\\.com/ubuntu"],
    ["ubuntu", "https\\?://[[:alnum:].-]*\\.archive\\.ubuntu\\.com/ubuntu"],
    ["ubuntuSecurity", "https\\?://security\\.ubuntu\\.com/ubuntu"],
    ["ubuntuPorts", "https\\?://ports\\.ubuntu\\.com/ubuntu-ports"],
  ];
  const official: Record<keyof AptSources, string> = {
    debian: "deb.debian.org/debian",
    debianSecurity: "deb.debian.org/debian-security",
    ubuntu: "archive.ubuntu.com/ubuntu",
    ubuntuSecurity: "security.ubuntu.com/ubuntu",
    ubuntuPorts: "ports.ubuntu.com/ubuntu-ports",
  };
  const repositoryPaths: Record<keyof AptSources, string> = {
    debian: "debian", debianSecurity: "debian-security",
    ubuntu: "ubuntu", ubuntuSecurity: "ubuntu", ubuntuPorts: "ubuntu-ports",
  };
  const escapePattern = (value: string) => value.replace(/[.*[\]^$\\]/gu, "\\$&");
  const rewrite = (bootstrap: boolean) => {
    const directory = "/etc/apt/evaluator-mirrors";
    const lists: string[] = [];
    const aliases = new Map<string, keyof AptSources>();
    for (const key of Object.keys(official) as (keyof AptSources)[]) {
      const configured = sources[key];
      if (!configured) continue;
      const http = configured.replace(/^https:/u, "http:");
      const primary = bootstrap ? http : configured;
      const scheme = primary.startsWith("https:") ? "https" : "http";
      const upstream = `${scheme}://${official[key]}`;
      const repositoryMirror = `${scheme}://mirrors.aliyun.com/${repositoryPaths[key]}`;
      const entries = primary === upstream ? [primary] : [...new Set([primary, repositoryMirror, upstream])];
      lists.push(`printf '%s\\n' ${entries.map((url, index) => `'${url}/'"$(printf '\\t')"'priority:${index + 1}'`).join(" ")} > ${directory}/${key}.list`);
      for (const alias of [configured, http]) if (!aliases.has(alias)) aliases.set(alias, key);
    }
    if (!lists.length) return ":";
    const patterns = [...repositories.filter(([key]) => sources[key]),
      ...[...aliases].map(([url, key]) => [key, escapePattern(url)] as const)];
    const replacements = patterns.map(([key, pattern]) =>
      `-e 's#${pattern}\\(/\\)\\?\\([[:space:]]\\|$\\)#mirror+file:${directory}/${key}.list\\2#g'`);
    return `if command -v apt-get >/dev/null 2>&1 && [ "$(id -u)" = 0 ]; then mkdir -p ${directory} && ${lists.join(" && ")} && for list in /etc/apt/sources.list /etc/apt/sources.list.d/*.list /etc/apt/sources.list.d/*.sources; do if [ -f "$list" ]; then sed -i ${replacements.join(" ")} "$list" || exit $?; fi; done; fi`;
  };
  if (!Object.values(sources).some(value => value.startsWith("https:"))) return [downloads, ...(Object.keys(sources).length ? [`RUN ${rewrite(false)}`] : [])];
  return [
    downloads,
    `RUN if command -v apt-get >/dev/null 2>&1 && [ "$(id -u)" = 0 ] && [ ! -s /etc/ssl/certs/ca-certificates.crt ]; then ${rewrite(true)} && apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*; fi`,
    `RUN ${rewrite(false)}`,
  ];
}

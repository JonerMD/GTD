import { App, TFile } from "obsidian";

export const GTD_FOLDER = "GTD";
export const PROJECTS_FOLDER = "GTD/Projects";
export const INBOX_PATH = "GTD/Inbox.md";
export const SINGLE_TASKS_PATH = "GTD/SingleTasks.md";
export const COMPLETED_LOG = "GTD/Completed.md";
export const DROPPED_LOG = "GTD/Dropped.md";
export const SOMEDAY_LOG = "GTD/Someday.md";
export const ARCHIVE_PROJECTS_FOLDER = "GTD/Archive/Projects";
export const ARCHIVE_DROPPED_FOLDER = "GTD/Archive/Dropped";

export type ProjectStatus =
  | "active"
  | "awaiting"
  | "completed"
  | "dropped"
  | "someday";

/** Returnerer dagens dato som "YYYY-MM-DD" i lokal tidszone. */
export function todayISO(): string {
  const d = new Date();
  const yyyy = d.getFullYear();
  const mm = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${yyyy}-${mm}-${dd}`;
}

export function currentYear(): string {
  return String(new Date().getFullYear());
}

/** Slug et projektnavn til et lovligt filnavn (uden specialtegn / slashes). */
export function safeFileName(name: string): string {
  return name
    .trim()
    .replace(/[\\/:*?"<>|#^[\]]/g, "")
    .replace(/\s+/g, " ")
    .slice(0, 120);
}

/** Tjek om en fil er et "tomt" projekt — kun frontmatter, headings, tasks, blank linjer. */
export function isProjectFileEmpty(content: string): boolean {
  const lines = content.split("\n");
  let inFrontmatter = false;
  let sawFrontmatterStart = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const trimmed = line.trim();

    if (i === 0 && trimmed === "---") {
      inFrontmatter = true;
      sawFrontmatterStart = true;
      continue;
    }
    if (inFrontmatter && trimmed === "---") {
      inFrontmatter = false;
      continue;
    }
    if (inFrontmatter) continue;

    if (trimmed === "") continue;
    if (/^#{1,6}\s+/.test(trimmed)) continue;
    if (/^-\s*\[[ xX/\-]\]\s/.test(trimmed)) continue;
    if (trimmed === "---") continue;

    return false;
  }
  return true;
}

/** Hent gtd-status fra frontmatter — eller undefined hvis ikke sat. */
export function getGtdStatus(
  app: App,
  file: TFile
): ProjectStatus | undefined {
  const cache = app.metadataCache.getFileCache(file);
  const status = cache?.frontmatter?.["gtd-status"];
  if (
    status === "active" ||
    status === "awaiting" ||
    status === "completed" ||
    status === "dropped" ||
    status === "someday"
  ) {
    return status;
  }
  return undefined;
}

/** Returnerer true hvis filen tæller som et aktivt projekt. */
export function isActiveProject(app: App, file: TFile): boolean {
  const status = getGtdStatus(app, file);
  if (status === "active") return true;
  // Fallback: filer i GTD/Projects/ uden eksplicit status behandles som aktive
  if (status === undefined && file.path.startsWith(PROJECTS_FOLDER + "/")) {
    return true;
  }
  return false;
}

/** Returnerer true hvis filen er en task-kilde for views (Inbox, SingleTasks, eller aktivt projekt). */
export function isGtdTaskSource(app: App, file: TFile): boolean {
  if (file.path === INBOX_PATH) return true;
  if (file.path === SINGLE_TASKS_PATH) return true;
  return isActiveProject(app, file);
}

/** Sikre at SingleTasks.md eksisterer. */
export async function ensureSingleTasksFile(app: App): Promise<TFile> {
  const existing = app.vault.getAbstractFileByPath(SINGLE_TASKS_PATH);
  if (existing instanceof TFile) return existing;
  await ensureFolder(app, GTD_FOLDER);
  const initial =
    "# Single Tasks\n\n" +
    "Standalone opgaver der ikke hører til et projekt. " +
    "Hver linje er en task med valgfri due (📅), defer (⏳) og tags (#).\n\n";
  return await app.vault.create(SINGLE_TASKS_PATH, initial);
}

/** Append en single-task linje. Opretter fil hvis nødvendigt. */
export async function appendSingleTask(
  app: App,
  data: {
    text: string;
    dueDate?: string;
    deferDate?: string;
    tags?: string[];
  }
): Promise<void> {
  const file = await ensureSingleTasksFile(app);
  const parts: string[] = ["- [ ]", data.text];
  if (data.tags && data.tags.length > 0) {
    parts.push(data.tags.map((t) => `#${t}`).join(" "));
  }
  if (data.dueDate) parts.push(`📅 ${data.dueDate}`);
  if (data.deferDate) parts.push(`⏳ ${data.deferDate}`);
  parts.push(`➕ ${todayISO()}`);
  const line = parts.join(" ");

  const current = await app.vault.read(file);
  const needsNewline = current.length > 0 && !current.endsWith("\n");
  const next = current + (needsNewline ? "\n" : "") + line + "\n";
  await app.vault.modify(file, next);
}

/** Skabelon til et nyt projekt. */
export function projectTemplate(name: string): string {
  return (
    "---\n" +
    "gtd-status: active\n" +
    `gtd-created: ${todayISO()}\n` +
    "---\n\n" +
    `# ${name}\n\n`
  );
}

/** Tilføj en linje til en log-fil (Completed.md, Dropped.md, Someday.md). Opretter fil hvis nødvendigt. */
export async function appendToLog(
  app: App,
  logPath: string,
  logTitle: string,
  line: string
): Promise<void> {
  let file = app.vault.getAbstractFileByPath(logPath);
  if (!file) {
    await ensureFolder(app, GTD_FOLDER);
    file = await app.vault.create(logPath, `# ${logTitle}\n\n`);
  }
  if (!(file instanceof TFile)) return;
  const current = await app.vault.read(file);
  const needsNewline = current.length > 0 && !current.endsWith("\n");
  const next = current + (needsNewline ? "\n" : "") + line + "\n";
  await app.vault.modify(file, next);
}

export async function ensureFolder(app: App, path: string): Promise<void> {
  const existing = app.vault.getAbstractFileByPath(path);
  if (existing) return;
  // createFolder opretter mellem-mapper rekursivt
  await app.vault.createFolder(path);
}

/** Opdater eller tilføj YAML-frontmatter-felter. Bevarer eksisterende felter. */
export function setFrontmatterFields(
  content: string,
  fields: Record<string, string>
): string {
  const fmMatch = content.match(/^---\n([\s\S]*?)\n---\n?/);
  if (!fmMatch) {
    const yaml = Object.entries(fields)
      .map(([k, v]) => `${k}: ${v}`)
      .join("\n");
    return `---\n${yaml}\n---\n\n${content}`;
  }

  const fmBody = fmMatch[1];
  const restStart = fmMatch[0].length;
  const rest = content.slice(restStart);

  const lines = fmBody.split("\n");
  const keysSet = new Set(Object.keys(fields));
  const updated: string[] = [];

  for (const line of lines) {
    const keyMatch = line.match(/^([a-zA-Z0-9_\-]+):/);
    if (keyMatch && keysSet.has(keyMatch[1])) {
      const val = fields[keyMatch[1]];
      if (val === "") {
        // Tom værdi = fjern feltet
        keysSet.delete(keyMatch[1]);
        continue;
      }
      updated.push(`${keyMatch[1]}: ${val}`);
      keysSet.delete(keyMatch[1]);
    } else {
      updated.push(line);
    }
  }
  for (const key of keysSet) {
    if (fields[key] === "") continue;
    updated.push(`${key}: ${fields[key]}`);
  }

  return `---\n${updated.join("\n")}\n---\n${rest.startsWith("\n") ? rest : "\n" + rest}`;
}

/** Hent et frontmatter-felt fra fil-cache som streng. */
export function getFrontmatterString(
  app: App,
  file: TFile,
  key: string
): string | undefined {
  const cache = app.metadataCache.getFileCache(file);
  const value = cache?.frontmatter?.[key];
  if (value === undefined || value === null) return undefined;
  return String(value);
}

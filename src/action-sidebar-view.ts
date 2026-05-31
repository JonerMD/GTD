import { ItemView, TFile, WorkspaceLeaf, debounce } from "obsidian";
import {
  Task,
  assignParents,
  isBlockedByAncestor,
  parseTaskLine,
} from "./task";
import { TaskEditModal, isTaskAwaitingTagged } from "./task-edit-modal";
import {
  INBOX_PATH,
  PROJECTS_FOLDER,
  ProjectStatus,
  SINGLE_TASKS_PATH,
  getFrontmatterString,
  getGtdStatus,
  todayISO,
} from "./project-utils";

export const VIEW_TYPE_ACTION_SIDEBAR = "joner-gtd-action-sidebar";

/** Kompakt sidebar der altid viser alle åbne tasks + afventende projekter. */
const COLLAPSED_STORAGE_KEY = "joner-gtd:sidebar-collapsed";

export class ActionSidebarView extends ItemView {
  private readonly debouncedRender = debounce(
    () => void this.render(),
    250,
    true
  );
  private collapsedSections = new Set<string>();

  constructor(leaf: WorkspaceLeaf) {
    super(leaf);
    this.loadCollapsedState();
  }

  private loadCollapsedState(): void {
    try {
      const raw = window.localStorage.getItem(COLLAPSED_STORAGE_KEY);
      if (raw) {
        const arr = JSON.parse(raw);
        if (Array.isArray(arr)) {
          this.collapsedSections = new Set(arr.filter((x) => typeof x === "string"));
        }
      }
    } catch {
      // ignore
    }
  }

  private saveCollapsedState(): void {
    try {
      window.localStorage.setItem(
        COLLAPSED_STORAGE_KEY,
        JSON.stringify(Array.from(this.collapsedSections))
      );
    } catch {
      // ignore
    }
  }

  private toggleSection(key: string): void {
    if (this.collapsedSections.has(key)) {
      this.collapsedSections.delete(key);
    } else {
      this.collapsedSections.add(key);
    }
    this.saveCollapsedState();
    void this.render();
  }

  private renderSectionHeader(
    parent: HTMLElement,
    key: string,
    label: string,
    count: number
  ): HTMLElement {
    const section = parent.createDiv({ cls: "gtd-as-section" });
    if (this.collapsedSections.has(key)) section.addClass("is-collapsed");

    const header = section.createEl("h4", { cls: "gtd-as-section-header" });
    header.createSpan({ text: "▼", cls: "gtd-as-section-chevron" });
    header.createSpan({ text: `${label} (${count})` });
    header.onclick = () => this.toggleSection(key);

    return section;
  }

  getViewType(): string {
    return VIEW_TYPE_ACTION_SIDEBAR;
  }

  getDisplayText(): string {
    return "GTD: Næste & Afventer";
  }

  getIcon(): string {
    return "list-checks";
  }

  async onOpen(): Promise<void> {
    await this.render();
    this.registerEvent(
      this.app.vault.on("modify", () => this.debouncedRender())
    );
    this.registerEvent(
      this.app.vault.on("create", () => this.debouncedRender())
    );
    this.registerEvent(
      this.app.vault.on("delete", () => this.debouncedRender())
    );
    this.registerEvent(
      this.app.vault.on("rename", () => this.debouncedRender())
    );
    this.registerEvent(
      this.app.metadataCache.on("changed", () => this.debouncedRender())
    );
  }

  async onClose(): Promise<void> {}

  private async render(): Promise<void> {
    const root = this.containerEl.children[1] as HTMLElement;
    root.empty();
    root.addClass("gtd-action-sidebar");

    const activeFiles = this.findFilesByStatus(["active"]);
    const awaitingFiles = this.findFilesByStatus(["awaiting"]);

    // Saml alle actionable tasks (åbne, ikke-defererede, ikke parent-blokerede)
    const tasks: Task[] = [];
    const inbox = this.app.vault.getAbstractFileByPath(INBOX_PATH);
    if (inbox instanceof TFile) {
      const t = await this.tasksInFile(inbox);
      for (const task of t) {
        if (this.isActionable(task, t)) tasks.push(task);
      }
    }
    for (const file of activeFiles) {
      const t = await this.tasksInFile(file);
      for (const task of t) {
        if (this.isActionable(task, t)) tasks.push(task);
      }
    }

    // Single Tasks (separat sektion)
    const singleTasks: Task[] = [];
    const singlesFile = this.app.vault.getAbstractFileByPath(SINGLE_TASKS_PATH);
    if (singlesFile instanceof TFile) {
      const t = await this.tasksInFile(singlesFile);
      for (const task of t) {
        if (this.isActionable(task, t)) singleTasks.push(task);
      }
    }

    // Tasks med awaiting-tag (på tværs af alle åbne tasks vi har samlet)
    // — inkluderer åbne tasks selv hvis de er parent-blokerede, så længe de er tagget
    const awaitingTaggedTasks: Task[] = [];
    const checkForAwaitingTag = (taskList: Task[]) => {
      for (const t of taskList) {
        if (t.done) continue;
        if (isTaskAwaitingTagged(t)) awaitingTaggedTasks.push(t);
      }
    };
    if (inbox instanceof TFile) {
      checkForAwaitingTag(await this.tasksInFile(inbox));
    }
    for (const file of activeFiles) {
      checkForAwaitingTag(await this.tasksInFile(file));
    }
    if (singlesFile instanceof TFile) {
      checkForAwaitingTag(await this.tasksInFile(singlesFile));
    }
    // Også fra afventende projekter (kunne være tasks med #afventer indeni)
    for (const file of awaitingFiles) {
      checkForAwaitingTag(await this.tasksInFile(file));
    }
    // Sortér efter projekt-navn så det er forudsigeligt
    awaitingTaggedTasks.sort((a, b) =>
      a.file.basename.localeCompare(b.file.basename, "da")
    );

    // Sortér: Inbox først, så alfabetisk pr. projekt
    tasks.sort((a, b) => {
      const aIsInbox = a.file.path === INBOX_PATH;
      const bIsInbox = b.file.path === INBOX_PATH;
      if (aIsInbox !== bIsInbox) return aIsInbox ? -1 : 1;
      const projCmp = a.file.basename.localeCompare(b.file.basename, "da");
      if (projCmp !== 0) return projCmp;
      return a.lineNumber - b.lineNumber;
    });

    // SEKTION: Næste handlinger
    const sec1 = this.renderSectionHeader(
      root,
      "next",
      "📌 Næste handlinger",
      tasks.length
    );
    const sec1Content = sec1.createDiv({ cls: "gtd-as-section-content" });
    if (tasks.length === 0) {
      sec1Content.createDiv({ text: "Intet at gøre. 🎉", cls: "gtd-as-empty" });
    } else {
      for (const task of tasks) {
        this.renderTaskRow(sec1Content, task);
      }
    }

    // SEKTION: Single Tasks
    const secSingle = this.renderSectionHeader(
      root,
      "singles",
      "🎯 Single Tasks",
      singleTasks.length
    );
    const secSingleContent = secSingle.createDiv({
      cls: "gtd-as-section-content",
    });
    if (singleTasks.length === 0) {
      secSingleContent.createDiv({
        text: "Ingen standalone tasks.",
        cls: "gtd-as-empty",
      });
    } else {
      singleTasks.sort((a, b) => {
        const aDue = a.dueDate ?? "9999-99-99";
        const bDue = b.dueDate ?? "9999-99-99";
        return aDue.localeCompare(bDue);
      });
      for (const task of singleTasks) {
        this.renderTaskRow(secSingleContent, task);
      }
    }

    // SEKTION: Afventer svar (PROJEKTER)
    awaitingFiles.sort((a, b) =>
      a.basename.localeCompare(b.basename, "da")
    );
    const sec2 = this.renderSectionHeader(
      root,
      "awaiting",
      "⏳ Afventer svar (projekter)",
      awaitingFiles.length
    );
    const sec2Content = sec2.createDiv({ cls: "gtd-as-section-content" });
    if (awaitingFiles.length === 0) {
      sec2Content.createDiv({
        text: "Intet at vente på.",
        cls: "gtd-as-empty",
      });
    } else {
      for (const file of awaitingFiles) {
        this.renderAwaitingRow(sec2Content, file);
      }
    }

    // SEKTION: Afventer-taggede tasks (#afventer / #awaiting)
    const sec3 = this.renderSectionHeader(
      root,
      "awaitingTasks",
      "🏷 Afventer (tasks)",
      awaitingTaggedTasks.length
    );
    const sec3Content = sec3.createDiv({ cls: "gtd-as-section-content" });
    if (awaitingTaggedTasks.length === 0) {
      sec3Content.createDiv({
        text: "Ingen tasks med #afventer-tag.",
        cls: "gtd-as-empty",
      });
    } else {
      for (const task of awaitingTaggedTasks) {
        this.renderTaskRow(sec3Content, task);
      }
    }
  }

  private renderTaskRow(parent: HTMLElement, task: Task): void {
    const row = parent.createDiv({ cls: "gtd-as-task" });

    const cb = row.createEl("input", {
      type: "checkbox",
      cls: "gtd-as-checkbox",
    });
    cb.checked = task.done;
    cb.onclick = (e: MouseEvent) => {
      e.stopPropagation();
      void this.toggleTaskDone(task);
    };

    const body = row.createDiv({ cls: "gtd-as-task-body" });
    const text = body.createDiv({ text: task.text, cls: "gtd-as-task-text" });
    text.onclick = () => new TaskEditModal(this.app, task).open();

    const metaParts: string[] = [];
    metaParts.push(
      task.file.path === INBOX_PATH ? "Inbox" : task.file.basename
    );
    for (const tag of task.tags) metaParts.push(`#${tag}`);
    if (task.dueDate) metaParts.push(`📅 ${task.dueDate}`);
    body.createDiv({ text: metaParts.join(" · "), cls: "gtd-as-task-meta" });
  }

  private renderAwaitingRow(parent: HTMLElement, file: TFile): void {
    const row = parent.createDiv({ cls: "gtd-as-awaiting" });
    row.createDiv({ text: file.basename, cls: "gtd-as-task-text" });
    const since = getFrontmatterString(this.app, file, "gtd-awaiting-since");
    if (since) {
      row.createDiv({ text: `siden ${since}`, cls: "gtd-as-task-meta" });
    }
    row.onclick = () => {
      void this.app.workspace.getLeaf(false).openFile(file);
    };
  }

  /* ===== Helpers (duplicated minimally for at holde view selvstændig) ===== */

  private findFilesByStatus(statuses: ProjectStatus[]): TFile[] {
    const result: TFile[] = [];
    for (const file of this.app.vault.getMarkdownFiles()) {
      const status = getGtdStatus(this.app, file);
      if (status !== undefined && (statuses as string[]).includes(status)) {
        result.push(file);
        continue;
      }
      if (
        status === undefined &&
        (statuses as string[]).includes("active") &&
        file.path.startsWith(PROJECTS_FOLDER + "/")
      ) {
        result.push(file);
      }
    }
    return result;
  }

  private async tasksInFile(file: TFile): Promise<Task[]> {
    const content = await this.app.vault.read(file);
    const lines = content.split("\n");
    const tasks: Task[] = [];
    for (let i = 0; i < lines.length; i++) {
      const parsed = parseTaskLine(lines[i], file, i);
      if (parsed) tasks.push(parsed);
    }
    assignParents(tasks);
    return tasks;
  }

  private isTaskDeferred(task: Task): boolean {
    if (!task.deferDate) return false;
    return task.deferDate > todayISO();
  }

  private isActionable(task: Task, allTasks: Task[]): boolean {
    if (task.done) return false;
    if (this.isTaskDeferred(task)) return false;
    if (isBlockedByAncestor(task, allTasks)) return false;
    return true;
  }

  private async toggleTaskDone(task: Task): Promise<void> {
    const content = await this.app.vault.read(task.file);
    const lines = content.split("\n");
    const line = lines[task.lineNumber];
    if (!line) return;
    const newLine = task.done
      ? line.replace(/-\s*\[[xX]\]/, "- [ ]")
      : line.replace(/-\s*\[\s\]/, "- [x]");
    lines[task.lineNumber] = newLine;
    await this.app.vault.modify(task.file, lines.join("\n"));
  }

  private async openTaskSource(task: Task): Promise<void> {
    const leaf = this.app.workspace.getLeaf(false);
    await leaf.openFile(task.file, { eState: { line: task.lineNumber } });
  }
}

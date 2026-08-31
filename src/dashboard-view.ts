import {
  App,
  ItemView,
  Modal,
  Notice,
  Platform,
  TFile,
  TFolder,
  WorkspaceLeaf,
  debounce,
} from "obsidian";
import {
  Task,
  assignParents,
  isBlockedByAncestor,
  parseTaskLine,
} from "./task";
import { TaskEditModal } from "./task-edit-modal";
import {
  COMPLETED_LOG,
  DROPPED_LOG,
  INBOX_PATH,
  PROJECTS_FOLDER,
  ProjectStatus,
  SINGLE_TASKS_PATH,
  SOMEDAY_LOG,
  appendSingleTask,
  appendSomedayItem,
  appendToLog,
  currentYear,
  ensureFolder,
  ensureSingleTasksFile,
  ensureSomedayFile,
  getFrontmatterString,
  getGtdStatus,
  getNoteSection,
  isProjectFileEmpty,
  parseDateExpression,
  projectTemplate,
  safeFileName,
  setFrontmatterFields,
  setNoteSection,
  todayISO,
} from "./project-utils";
import { CalendarService, ParsedEvent } from "./calendar-service";
import { CALENDAR_UPDATED_EVENT } from "./main";

export const VIEW_TYPE_DASHBOARD = "joner-gtd-dashboard";

type Perspective =
  | "naeste"
  | "inbox"
  | "singles"
  | "forecast"
  | "projects"
  | "tags"
  | "defer"
  | "review"
  | "someday"
  | "archive";

interface ForecastGtdItem {
  kind: "due" | "planned" | "defer-exp";
  source: "project" | "single";
  label: string;
  projectLabel: string;
  file: TFile;
  task?: Task;
  /** Den dato dette item er associeret med (YYYY-MM-DD). Bruges til past-due-visning. */
  date: string;
}

interface ForecastData {
  pastDue: ForecastGtdItem[];
  byDate: Map<string, ForecastGtdItem[]>;
}

interface TreeNode {
  kind: "folder" | "project";
  name: string;
  path: string;
  file?: TFile;
  children?: TreeNode[];
  openTasks?: number;
}

interface DashboardCallbacks {
  /** Vis modal til nyt projekt. Returnerer den nye fils path eller null. */
  onNewProject(): Promise<string | null>;
  getCalendarService(): CalendarService;
  refreshCalendars(force?: boolean): Promise<void>;
  getForecastDays(): number;
  hasCalendarSources(): boolean;
  openSettings(): void;
}

export class DashboardView extends ItemView {
  private readonly callbacks: DashboardCallbacks;

  private currentPerspective: Perspective = "naeste";
  private selectedProjectPath: string | null = null;
  private selectedTag: string | null = null;
  private collapsedFolders = new Set<string>();
  private collapsedTasks = new Set<string>();

  private readonly debouncedRender = debounce(
    () => void this.render(),
    200,
    true
  );

  constructor(leaf: WorkspaceLeaf, callbacks: DashboardCallbacks) {
    super(leaf);
    this.callbacks = callbacks;
    this.loadCollapsedTasks();
  }

  private loadCollapsedTasks(): void {
    try {
      const raw = window.localStorage.getItem("joner-gtd:collapsed-tasks");
      if (raw) {
        const arr = JSON.parse(raw);
        if (Array.isArray(arr)) {
          this.collapsedTasks = new Set(
            arr.filter((x) => typeof x === "string")
          );
        }
      }
    } catch {
      // ignore
    }
  }

  private saveCollapsedTasks(): void {
    try {
      window.localStorage.setItem(
        "joner-gtd:collapsed-tasks",
        JSON.stringify(Array.from(this.collapsedTasks))
      );
    } catch {
      // ignore
    }
  }

  private taskKey(task: Task): string {
    return `${task.file.path}::${task.text}`;
  }

  getViewType(): string {
    return VIEW_TYPE_DASHBOARD;
  }

  getDisplayText(): string {
    return "GTD";
  }

  getIcon(): string {
    return "check-circle-2";
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
      this.app.vault.on("delete", (f) => {
        if (this.selectedProjectPath === f.path) {
          this.selectedProjectPath = null;
        }
        this.debouncedRender();
      })
    );
    this.registerEvent(
      this.app.vault.on("rename", (f, oldPath) => {
        if (this.selectedProjectPath === oldPath) {
          this.selectedProjectPath = f.path;
        }
        this.debouncedRender();
      })
    );
    this.registerEvent(
      this.app.metadataCache.on("changed", () => this.debouncedRender())
    );
    // Re-render når kalender-data opdateres
    this.registerEvent(
      this.app.workspace.on(
        CALENDAR_UPDATED_EVENT as any,
        () => this.debouncedRender()
      )
    );
  }

  async onClose(): Promise<void> {}

  /* ============================================================
     RENDER
     ============================================================ */

  private async render(): Promise<void> {
    const root = this.containerEl.children[1] as HTMLElement;
    root.empty();
    root.addClass("gtd-dashboard");

    const toolbar = root.createDiv({ cls: "gtd-toolbar" });
    await this.renderToolbar(toolbar);

    if (Platform.isPhone) {
      await this.renderMobileBody(root);
      return;
    }

    const body = root.createDiv({ cls: "gtd-body" });

    const showSidebar =
      this.currentPerspective !== "inbox" &&
      this.currentPerspective !== "naeste" &&
      this.currentPerspective !== "forecast" &&
      this.currentPerspective !== "review" &&
      this.currentPerspective !== "defer" &&
      this.currentPerspective !== "singles";
    const showInspector =
      (this.currentPerspective === "projects" ||
        this.currentPerspective === "someday" ||
        this.currentPerspective === "archive") &&
      this.selectedProjectPath !== null;

    if (!showSidebar) body.addClass("no-sidebar");
    if (!showInspector) body.addClass("no-inspector");

    if (showSidebar) {
      const sidebar = body.createDiv({ cls: "gtd-sidebar" });
      await this.renderSidebar(sidebar);
    } else {
      // Tom placeholder for layout-balance
      body.createDiv({ cls: "gtd-sidebar" });
    }

    const main = body.createDiv({ cls: "gtd-main" });
    await this.renderMain(main);

    const inspector = body.createDiv({ cls: "gtd-inspector" });
    if (showInspector) {
      const file = this.app.vault.getAbstractFileByPath(
        this.selectedProjectPath!
      );
      if (file instanceof TFile) {
        await this.renderInspector(inspector, file);
      }
    }
  }

  /* ============================================================
     MOBIL-LAYOUT — én kolonne ad gangen (iPhone)
     ============================================================ */

  private async renderMobileBody(root: HTMLElement): Promise<void> {
    const body = root.createDiv({ cls: "gtd-body gtd-mobile" });

    const p = this.currentPerspective;
    const usesSidebar =
      p === "projects" || p === "someday" || p === "archive" || p === "tags";

    // DETAIL-mode: et projekt (eller tag) er valgt → vis tilbage-knap + indhold
    const inDetail =
      (usesSidebar && p !== "tags" && this.selectedProjectPath !== null) ||
      (p === "tags" && this.selectedTag !== null);

    if (usesSidebar && inDetail) {
      // Tilbage-knap
      const back = body.createDiv({ cls: "gtd-mobile-back" });
      back.setText("← Tilbage til listen");
      back.onclick = () => {
        this.selectedProjectPath = null;
        this.selectedTag = null;
        void this.render();
      };

      const main = body.createDiv({ cls: "gtd-main gtd-mobile-main" });
      await this.renderMain(main);

      // Inspector stakket under (kun projekt-perspektiver)
      if (
        (p === "projects" || p === "someday" || p === "archive") &&
        this.selectedProjectPath !== null
      ) {
        const file = this.app.vault.getAbstractFileByPath(
          this.selectedProjectPath
        );
        if (file instanceof TFile) {
          const inspector = body.createDiv({
            cls: "gtd-inspector gtd-mobile-inspector",
          });
          await this.renderInspector(inspector, file);
        }
      }
      return;
    }

    if (usesSidebar) {
      // LIST-mode: vis listen fuld bredde
      const sidebar = body.createDiv({ cls: "gtd-sidebar gtd-mobile-sidebar" });
      await this.renderSidebar(sidebar);
      // Someday: vis også den lette liste under de parkerede projekter
      if (p === "someday") {
        const main = body.createDiv({ cls: "gtd-main gtd-mobile-main" });
        await this.renderSomedayMain(main);
      }
      return;
    }

    // Perspektiver uden sidebar (inbox/naeste/forecast/review/defer/singles)
    const main = body.createDiv({ cls: "gtd-main gtd-mobile-main" });
    await this.renderMain(main);
  }

  /* ============================================================
     TOOLBAR
     ============================================================ */

  private async renderToolbar(parent: HTMLElement): Promise<void> {
    const tabs: { id: Perspective; label: string; icon: string }[] = [
      { id: "inbox", label: "Inbox", icon: "📥" },
      { id: "naeste", label: "Næste", icon: "📌" },
      { id: "singles", label: "Single Tasks", icon: "🎯" },
      { id: "forecast", label: "Forecast", icon: "📅" },
      { id: "projects", label: "Projekter", icon: "📁" },
      { id: "tags", label: "Tags", icon: "🏷" },
      { id: "defer", label: "Udskudt", icon: "⏳" },
      { id: "review", label: "Review", icon: "🔍" },
      { id: "someday", label: "Someday", icon: "💤" },
      { id: "archive", label: "Arkiv", icon: "📦" },
    ];

    const counts = await this.computePerspectiveCounts();

    const tabsEl = parent.createDiv({ cls: "gtd-tabs" });
    for (const tab of tabs) {
      const btn = tabsEl.createEl("button", { cls: "gtd-tab" });
      btn.createSpan({ text: tab.icon });
      btn.createSpan({ text: tab.label });
      const count = counts[tab.id];
      if (count !== undefined && count > 0) {
        btn.createSpan({ text: String(count), cls: "gtd-badge" });
      }
      if (this.currentPerspective === tab.id) {
        btn.addClass("is-active");
      }
      btn.onclick = () => {
        this.currentPerspective = tab.id;
        this.selectedProjectPath = null;
        this.selectedTag = null;
        void this.render();
      };
    }

    const actions = parent.createDiv({ cls: "gtd-actions" });
    const newProjectBtn = actions.createEl("button", {
      text: "+ Projekt",
      cls: "gtd-action-btn mod-cta",
    });
    newProjectBtn.onclick = async () => {
      const newPath = await this.callbacks.onNewProject();
      if (newPath) {
        this.currentPerspective = "projects";
        this.selectedProjectPath = newPath;
        await this.render();
      }
    };
  }

  private async computePerspectiveCounts(): Promise<
    Partial<Record<Perspective, number>>
  > {
    const result: Partial<Record<Perspective, number>> = {};

    // Inbox
    const inboxFile = this.app.vault.getAbstractFileByPath(INBOX_PATH);
    if (inboxFile instanceof TFile) {
      const tasks = await this.tasksInFile(inboxFile);
      result.inbox = tasks.filter((t) => !t.done).length;
    }

    // Single Tasks
    const singlesFile = this.app.vault.getAbstractFileByPath(SINGLE_TASKS_PATH);
    if (singlesFile instanceof TFile) {
      const tasks = await this.tasksInFile(singlesFile);
      const open = tasks.filter((t) => !t.done).length;
      if (open > 0) result.singles = open;
    }

    // Projects: active + awaiting count
    const projectsFiles = this.findFilesByStatus(
      ["active", "awaiting"],
      true
    );
    result.projects = projectsFiles.length;

    // Review: hvor mange er overskredet review-dato
    let reviewDue = 0;
    for (const file of projectsFiles) {
      if (this.isDueForReview(file)) reviewDue++;
    }
    if (reviewDue > 0) result.review = reviewDue;

    // Someday count
    const somedayFiles = this.findFilesByStatus(["someday"], false);
    if (somedayFiles.length > 0) result.someday = somedayFiles.length;

    // Archive count
    const archiveCount = this.findFilesByStatus(
      ["completed", "dropped"],
      false
    ).length;
    if (archiveCount > 0) result.archive = archiveCount;

    return result;
  }

  /* ============================================================
     SIDEBAR
     ============================================================ */

  private async renderSidebar(parent: HTMLElement): Promise<void> {
    if (this.currentPerspective === "tags") {
      await this.renderTagList(parent);
      return;
    }

    let files: TFile[];
    if (this.currentPerspective === "projects") {
      files = this.findFilesByStatus(["active", "awaiting"], true);
    } else if (this.currentPerspective === "someday") {
      files = this.findFilesByStatus(["someday"], false);
    } else if (this.currentPerspective === "archive") {
      files = this.findFilesByStatus(["completed", "dropped"], false);
    } else {
      return;
    }

    // For projekter: medtag også tomme mapper (så man kan oprette dem på forhånd)
    const includeEmptyFolders = this.currentPerspective === "projects";

    if (files.length === 0 && !includeEmptyFolders) {
      const empty = parent.createDiv({ cls: "gtd-empty" });
      empty.createDiv({ text: "(ingen projekter)", cls: "gtd-empty-text" });
      return;
    }

    const tree = this.buildTree(files, includeEmptyFolders);
    const treeEl = parent.createDiv({ cls: "gtd-tree" });
    if (tree.length === 0) {
      const empty = treeEl.createDiv({ cls: "gtd-empty" });
      empty.createDiv({ text: "(ingen projekter)", cls: "gtd-empty-text" });
    }
    for (const node of tree) {
      this.renderTreeNode(treeEl, node, 0);
    }

    // "+ Ny mappe"-knap (kun projekter)
    if (this.currentPerspective === "projects") {
      const addFolderBtn = parent.createDiv({ cls: "gtd-add-folder-btn" });
      addFolderBtn.setText("+ Ny mappe");
      addFolderBtn.onclick = () => void this.createFolder();
    }
  }

  /** Spørg om mappenavn og opret en (tom) undermappe i GTD/Projects/. */
  private async createFolder(): Promise<void> {
    new TextPromptModal(
      this.app,
      "📁 Ny mappe",
      "Mappenavn (fx Hospital, Firma/Faktura)",
      "",
      async (raw) => {
        const sub = raw.trim().replace(/^\/+|\/+$/g, "");
        if (!sub) return;
        // Tillad nestede mapper men rens hvert led
        const cleaned = sub
          .split("/")
          .map((s) => safeFileName(s))
          .filter((s) => s.length > 0)
          .join("/");
        if (!cleaned) {
          new Notice("Ugyldigt mappenavn.");
          return;
        }
        const path = `${PROJECTS_FOLDER}/${cleaned}`;
        if (this.app.vault.getAbstractFileByPath(path)) {
          new Notice(`Mappen "${cleaned}" findes allerede.`);
          return;
        }
        await ensureFolder(this.app, path);
        new Notice(`📁 Oprettet mappe: ${cleaned}`);
        void this.render();
      }
    ).open();
  }

  private renderTreeNode(
    parent: HTMLElement,
    node: TreeNode,
    depth: number
  ): void {
    if (node.kind === "folder") {
      const collapsed = this.collapsedFolders.has(node.path);
      const folderEl = parent.createDiv({ cls: "gtd-folder" });
      if (collapsed) folderEl.addClass("is-collapsed");

      const header = folderEl.createDiv({ cls: "gtd-folder-header" });
      header.createSpan({ text: "▼", cls: "gtd-folder-chevron" });
      header.createSpan({ text: "📂", cls: "gtd-project-icon" });
      header.createSpan({ text: node.name, cls: "gtd-folder-name" });

      header.onclick = () => {
        if (this.collapsedFolders.has(node.path)) {
          this.collapsedFolders.delete(node.path);
        } else {
          this.collapsedFolders.add(node.path);
        }
        void this.render();
      };

      const children = folderEl.createDiv({ cls: "gtd-folder-children" });
      for (const child of node.children ?? []) {
        this.renderTreeNode(children, child, depth + 1);
      }
    } else {
      const itemEl = parent.createDiv({ cls: "gtd-project-item" });
      if (this.selectedProjectPath === node.path) {
        itemEl.addClass("is-selected");
      }
      const status = node.file
        ? getGtdStatus(this.app, node.file)
        : undefined;
      const icon =
        status === "awaiting"
          ? "⏳"
          : status === "someday"
          ? "💤"
          : status === "completed"
          ? "✅"
          : status === "dropped"
          ? "🚫"
          : "📄";
      itemEl.createSpan({ text: icon, cls: "gtd-project-icon" });
      itemEl.createSpan({ text: node.name, cls: "gtd-project-name" });
      if (node.openTasks !== undefined && node.openTasks > 0) {
        itemEl.createSpan({
          text: String(node.openTasks),
          cls: "gtd-project-count",
        });
      }
      itemEl.onclick = () => {
        this.selectedProjectPath = node.path;
        void this.render();
      };
    }
  }

  private async renderTagList(parent: HTMLElement): Promise<void> {
    const tasksByTag = await this.collectTagsAcrossActive();

    const sorted = Array.from(tasksByTag.entries()).sort((a, b) =>
      a[0].localeCompare(b[0], "da")
    );

    if (sorted.length === 0) {
      const empty = parent.createDiv({ cls: "gtd-empty" });
      empty.createDiv({ text: "(ingen tags)", cls: "gtd-empty-text" });
      return;
    }

    for (const [tag, tasks] of sorted) {
      const row = parent.createDiv({ cls: "gtd-tag-row" });
      if (this.selectedTag === tag) row.addClass("is-selected");
      row.createSpan({ text: `#${tag}`, cls: "gtd-tag-row-name" });
      row.createSpan({ text: String(tasks.length), cls: "gtd-tag-row-count" });
      row.onclick = () => {
        this.selectedTag = tag;
        void this.render();
      };
    }
  }

  /* ============================================================
     MAIN
     ============================================================ */

  private async renderMain(parent: HTMLElement): Promise<void> {
    if (this.currentPerspective === "inbox") {
      await this.renderInboxMain(parent);
      return;
    }
    if (this.currentPerspective === "naeste") {
      await this.renderNaesteMain(parent);
      return;
    }
    if (this.currentPerspective === "review") {
      await this.renderReviewMain(parent);
      return;
    }
    if (this.currentPerspective === "defer") {
      await this.renderDeferMain(parent);
      return;
    }
    if (this.currentPerspective === "forecast") {
      await this.renderForecastMain(parent);
      return;
    }
    if (this.currentPerspective === "singles") {
      await this.renderSinglesMain(parent);
      return;
    }
    if (this.currentPerspective === "tags") {
      await this.renderTagMain(parent);
      return;
    }
    // Someday: hvis et parkeret projekt er valgt i sidebaren → vis det.
    // Ellers vis den lette Someday-liste.
    if (this.currentPerspective === "someday" && !this.selectedProjectPath) {
      await this.renderSomedayMain(parent);
      return;
    }
    if (
      this.currentPerspective === "projects" ||
      this.currentPerspective === "someday" ||
      this.currentPerspective === "archive"
    ) {
      await this.renderProjectMain(parent);
      return;
    }
  }

  /* ============================================================
     NÆSTE PERSPEKTIV — first next actions + awaiting reply
     ============================================================ */

  private async renderNaesteMain(parent: HTMLElement): Promise<void> {
    // Find aktive (ikke-afventende) projekter og deres første actionable task
    // (parent-blokerede tasks regnes som ikke-actionable)
    const activeFiles = this.findFilesByStatus(["active"], true);
    const nextActions: { file: TFile; task: Task }[] = [];
    for (const file of activeFiles) {
      const tasks = await this.tasksInFile(file);
      const firstOpen = tasks.find((t) => this.isActionable(t, tasks));
      if (firstOpen) {
        nextActions.push({ file, task: firstOpen });
      }
    }

    // Single tasks (alle åbne, ikke-defererede, ikke-blokerede)
    const singleTasks: Task[] = [];
    const singlesFile = this.app.vault.getAbstractFileByPath(SINGLE_TASKS_PATH);
    if (singlesFile instanceof TFile) {
      const tasks = await this.tasksInFile(singlesFile);
      for (const t of tasks) {
        if (this.isActionable(t, tasks)) singleTasks.push(t);
      }
    }

    // Afventende projekter
    const awaitingFiles = this.findFilesByStatus(["awaiting"], false);
    awaitingFiles.sort((a, b) => a.basename.localeCompare(b.basename, "da"));

    const header = parent.createDiv({ cls: "gtd-main-header" });
    header.createEl("h2", { text: "📌 Næste", cls: "gtd-main-title" });
    header.createSpan({
      text: `${nextActions.length} næste · ${singleTasks.length} single · ${awaitingFiles.length} afventer`,
      cls: "gtd-main-stats",
    });

    // SEKTION 1: Næste handlinger
    const sec1 = parent.createDiv({ cls: "gtd-section" });
    sec1.createEl("h3", {
      text: `📌 Næste handlinger (${nextActions.length})`,
    });
    if (nextActions.length === 0) {
      const empty = sec1.createDiv({ cls: "gtd-section-empty" });
      empty.setText("Intet at gøre lige nu. 🎉");
    } else {
      nextActions.sort((a, b) =>
        a.file.basename.localeCompare(b.file.basename, "da")
      );
      for (const { file, task } of nextActions) {
        this.renderNextActionRow(sec1, file, task);
      }
    }

    // SEKTION 2: Single Tasks
    const secSingle = parent.createDiv({ cls: "gtd-section" });
    secSingle.createEl("h3", {
      text: `🎯 Single Tasks (${singleTasks.length})`,
    });
    if (singleTasks.length === 0) {
      const empty = secSingle.createDiv({ cls: "gtd-section-empty" });
      empty.setText("Ingen standalone tasks.");
    } else {
      singleTasks.sort((a, b) => {
        const aDue = a.dueDate ?? "9999-99-99";
        const bDue = b.dueDate ?? "9999-99-99";
        return aDue.localeCompare(bDue);
      });
      for (const task of singleTasks) {
        this.renderNextActionRow(secSingle, task.file, task);
      }
    }

    // SEKTION 3: Afventer svar
    const sec2 = parent.createDiv({ cls: "gtd-section" });
    sec2.createEl("h3", {
      text: `⏳ Afventer svar (${awaitingFiles.length})`,
    });
    if (awaitingFiles.length === 0) {
      const empty = sec2.createDiv({ cls: "gtd-section-empty" });
      empty.setText("Intet at vente på.");
    } else {
      for (const file of awaitingFiles) {
        this.renderAwaitingRow(sec2, file);
      }
    }
  }

  private renderNextActionRow(
    parent: HTMLElement,
    file: TFile,
    task: Task
  ): void {
    const row = parent.createDiv({ cls: "gtd-action-row" });

    const cb = row.createEl("input", {
      type: "checkbox",
      cls: "gtd-task-checkbox",
    });
    cb.checked = task.done;
    cb.onclick = (e) => {
      e.stopPropagation();
      void this.toggleTaskDone(task);
    };

    const body = row.createDiv({ cls: "gtd-action-row-body" });
    const projEl = body.createDiv({
      text: file.basename,
      cls: "gtd-action-row-project",
    });
    projEl.onclick = (e) => {
      e.stopPropagation();
      this.currentPerspective = "projects";
      this.selectedProjectPath = file.path;
      void this.render();
    };
    const taskTextEl = body.createDiv({
      text: task.text,
      cls: "gtd-action-row-task",
    });
    taskTextEl.style.cursor = "pointer";
    taskTextEl.onclick = (e) => {
      e.stopPropagation();
      new TaskEditModal(this.app, task).open();
    };

    const meta = body.createDiv({ cls: "gtd-task-meta" });
    for (const tag of task.tags) {
      meta.createSpan({ text: `#${tag}`, cls: "gtd-task-tag" });
    }
    if (task.dueDate) meta.createSpan({ text: `📅 ${task.dueDate}` });
  }

  private renderAwaitingRow(parent: HTMLElement, file: TFile): void {
    const row = parent.createDiv({ cls: "gtd-awaiting-row" });
    row.createSpan({ text: "⏳" });
    const name = row.createSpan({
      text: file.basename,
      cls: "gtd-awaiting-row-name",
    });
    const since = getFrontmatterString(this.app, file, "gtd-awaiting-since");
    if (since) {
      row.createSpan({
        text: `siden ${since}`,
        cls: "gtd-awaiting-row-since",
      });
    }
    row.onclick = () => {
      this.currentPerspective = "projects";
      this.selectedProjectPath = file.path;
      void this.render();
    };
  }

  /* ============================================================
     REVIEW PERSPEKTIV
     ============================================================ */

  private async renderReviewMain(parent: HTMLElement): Promise<void> {
    const allActive = this.findFilesByStatus(["active", "awaiting"], true);
    const dueForReview: TFile[] = [];
    for (const file of allActive) {
      if (this.isDueForReview(file)) dueForReview.push(file);
    }

    const header = parent.createDiv({ cls: "gtd-main-header" });
    header.createEl("h2", { text: "🔍 Review", cls: "gtd-main-title" });
    header.createSpan({
      text: `${dueForReview.length} til gennemgang`,
      cls: "gtd-main-stats",
    });

    if (dueForReview.length === 0) {
      const empty = parent.createDiv({ cls: "gtd-empty" });
      empty.createDiv({ text: "✅", cls: "gtd-empty-icon" });
      empty.createDiv({
        text: "Ingen projekter er overskredet review-dato.",
        cls: "gtd-empty-text",
      });
      return;
    }

    // Sortér: mest forsinket først
    dueForReview.sort((a, b) => {
      const ra = getFrontmatterString(this.app, a, "gtd-review") ?? "";
      const rb = getFrontmatterString(this.app, b, "gtd-review") ?? "";
      return ra.localeCompare(rb);
    });

    for (const file of dueForReview) {
      this.renderReviewRow(parent, file);
    }
  }

  private renderReviewRow(parent: HTMLElement, file: TFile): void {
    const row = parent.createDiv({ cls: "gtd-review-row" });

    const left = row.createDiv({ cls: "gtd-review-row-body" });
    const name = left.createDiv({
      text: file.basename,
      cls: "gtd-review-row-name",
    });

    const next = getFrontmatterString(this.app, file, "gtd-review");
    const last = getFrontmatterString(this.app, file, "gtd-review-last");
    const interval = getFrontmatterString(this.app, file, "gtd-review-interval");

    const meta = left.createDiv({ cls: "gtd-review-row-meta" });
    if (next) {
      const today = todayISO();
      const overdue = this.daysBetween(next, today);
      if (overdue > 0) {
        meta.createSpan({
          text: `📆 ${overdue} dage forsinket`,
          cls: "gtd-overdue",
        });
      } else {
        meta.createSpan({ text: `📆 ${next}` });
      }
    }
    if (last) {
      meta.createSpan({ text: `· senest reviewed ${last}` });
    }
    if (interval) {
      meta.createSpan({ text: `· hver ${interval}d` });
    }

    const reviewBtn = row.createEl("button", {
      text: "✓ Reviewed",
      cls: "gtd-action-btn",
    });
    reviewBtn.onclick = (e) => {
      e.stopPropagation();
      void this.markReviewed(file);
    };

    row.onclick = () => {
      this.currentPerspective = "projects";
      this.selectedProjectPath = file.path;
      void this.render();
    };
  }

  private async markReviewed(file: TFile): Promise<void> {
    const today = todayISO();
    const interval = getFrontmatterString(this.app, file, "gtd-review-interval");
    const updates: Record<string, string> = {
      "gtd-review-last": today,
    };
    if (interval) {
      const days = parseInt(interval, 10);
      if (Number.isFinite(days) && days > 0) {
        const next = new Date(today + "T00:00:00");
        next.setDate(next.getDate() + days);
        const y = next.getFullYear();
        const m = String(next.getMonth() + 1).padStart(2, "0");
        const d = String(next.getDate()).padStart(2, "0");
        updates["gtd-review"] = `${y}-${m}-${d}`;
      }
    } else {
      // Hvis intet interval er sat — fjern next-dato så review-flag forsvinder
      updates["gtd-review"] = "";
    }
    const content = await this.app.vault.read(file);
    const updated = setFrontmatterFields(content, updates);
    await this.app.vault.modify(file, updated);
    new Notice(`✓ ${file.basename} markeret som reviewed`);
  }

  private isDueForReview(file: TFile): boolean {
    const today = todayISO();
    const next = getFrontmatterString(this.app, file, "gtd-review");
    if (next && next <= today) return true;

    const last = getFrontmatterString(this.app, file, "gtd-review-last");
    const interval = getFrontmatterString(
      this.app,
      file,
      "gtd-review-interval"
    );
    if (interval && last) {
      const days = parseInt(interval, 10);
      if (Number.isFinite(days) && days > 0) {
        const diff = this.daysBetween(last, today);
        if (diff >= days) return true;
      }
    }
    return false;
  }

  private daysBetween(fromISO: string, toISO: string): number {
    const from = new Date(fromISO + "T00:00:00").getTime();
    const to = new Date(toISO + "T00:00:00").getTime();
    return Math.floor((to - from) / (1000 * 60 * 60 * 24));
  }

  private isTaskDeferred(task: Task): boolean {
    if (!task.deferDate) return false;
    return task.deferDate > todayISO();
  }


  /* ============================================================
     DEFER PERSPEKTIV — udskudte tasks + projekter
     ============================================================ */

  private async renderDeferMain(parent: HTMLElement): Promise<void> {
    const today = todayISO();

    // Saml alle defererede tasks (fra Inbox + Single Tasks + alle aktive/afventende projekter)
    const taskSources: TFile[] = [];
    const inbox = this.app.vault.getAbstractFileByPath(INBOX_PATH);
    if (inbox instanceof TFile) taskSources.push(inbox);
    const singles = this.app.vault.getAbstractFileByPath(SINGLE_TASKS_PATH);
    if (singles instanceof TFile) taskSources.push(singles);
    for (const f of this.findFilesByStatus(["active", "awaiting"], true)) {
      taskSources.push(f);
    }

    const deferredTasks: Task[] = [];
    for (const file of taskSources) {
      const tasks = await this.tasksInFile(file);
      for (const t of tasks) {
        if (!t.done && t.deferDate && t.deferDate > today) {
          deferredTasks.push(t);
        }
      }
    }
    deferredTasks.sort((a, b) =>
      (a.deferDate ?? "").localeCompare(b.deferDate ?? "")
    );

    // Saml projekter med fremtidig gtd-defer dato
    const deferredProjects: { file: TFile; date: string }[] = [];
    for (const file of this.findFilesByStatus(
      ["active", "awaiting"],
      true
    )) {
      const defer = getFrontmatterString(this.app, file, "gtd-defer");
      if (defer && defer > today) {
        deferredProjects.push({ file, date: defer });
      }
    }
    deferredProjects.sort((a, b) => a.date.localeCompare(b.date));

    // Header
    const header = parent.createDiv({ cls: "gtd-main-header" });
    header.createEl("h2", { text: "⏳ Udskudt", cls: "gtd-main-title" });
    header.createSpan({
      text: `${deferredTasks.length} tasks · ${deferredProjects.length} projekter`,
      cls: "gtd-main-stats",
    });

    if (deferredTasks.length === 0 && deferredProjects.length === 0) {
      const empty = parent.createDiv({ cls: "gtd-empty" });
      empty.createDiv({ text: "🎉", cls: "gtd-empty-icon" });
      empty.createDiv({
        text: "Intet er udskudt lige nu.",
        cls: "gtd-empty-text",
      });
      return;
    }

    // SEKTION: Udskudte tasks
    if (deferredTasks.length > 0) {
      const sec1 = parent.createDiv({ cls: "gtd-section" });
      sec1.createEl("h3", {
        text: `📋 Udskudte tasks (${deferredTasks.length})`,
      });
      for (const task of deferredTasks) {
        const row = sec1.createDiv({ cls: "gtd-action-row" });
        const cb = row.createEl("input", {
          type: "checkbox",
          cls: "gtd-task-checkbox",
        });
        cb.checked = task.done;
        cb.onclick = (e: MouseEvent) => {
          e.stopPropagation();
          void this.toggleTaskDone(task);
        };

        const body = row.createDiv({ cls: "gtd-action-row-body" });
        const projName =
          task.file.path === INBOX_PATH ? "Inbox" : task.file.basename;
        const projEl = body.createDiv({
          text: projName,
          cls: "gtd-action-row-project",
        });
        projEl.onclick = (e: MouseEvent) => {
          e.stopPropagation();
          if (task.file.path === INBOX_PATH) {
            this.currentPerspective = "inbox";
          } else {
            this.currentPerspective = "projects";
            this.selectedProjectPath = task.file.path;
          }
          void this.render();
        };
        body.createDiv({ text: task.text, cls: "gtd-action-row-task" });

        const meta = body.createDiv({ cls: "gtd-task-meta" });
        meta.createSpan({ text: `⏳ ${task.deferDate}` });
        for (const tag of task.tags) {
          meta.createSpan({ text: `#${tag}`, cls: "gtd-task-tag" });
        }
        if (task.dueDate) meta.createSpan({ text: `📅 ${task.dueDate}` });
      }
    }

    // SEKTION: Udskudte projekter
    if (deferredProjects.length > 0) {
      const sec2 = parent.createDiv({ cls: "gtd-section" });
      sec2.createEl("h3", {
        text: `📁 Udskudte projekter (${deferredProjects.length})`,
      });
      for (const dp of deferredProjects) {
        const row = sec2.createDiv({ cls: "gtd-awaiting-row" });
        row.createSpan({ text: "📁" });
        row.createSpan({
          text: dp.file.basename,
          cls: "gtd-awaiting-row-name",
        });
        row.createSpan({
          text: `⏳ ${dp.date}`,
          cls: "gtd-awaiting-row-since",
        });
        row.onclick = () => {
          this.currentPerspective = "projects";
          this.selectedProjectPath = dp.file.path;
          void this.render();
        };
      }
    }
  }

  /* ============================================================
     FORECAST PERSPEKTIV — kalender + GTD i to kolonner
     ============================================================ */

  private async renderForecastMain(parent: HTMLElement): Promise<void> {
    const cal = this.callbacks.getCalendarService();
    const days = this.callbacks.getForecastDays();
    const hasSources = this.callbacks.hasCalendarSources();

    const header = parent.createDiv({ cls: "gtd-main-header" });
    header.createEl("h2", { text: "📅 Forecast", cls: "gtd-main-title" });
    header.createSpan({
      text: `næste ${days} dage`,
      cls: "gtd-main-stats",
    });
    const refreshBtn = header.createEl("button", {
      text: "↻ Refresh",
      cls: "gtd-action-btn",
    });
    refreshBtn.style.marginLeft = "auto";
    refreshBtn.onclick = async () => {
      const original = refreshBtn.textContent;
      refreshBtn.textContent = "Henter…";
      refreshBtn.setAttr("disabled", "true");
      try {
        await this.callbacks.refreshCalendars(true);
      } finally {
        refreshBtn.textContent = original;
        refreshBtn.removeAttribute("disabled");
      }
    };

    if (!hasSources) {
      const empty = parent.createDiv({ cls: "gtd-empty" });
      empty.createDiv({ text: "📅", cls: "gtd-empty-icon" });
      empty.createDiv({
        text: "Ingen kalender-kilder tilføjet endnu.",
        cls: "gtd-empty-text",
      });
      const settingsBtn = empty.createEl("button", {
        text: "Åbn indstillinger",
        cls: "gtd-action-btn mod-cta",
      });
      settingsBtn.style.marginTop = "12px";
      settingsBtn.onclick = () => this.callbacks.openSettings();
    }

    // GTD-items pr. dag (også selvom ingen kalender) + past-due
    const { pastDue, byDate: gtdMap } =
      await this.collectGtdItemsForForecast(days);

    // Opdatér stats med past-due-tæller hvis relevant
    if (pastDue.length > 0) {
      const stats = header.querySelector(".gtd-main-stats");
      if (stats) {
        stats.textContent = `næste ${days} dage · 🔴 ${pastDue.length} forsinket`;
      }
    }

    const today = new Date();
    today.setHours(0, 0, 0, 0);
    const todayStr = toLocalDateISO(today);

    const list = parent.createDiv({ cls: "gtd-forecast" });

    // Header-række
    const headerRow = list.createDiv({ cls: "gtd-forecast-header-row" });
    headerRow.createDiv({ text: "Dag", cls: "gtd-forecast-day-header" });
    headerRow.createDiv({
      text: "Kalender",
      cls: "gtd-forecast-col-header",
    });
    headerRow.createDiv({
      text: "GTD",
      cls: "gtd-forecast-col-header",
    });
    headerRow.createDiv({
      text: "Single Tasks",
      cls: "gtd-forecast-col-header",
    });

    // PAST-DUE-RÆKKE (kun hvis der er noget)
    if (pastDue.length > 0) {
      const pastProjectItems = pastDue.filter((i) => i.source === "project");
      const pastSingleItems = pastDue.filter((i) => i.source === "single");

      const pdRow = list.createDiv({
        cls: "gtd-forecast-row gtd-forecast-pastdue",
      });
      const dayEl = pdRow.createDiv({ cls: "gtd-forecast-day" });
      dayEl.setText(`🔴 FORSINKET\n${pastDue.length} item${pastDue.length === 1 ? "" : "s"}`);

      // Kalender-kolonne: tom
      pdRow.createDiv({
        cls: "gtd-forecast-col gtd-forecast-cal",
      }).createDiv({ text: "—", cls: "gtd-forecast-empty" });

      // Past-due project items
      const gtdCol = pdRow.createDiv({
        cls: "gtd-forecast-col gtd-forecast-gtd",
      });
      if (pastProjectItems.length === 0) {
        gtdCol.createDiv({ text: "—", cls: "gtd-forecast-empty" });
      } else {
        for (const item of pastProjectItems) {
          this.renderForecastGtdItem(gtdCol, item, /*showOverdue*/ true, todayStr);
        }
      }

      // Past-due single items
      const singleCol = pdRow.createDiv({
        cls: "gtd-forecast-col gtd-forecast-single",
      });
      if (pastSingleItems.length === 0) {
        singleCol.createDiv({ text: "—", cls: "gtd-forecast-empty" });
      } else {
        for (const item of pastSingleItems) {
          this.renderForecastGtdItem(singleCol, item, /*showOverdue*/ true, todayStr);
        }
      }
    }

    let renderedAny = false;
    for (let i = 0; i < days; i++) {
      const date = new Date(today);
      date.setDate(today.getDate() + i);
      const dateISO = toLocalDateISO(date);

      const events = cal.eventsOnDate(dateISO);
      const allItems = gtdMap.get(dateISO) ?? [];
      const projectItems = allItems.filter((i) => i.source === "project");
      const singleItems = allItems.filter((i) => i.source === "single");

      if (
        events.length === 0 &&
        projectItems.length === 0 &&
        singleItems.length === 0
      )
        continue;
      renderedAny = true;

      const row = list.createDiv({ cls: "gtd-forecast-row" });

      const dayEl = row.createDiv({ cls: "gtd-forecast-day" });
      dayEl.setText(formatDayHeader(date, i));

      const calCol = row.createDiv({
        cls: "gtd-forecast-col gtd-forecast-cal",
      });
      if (events.length === 0) {
        calCol.createDiv({ text: "—", cls: "gtd-forecast-empty" });
      } else {
        for (const ev of events) {
          this.renderForecastEvent(calCol, ev, dateISO);
        }
      }

      const sortKind = (a: ForecastGtdItem, b: ForecastGtdItem) => {
        const order = { due: 0, planned: 1, "defer-exp": 2 };
        return order[a.kind] - order[b.kind];
      };

      const gtdCol = row.createDiv({
        cls: "gtd-forecast-col gtd-forecast-gtd",
      });
      if (projectItems.length === 0) {
        gtdCol.createDiv({ text: "—", cls: "gtd-forecast-empty" });
      } else {
        projectItems.sort(sortKind);
        for (const item of projectItems) {
          this.renderForecastGtdItem(gtdCol, item);
        }
      }

      const singleCol = row.createDiv({
        cls: "gtd-forecast-col gtd-forecast-single",
      });
      if (singleItems.length === 0) {
        singleCol.createDiv({ text: "—", cls: "gtd-forecast-empty" });
      } else {
        singleItems.sort(sortKind);
        for (const item of singleItems) {
          this.renderForecastGtdItem(singleCol, item);
        }
      }
    }

    if (!renderedAny && hasSources) {
      const empty = parent.createDiv({ cls: "gtd-empty" });
      empty.createDiv({ text: "🌴", cls: "gtd-empty-icon" });
      empty.createDiv({
        text: `Intet planlagt de næste ${days} dage.`,
        cls: "gtd-empty-text",
      });
    }
  }

  private renderForecastEvent(
    parent: HTMLElement,
    ev: ParsedEvent,
    dateISO: string
  ): void {
    const el = parent.createDiv({ cls: "gtd-forecast-event" });
    if (ev.allDay) el.addClass("all-day");

    const dot = el.createSpan({ cls: "gtd-forecast-event-dot" });
    dot.style.background = ev.sourceColor;

    if (!ev.allDay) {
      const startDate = ev.startISO.slice(0, 10);
      const startTime = ev.startISO.slice(11, 16);
      const endDate = ev.endISO?.slice(0, 10) ?? startDate;
      const endTime = ev.endISO?.slice(11, 16) ?? "";

      let timeText: string;
      if (startDate === endDate) {
        // Single-dags event: "08:00-16:00"
        timeText = endTime ? `${startTime}-${endTime}` : startTime;
      } else if (dateISO === startDate) {
        // Første dag i fler-dags event: "08:00-"
        timeText = `${startTime}-`;
      } else if (dateISO === endDate) {
        // Sidste dag i fler-dags event: "-16:00"
        timeText = `-${endTime}`;
      } else {
        // Mellem-dage: heldags-indikator
        timeText = "—";
      }
      el.createSpan({ text: timeText, cls: "gtd-forecast-event-time" });
    }
    el.createSpan({ text: ev.summary });
    if (ev.location) {
      el.createDiv({
        text: `📍 ${ev.location}`,
        cls: "gtd-forecast-event-loc",
      });
    }
  }

  private renderForecastGtdItem(
    parent: HTMLElement,
    item: ForecastGtdItem,
    showOverdue: boolean = false,
    todayISOStr: string = ""
  ): void {
    const el = parent.createDiv({
      cls: `gtd-forecast-gtd-item kind-${item.kind}`,
    });
    const iconMap = {
      due: "🔴",
      planned: "🟢",
      "defer-exp": "🟡",
    } as const;
    el.createSpan({ text: iconMap[item.kind] });
    const body = el.createDiv({ cls: "gtd-forecast-gtd-body" });
    body.createDiv({ text: item.label, cls: "gtd-forecast-gtd-label" });

    let projectText = item.projectLabel;
    if (showOverdue && todayISOStr) {
      const daysOverdue = this.daysBetween(item.date, todayISOStr);
      if (daysOverdue > 0) {
        projectText += ` · ${daysOverdue} dag${daysOverdue === 1 ? "" : "e"} forsinket (${item.date})`;
      }
    }
    body.createDiv({
      text: projectText,
      cls: "gtd-forecast-gtd-project",
    });

    el.onclick = () => {
      // Hvis dette er en task (ikke kun et projekt-niveau dato-item), åbn task-editor.
      if (item.task) {
        new TaskEditModal(this.app, item.task).open();
        return;
      }
      // Ellers naviger til projekt/inbox/singles
      if (item.file.path === INBOX_PATH) {
        this.currentPerspective = "inbox";
      } else if (item.source === "single") {
        this.currentPerspective = "singles";
      } else {
        this.currentPerspective = "projects";
        this.selectedProjectPath = item.file.path;
      }
      void this.render();
    };
  }

  private async collectGtdItemsForForecast(
    days: number
  ): Promise<ForecastData> {
    const byDate = new Map<string, ForecastGtdItem[]>();
    const pastDue: ForecastGtdItem[] = [];
    const today = todayISO();
    const lastDate = new Date();
    lastDate.setDate(lastDate.getDate() + days);
    const lastISO = toLocalDateISO(lastDate);

    const add = (
      date: string,
      item: Omit<ForecastGtdItem, "date">
    ) => {
      const fullItem: ForecastGtdItem = { ...item, date };
      // Past due: kun "due"-kind items i fortiden
      if (date < today) {
        if (fullItem.kind === "due") {
          pastDue.push(fullItem);
        }
        return;
      }
      if (date > lastISO) return;
      if (!byDate.has(date)) byDate.set(date, []);
      byDate.get(date)!.push(fullItem);
    };

    // Tasks fra Inbox + Single Tasks + aktive/afventende projekter
    const sources: TFile[] = [];
    const inbox = this.app.vault.getAbstractFileByPath(INBOX_PATH);
    if (inbox instanceof TFile) sources.push(inbox);
    const singles = this.app.vault.getAbstractFileByPath(SINGLE_TASKS_PATH);
    if (singles instanceof TFile) sources.push(singles);
    for (const f of this.findFilesByStatus(["active", "awaiting"], true)) {
      sources.push(f);
    }
    for (const file of sources) {
      const tasks = await this.tasksInFile(file);
      const isSingle = file.path === SINGLE_TASKS_PATH;
      const projLabel =
        file.path === INBOX_PATH
          ? "Inbox"
          : isSingle
          ? "Single Task"
          : file.basename;
      for (const task of tasks) {
        if (task.done) continue;
        if (task.dueDate) {
          add(task.dueDate, {
            kind: "due",
            source: isSingle ? "single" : "project",
            label: task.text,
            projectLabel: projLabel,
            file,
            task,
          });
        }
        if (task.deferDate) {
          add(task.deferDate, {
            kind: "defer-exp",
            source: isSingle ? "single" : "project",
            label: task.text + " (aktiveres)",
            projectLabel: projLabel,
            file,
            task,
          });
        }
      }
    }

    // Projekt-niveau due/planned/defer
    for (const file of this.findFilesByStatus(
      ["active", "awaiting"],
      true
    )) {
      const due = getFrontmatterString(this.app, file, "gtd-due");
      if (due) {
        add(due, {
          kind: "due",
          source: "project",
          label: file.basename + " (hele projektet)",
          projectLabel: "Projekt",
          file,
        });
      }
      const planned = getFrontmatterString(this.app, file, "gtd-planned");
      if (planned) {
        add(planned, {
          kind: "planned",
          source: "project",
          label: file.basename,
          projectLabel: "Projekt",
          file,
        });
      }
      const defer = getFrontmatterString(this.app, file, "gtd-defer");
      if (defer) {
        add(defer, {
          kind: "defer-exp",
          source: "project",
          label: file.basename + " — aktiveres",
          projectLabel: "Projekt",
          file,
        });
      }
    }

    // Sortér past-due fra ældst til nyest (mest forsinket først)
    pastDue.sort((a, b) => a.date.localeCompare(b.date));

    return { pastDue, byDate };
  }

  private async renderInboxMain(parent: HTMLElement): Promise<void> {
    const inboxFile = await this.ensureInboxFile();
    const tasks = await this.tasksInFile(inboxFile);
    const open = tasks.filter((t) => !t.done);

    const header = parent.createDiv({ cls: "gtd-main-header" });
    header.createEl("h2", { text: "📥 Inbox", cls: "gtd-main-title" });
    header.createSpan({
      text: `${open.length} åbne · ${tasks.length} i alt`,
      cls: "gtd-main-stats",
    });
    const singleBtn = header.createEl("button", {
      text: "+ Single task med datoer",
      cls: "gtd-action-btn",
    });
    singleBtn.style.marginLeft = "auto";
    singleBtn.onclick = () => {
      new SingleTaskModal(this.app, async (data) => {
        await appendSingleTask(this.app, data);
        this.currentPerspective = "singles";
        await this.render();
      }).open();
    };

    if (open.length === 0) {
      const empty = parent.createDiv({ cls: "gtd-empty" });
      empty.createDiv({ text: "🎉", cls: "gtd-empty-icon" });
      empty.createDiv({
        text: "Inbox er tom. Brug input-feltet nedenfor til at fange en tanke.",
        cls: "gtd-empty-text",
      });
    } else {
      this.renderTaskList(parent, open, /*showSource*/ false);
    }

    this.renderAddTaskInput(parent, inboxFile, "Fang en tanke til Inbox…");
  }

  /* ============================================================
     SINGLE TASKS PERSPEKTIV
     ============================================================ */

  private async renderSinglesMain(parent: HTMLElement): Promise<void> {
    const file = await ensureSingleTasksFile(this.app);
    const tasks = await this.tasksInFile(file);
    const open = tasks.filter((t) => !t.done);

    const header = parent.createDiv({ cls: "gtd-main-header" });
    header.createEl("h2", {
      text: "🎯 Single Tasks",
      cls: "gtd-main-title",
    });
    header.createSpan({
      text: `${open.length} åbne · ${tasks.length} i alt`,
      cls: "gtd-main-stats",
    });
    const datesBtn = header.createEl("button", {
      text: "+ Med datoer",
      cls: "gtd-action-btn mod-cta",
    });
    datesBtn.style.marginLeft = "auto";
    datesBtn.onclick = () => {
      new SingleTaskModal(this.app, async (data) => {
        await appendSingleTask(this.app, data);
        await this.render();
      }).open();
    };

    if (tasks.length === 0) {
      const empty = parent.createDiv({ cls: "gtd-empty" });
      empty.createDiv({ text: "🎯", cls: "gtd-empty-icon" });
      empty.createDiv({
        text:
          "Ingen single tasks endnu. Brug feltet nedenfor, eller \"+ Med datoer\" for at sætte deadline/defer.",
        cls: "gtd-empty-text",
      });
    } else {
      // Sortér: åbne først (efter due-dato), så lukkede
      const sorted = [...tasks].sort((a, b) => {
        if (a.done !== b.done) return a.done ? 1 : -1;
        const aDue = a.dueDate ?? "9999-99-99";
        const bDue = b.dueDate ?? "9999-99-99";
        return aDue.localeCompare(bDue);
      });
      this.renderTaskList(parent, sorted, /*showSource*/ false);
    }

    this.renderAddTaskInput(parent, file, "+ Tilføj single task (tekst)…");
  }

  /* ============================================================
     SOMEDAY-LISTE
     ============================================================ */

  private async renderSomedayMain(parent: HTMLElement): Promise<void> {
    const file = await ensureSomedayFile(this.app);
    const content = await this.app.vault.read(file);
    const lines = content.split("\n");

    // Parse i grupper: ## Overskrift starter en ny gruppe; items hører til den
    // aktuelle gruppe (eller "uden gruppe" før første overskrift).
    interface SomedayGroup {
      heading: string | null;
      headingLine: number | null;
      items: Task[];
    }
    const groups: SomedayGroup[] = [];
    let current: SomedayGroup = { heading: null, headingLine: null, items: [] };
    groups.push(current);
    for (let i = 0; i < lines.length; i++) {
      const h = lines[i].match(/^##\s+(.+?)\s*$/);
      if (h) {
        current = { heading: h[1], headingLine: i, items: [] };
        groups.push(current);
        continue;
      }
      const task = parseTaskLine(lines[i], file, i);
      if (task && !task.done) current.items.push(task);
    }
    const totalOpen = groups.reduce((n, g) => n + g.items.length, 0);

    const header = parent.createDiv({ cls: "gtd-main-header" });
    header.createEl("h2", {
      text: "💤 Someday / Maybe",
      cls: "gtd-main-title",
    });
    header.createSpan({
      text: `${totalOpen} items`,
      cls: "gtd-main-stats",
    });
    const newGroupBtn = header.createEl("button", {
      text: "+ Ny gruppe",
      cls: "gtd-action-btn",
    });
    newGroupBtn.style.marginLeft = "auto";
    newGroupBtn.onclick = () => {
      new TextPromptModal(
        this.app,
        "📂 Ny gruppe",
        "Gruppenavn (fx Spil, Ungerne)",
        "",
        async (raw) => {
          const name = raw.trim();
          if (!name) return;
          await this.addSomedayGroup(file, name);
          void this.render();
        }
      ).open();
    };

    if (totalOpen === 0 && groups.every((g) => g.heading === null)) {
      const empty = parent.createDiv({ cls: "gtd-empty" });
      empty.createDiv({ text: "💤", cls: "gtd-empty-icon" });
      empty.createDiv({
        text: "Ingen someday-items. Tilføj nedenfor, lav en gruppe, eller flyt et inbox-item hertil.",
        cls: "gtd-empty-text",
      });
    }

    // Render hver gruppe (spring tom "uden gruppe" over)
    for (const g of groups) {
      if (g.heading === null && g.items.length === 0) continue;

      const section = parent.createDiv({ cls: "gtd-someday-group" });
      const gh = section.createDiv({ cls: "gtd-someday-group-header" });
      gh.createSpan({
        text: g.heading === null ? "Uden gruppe" : `📂 ${g.heading}`,
        cls: "gtd-someday-group-name",
      });
      gh.createSpan({
        text: String(g.items.length),
        cls: "gtd-someday-group-count",
      });
      if (g.heading !== null && g.headingLine !== null) {
        const delGroupBtn = gh.createEl("button", {
          text: "🗑",
          cls: "gtd-clear-btn",
        });
        delGroupBtn.setAttribute("aria-label", "Fjern gruppe (items flyttes op)");
        const headingLine = g.headingLine;
        delGroupBtn.onclick = async () => {
          const ok = window.confirm(
            `Fjern gruppen "${g.heading}"?\n\nItems i gruppen slettes ikke — de flyttes bare ud af gruppen.`
          );
          if (!ok) return;
          await this.removeLineFromFile(file, headingLine);
          void this.render();
        };
      }

      const list = section.createEl("ul", { cls: "gtd-task-list" });
      for (const task of g.items) {
        this.renderSomedayItemRow(list, task);
      }

      // Tilføj-felt for netop denne gruppe
      const groupHeading = g.heading;
      this.renderSomedayGroupAddInput(section, file, groupHeading);
    }
  }

  private renderSomedayItemRow(parent: HTMLElement, task: Task): void {
    const li = parent.createEl("li", { cls: "gtd-task" });

    const body = li.createDiv({ cls: "gtd-task-body" });
    const textEl = body.createDiv({ text: task.text, cls: "gtd-task-text" });
    textEl.onclick = () => new TaskEditModal(this.app, task).open();

    const actions = li.createDiv({ cls: "gtd-someday-actions" });
    const toProjectBtn = actions.createEl("button", {
      text: "📁 Lav til projekt",
      cls: "gtd-action-btn",
    });
    toProjectBtn.onclick = (e) => {
      e.stopPropagation();
      void this.convertSomedayToProject(task);
    };
    const delBtn = actions.createEl("button", {
      text: "🗑",
      cls: "gtd-action-btn",
    });
    delBtn.setAttribute("aria-label", "Slet item");
    delBtn.onclick = async (e) => {
      e.stopPropagation();
      await this.removeLineFromFile(task.file, task.lineNumber);
      void this.render();
    };
  }

  private renderSomedayGroupAddInput(
    parent: HTMLElement,
    file: TFile,
    groupHeading: string | null
  ): void {
    const wrapper = parent.createDiv({ cls: "gtd-add-task" });
    const input = wrapper.createEl("input", {
      type: "text",
      cls: "gtd-add-task-input",
      attr: {
        placeholder:
          groupHeading === null
            ? "+ Tilføj someday-item…"
            : `+ Tilføj til "${groupHeading}"…`,
      },
    });
    input.addEventListener("keydown", (e: KeyboardEvent) => {
      if (e.key === "Enter") {
        e.preventDefault();
        const text = input.value.trim();
        if (!text) return;
        input.value = "";
        void this.appendSomedayItemToGroup(file, groupHeading, text);
      }
    });
  }

  /** Tilføj en ny gruppe-overskrift i slutningen af Someday.md. */
  private async addSomedayGroup(file: TFile, name: string): Promise<void> {
    const content = await this.app.vault.read(file);
    const sep = content.endsWith("\n") ? "" : "\n";
    await this.app.vault.modify(file, `${content}${sep}\n## ${name}\n`);
  }

  /** Indsæt et someday-item i en bestemt gruppe (eller "uden gruppe"). */
  private async appendSomedayItemToGroup(
    file: TFile,
    groupHeading: string | null,
    text: string
  ): Promise<void> {
    const content = await this.app.vault.read(file);
    const lines = content.split("\n");
    const line = `- [ ] ${text} ➕ ${todayISO()}`;

    if (groupHeading === null) {
      // Uden gruppe: indsæt før første ## overskrift (eller til sidst)
      const firstHeading = lines.findIndex((l) => /^##\s+/.test(l));
      if (firstHeading === -1) {
        const sep = content.endsWith("\n") || content === "" ? "" : "\n";
        await this.app.vault.modify(file, content + sep + line + "\n");
        return;
      }
      lines.splice(firstHeading, 0, line);
      await this.app.vault.modify(file, lines.join("\n"));
      return;
    }

    // Find gruppens overskrift
    const hi = lines.findIndex(
      (l) => l.match(/^##\s+(.+?)\s*$/)?.[1] === groupHeading
    );
    if (hi === -1) {
      // Gruppen findes ikke længere — læg til sidst
      const sep = content.endsWith("\n") ? "" : "\n";
      await this.app.vault.modify(file, content + sep + line + "\n");
      return;
    }
    // Slut på gruppens blok = næste ## overskrift eller EOF
    let end = hi + 1;
    while (end < lines.length && !/^##\s+/.test(lines[end])) end++;
    // Trim trailing blanke linjer inde i gruppen
    let insertAt = end;
    while (insertAt > hi + 1 && lines[insertAt - 1].trim() === "") insertAt--;
    lines.splice(insertAt, 0, line);
    await this.app.vault.modify(file, lines.join("\n"));
  }

  /** Lav et someday-item om til et aktivt projekt og fjern det fra Someday-listen. */
  private async convertSomedayToProject(task: Task): Promise<void> {
    const safe = safeFileName(task.text);
    if (!safe) {
      new Notice("Kan ikke lave projekt af tom tekst.");
      return;
    }
    const path = `${PROJECTS_FOLDER}/${safe}.md`;
    if (this.app.vault.getAbstractFileByPath(path)) {
      new Notice(`Et projekt "${safe}" findes allerede.`);
      return;
    }
    // Opret projektfil
    await ensureFolder(this.app, PROJECTS_FOLDER);
    await this.app.vault.create(path, projectTemplate(safe));
    // Fjern linjen fra Someday.md
    await this.removeLineFromFile(task.file, task.lineNumber);
    new Notice(`📁 "${safe}" er nu et projekt.`);
    // Hop til det nye projekt
    this.currentPerspective = "projects";
    this.selectedProjectPath = path;
    void this.render();
  }

  /** Fjern en specifik linje fra en fil. */
  private async removeLineFromFile(
    file: TFile,
    lineNumber: number
  ): Promise<void> {
    const content = await this.app.vault.read(file);
    const lines = content.split("\n");
    if (lineNumber < 0 || lineNumber >= lines.length) return;
    lines.splice(lineNumber, 1);
    await this.app.vault.modify(file, lines.join("\n"));
  }

  private async renderTagMain(parent: HTMLElement): Promise<void> {
    const header = parent.createDiv({ cls: "gtd-main-header" });

    if (!this.selectedTag) {
      header.createEl("h2", {
        text: "🏷 Vælg et tag",
        cls: "gtd-main-title",
      });
      const empty = parent.createDiv({ cls: "gtd-empty" });
      empty.createDiv({
        text: "Vælg et tag i listen til venstre for at se tasks.",
        cls: "gtd-empty-text",
      });
      return;
    }

    const tasksByTag = await this.collectTagsAcrossActive();
    const tasks = tasksByTag.get(this.selectedTag) ?? [];
    const open = tasks.filter((t) => !t.done);

    header.createEl("h2", {
      text: `#${this.selectedTag}`,
      cls: "gtd-main-title",
    });
    header.createSpan({
      text: `${open.length} åbne`,
      cls: "gtd-main-stats",
    });

    if (open.length === 0) {
      const empty = parent.createDiv({ cls: "gtd-empty" });
      empty.createDiv({
        text: "Ingen åbne tasks med dette tag.",
        cls: "gtd-empty-text",
      });
      return;
    }

    this.renderTaskList(parent, open, /*showSource*/ true);
  }

  private async renderProjectMain(parent: HTMLElement): Promise<void> {
    const header = parent.createDiv({ cls: "gtd-main-header" });

    if (!this.selectedProjectPath) {
      const persp =
        this.currentPerspective === "projects"
          ? "Projekter"
          : this.currentPerspective === "someday"
          ? "Someday / Maybe"
          : "Arkiv";
      header.createEl("h2", {
        text: persp,
        cls: "gtd-main-title",
      });
      const empty = parent.createDiv({ cls: "gtd-empty" });
      empty.createDiv({ text: "👈", cls: "gtd-empty-icon" });
      empty.createDiv({
        text: "Vælg et projekt i listen til venstre.",
        cls: "gtd-empty-text",
      });
      return;
    }

    const file = this.app.vault.getAbstractFileByPath(this.selectedProjectPath);
    if (!(file instanceof TFile)) {
      header.createEl("h2", {
        text: "(projekt findes ikke længere)",
        cls: "gtd-main-title",
      });
      return;
    }

    const tasks = await this.tasksInFile(file);
    const open = tasks.filter((t) => !t.done);

    header.createEl("h2", { text: file.basename, cls: "gtd-main-title" });
    header.createSpan({
      text: `${open.length} åbne · ${tasks.length} i alt`,
      cls: "gtd-main-stats",
    });

    // Vis BÅDE åbne og lukkede; klikbart for at slå om.
    // Hierarkisk visning (fold ud/ind) i projekt-visning.
    if (tasks.length === 0) {
      const empty = parent.createDiv({ cls: "gtd-empty" });
      empty.createDiv({
        text: "Ingen tasks endnu. Brug feltet nedenfor.",
        cls: "gtd-empty-text",
      });
    } else {
      this.renderTaskList(parent, tasks, false, /*hierarchical*/ true, tasks);
    }

    // Inline add-task — kun for aktive projekter
    if (this.currentPerspective === "projects") {
      this.renderAddTaskInput(parent, file, "+ Tilføj task til projektet…");
    }
  }

  private renderTaskList(
    parent: HTMLElement,
    tasks: Task[],
    showSource: boolean,
    hierarchical: boolean = false,
    allTasks: Task[] = tasks
  ): void {
    const list = parent.createEl("ul", { cls: "gtd-task-list" });

    if (!hierarchical) {
      for (const task of tasks) {
        this.renderTaskRow(list, task, showSource, false, false);
      }
      return;
    }

    // Hierarkisk: skjul efterkommere af foldede parents.
    // collapseStack = indents på foldede forfædre vi er "inde i".
    const collapseStack: number[] = [];
    for (const task of tasks) {
      while (
        collapseStack.length > 0 &&
        task.indent <= collapseStack[collapseStack.length - 1]
      ) {
        collapseStack.pop();
      }
      if (collapseStack.length > 0) continue; // skjult under en foldet parent

      const hasChildren = allTasks.some(
        (t) => t.parentLine === task.lineNumber
      );
      const isCollapsed =
        hasChildren && this.collapsedTasks.has(this.taskKey(task));

      this.renderTaskRow(list, task, showSource, hasChildren, isCollapsed);

      if (isCollapsed) collapseStack.push(task.indent);
    }
  }

  private renderTaskRow(
    parent: HTMLElement,
    task: Task,
    showSource: boolean,
    hasChildren: boolean = false,
    isCollapsed: boolean = false
  ): void {
    const li = parent.createEl("li", { cls: "gtd-task" });
    if (task.done) li.addClass("is-done");
    if (task.indent > 0) {
      li.style.marginLeft = `${Math.min(task.indent, 24)}px`;
    }

    // Fold-ud/ind-trekant (kun hvis tasken har sub-tasks)
    const chevron = li.createSpan({ cls: "gtd-task-chevron" });
    if (hasChildren) {
      chevron.setText(isCollapsed ? "▸" : "▾");
      chevron.addClass("is-toggleable");
      chevron.onclick = (e) => {
        e.stopPropagation();
        const key = this.taskKey(task);
        if (this.collapsedTasks.has(key)) this.collapsedTasks.delete(key);
        else this.collapsedTasks.add(key);
        this.saveCollapsedTasks();
        void this.render();
      };
    }

    const cb = li.createEl("input", {
      type: "checkbox",
      cls: "gtd-task-checkbox",
    });
    cb.checked = task.done;
    cb.onclick = (e) => {
      e.stopPropagation();
      void this.toggleTaskDone(task);
    };

    const body = li.createDiv({ cls: "gtd-task-body" });
    const textEl = body.createDiv({ text: task.text, cls: "gtd-task-text" });
    if (hasChildren && isCollapsed) {
      textEl.createSpan({ text: " …", cls: "gtd-task-collapsed-hint" });
    }
    textEl.onclick = () => new TaskEditModal(this.app, task).open();

    const meta = body.createDiv({ cls: "gtd-task-meta" });
    for (const tag of task.tags) {
      meta.createSpan({ text: `#${tag}`, cls: "gtd-task-tag" });
    }
    if (task.dueDate) meta.createSpan({ text: `📅 ${task.dueDate}` });
    if (task.deferDate) meta.createSpan({ text: `⏳ ${task.deferDate}` });
    if (showSource) {
      const src = meta.createSpan({
        text: task.file.basename,
        cls: "gtd-task-source",
      });
      src.onclick = () => void this.openTaskSource(task);
    }
  }

  private renderAddTaskInput(
    parent: HTMLElement,
    target: TFile,
    placeholder: string
  ): void {
    const wrapper = parent.createDiv({ cls: "gtd-add-task" });
    const input = wrapper.createEl("input", {
      type: "text",
      cls: "gtd-add-task-input",
      attr: { placeholder },
    });
    input.addEventListener("keydown", (e: KeyboardEvent) => {
      if (e.key === "Enter") {
        e.preventDefault();
        const text = input.value.trim();
        if (!text) return;
        input.value = "";
        void this.appendTaskToFile(target, text);
      }
    });
  }

  /* ============================================================
     INSPECTOR
     ============================================================ */

  private async renderInspector(
    parent: HTMLElement,
    file: TFile
  ): Promise<void> {
    parent.createEl("h3", { text: "Inspector" });

    const status = getGtdStatus(this.app, file) ?? "active";

    // STATUS
    const statusField = parent.createDiv({ cls: "gtd-field" });
    statusField.createEl("label", {
      text: "Status",
      cls: "gtd-field-label",
    });
    const statusGroup = statusField.createDiv({ cls: "gtd-status-group" });
    const statuses: { value: ProjectStatus; label: string }[] = [
      { value: "active", label: "Aktiv" },
      { value: "awaiting", label: "Afventer" },
      { value: "someday", label: "Someday" },
      { value: "completed", label: "Afsluttet" },
      { value: "dropped", label: "Droppet" },
    ];
    for (const s of statuses) {
      const btn = statusGroup.createEl("button", {
        text: s.label,
        cls: "gtd-status-btn",
      });
      if (status === s.value) btn.addClass("is-active");
      btn.onclick = () => void this.changeStatus(file, s.value);
    }

    // DEFER
    this.renderDateField(parent, file, "Defer dato", "gtd-defer");
    // PLANNED
    this.renderDateField(parent, file, "Planned dato", "gtd-planned");
    // DUE
    this.renderDateField(parent, file, "Due dato", "gtd-due");
    // REVIEW
    this.renderDateField(parent, file, "Næste review", "gtd-review");

    // REVIEW INTERVAL
    const intervalField = parent.createDiv({ cls: "gtd-field" });
    intervalField.createEl("label", {
      text: "Review-interval (dage)",
      cls: "gtd-field-label",
    });
    const intervalInput = intervalField.createEl("input", {
      type: "number",
      cls: "gtd-input",
      attr: { min: "1", max: "365" },
    }) as HTMLInputElement;
    const currentInterval = getFrontmatterString(
      this.app,
      file,
      "gtd-review-interval"
    );
    if (currentInterval) intervalInput.value = currentInterval;
    intervalInput.onchange = async () => {
      const value = intervalInput.value.trim();
      const content = await this.app.vault.read(file);
      const updated = setFrontmatterFields(content, {
        "gtd-review-interval": value,
      });
      await this.app.vault.modify(file, updated);
    };

    // NOTE
    const noteField = parent.createDiv({ cls: "gtd-field" });
    noteField.createEl("label", {
      text: "Note",
      cls: "gtd-field-label",
    });
    const noteArea = noteField.createEl("textarea", {
      cls: "gtd-input gtd-note-area",
      attr: { placeholder: "Skriv lidt info om projektet…", rows: "4" },
    }) as HTMLTextAreaElement;
    const fileContent = await this.app.vault.read(file);
    noteArea.value = getNoteSection(fileContent);
    // Gem på blur (når man klikker væk) — undgår at skrive ved hvert tastetryk
    noteArea.addEventListener("blur", async () => {
      const current = await this.app.vault.read(file);
      const existing = getNoteSection(current);
      if (existing === noteArea.value) return;
      const updated = setNoteSection(current, noteArea.value);
      await this.app.vault.modify(file, updated);
    });

    // MARK REVIEWED NOW
    const reviewedField = parent.createDiv({ cls: "gtd-field" });
    const reviewedBtn = reviewedField.createEl("button", {
      text: "✓ Marker som reviewed nu",
      cls: "gtd-action-btn",
    });
    reviewedBtn.onclick = () => void this.markReviewed(file);

    // OPEN FILE BUTTON
    const openField = parent.createDiv({ cls: "gtd-field" });
    const openBtn = openField.createEl("button", {
      text: "Åbn projektfil",
      cls: "gtd-action-btn",
    });
    openBtn.onclick = () => {
      void this.app.workspace.getLeaf(false).openFile(file);
    };
  }

  private renderDateField(
    parent: HTMLElement,
    file: TFile,
    label: string,
    key: string
  ): void {
    const field = parent.createDiv({ cls: "gtd-field" });
    field.createEl("label", { text: label, cls: "gtd-field-label" });

    const row = field.createDiv({ cls: "gtd-row" });
    // Ét tekstfelt der forstår både "+1d", "11/02/2026" og "2026-02-11"
    const input = row.createEl("input", {
      type: "text",
      cls: "gtd-input",
      attr: { placeholder: "+1d · 11/02/2026 · tom = ingen" },
    }) as HTMLInputElement;
    const current = getFrontmatterString(this.app, file, key);
    if (current) input.value = current;

    const save = async (value: string): Promise<void> => {
      const content = await this.app.vault.read(file);
      const updated = setFrontmatterFields(content, { [key]: value });
      await this.app.vault.modify(file, updated);
    };

    const apply = (): void => {
      const raw = input.value.trim();
      if (raw === "") {
        void save("");
        return;
      }
      // Allerede ISO og uændret? Spring over (undgå unødig skrivning)
      if (raw === current) return;
      const parsed = parseDateExpression(raw);
      if (!parsed) {
        new Notice(
          `Forstod ikke "${raw}". Brug fx +1d, +2m, 11/02/2026 eller 2026-02-11.`
        );
        return;
      }
      input.value = parsed;
      void save(parsed);
    };

    input.addEventListener("keydown", (e: KeyboardEvent) => {
      if (e.key === "Enter") {
        e.preventDefault();
        apply();
        input.blur();
      }
    });
    input.addEventListener("blur", () => apply());

    const clearBtn = row.createEl("button", {
      text: "×",
      cls: "gtd-clear-btn",
    });
    clearBtn.setAttribute("aria-label", "Ryd dato");
    clearBtn.onclick = () => {
      input.value = "";
      void save("");
    };
  }

  /* ============================================================
     DATA HELPERS
     ============================================================ */

  /** Find filer der har en bestemt gtd-status (eller flere). */
  private findFilesByStatus(
    statuses: ProjectStatus[],
    includeProjectsFolderWithoutStatus: boolean
  ): TFile[] {
    const result: TFile[] = [];
    for (const file of this.app.vault.getMarkdownFiles()) {
      const status = getGtdStatus(this.app, file);
      if (status !== undefined && statuses.includes(status)) {
        result.push(file);
        continue;
      }
      if (
        includeProjectsFolderWithoutStatus &&
        status === undefined &&
        file.path.startsWith(PROJECTS_FOLDER + "/")
      ) {
        result.push(file);
      }
    }
    return result;
  }

  /** Byg mappe/projekt-træ ud fra fil-paths. */
  private buildTree(
    files: TFile[],
    includeEmptyFolders: boolean = false
  ): TreeNode[] {
    const root: TreeNode = {
      kind: "folder",
      name: "",
      path: "",
      children: [],
    };

    // Medtag tomme undermapper i GTD/Projects/ (så de vises selvom de ingen projekter har)
    if (includeEmptyFolders) {
      const projectsFolder =
        this.app.vault.getAbstractFileByPath(PROJECTS_FOLDER);
      if (projectsFolder instanceof TFolder) {
        const addFolders = (folder: TFolder, prefix: string) => {
          for (const child of folder.children) {
            if (child instanceof TFolder) {
              const rel = prefix ? `${prefix}/${child.name}` : child.name;
              this.ensureFolderNode(root, rel.split("/"));
              addFolders(child, rel);
            }
          }
        };
        addFolders(projectsFolder, "");
      }
    }

    for (const file of files) {
      let relativePath: string;
      let isUnderProjects = false;
      if (file.path.startsWith(PROJECTS_FOLDER + "/")) {
        relativePath = file.path.slice(PROJECTS_FOLDER.length + 1);
        isUnderProjects = true;
      } else if (file.path.startsWith("GTD/Archive/")) {
        relativePath = file.path.slice("GTD/Archive/".length);
      } else {
        // Filer udenfor GTD/Projects/ — placér under "Andre"
        const parent = file.parent?.path;
        if (parent && parent !== "/") {
          relativePath = `Andre/${parent}/${file.name}`;
        } else {
          relativePath = `Andre/${file.name}`;
        }
      }

      const parts = relativePath.split("/");
      let current = root;

      for (let i = 0; i < parts.length - 1; i++) {
        const folderName = parts[i];
        const folderPath = parts.slice(0, i + 1).join("/");
        let folder = current.children?.find(
          (c) => c.kind === "folder" && c.name === folderName
        );
        if (!folder) {
          folder = {
            kind: "folder",
            name: folderName,
            path: folderPath,
            children: [],
          };
          current.children?.push(folder);
        }
        current = folder;
      }

      // Beregn åbne tasks for projektet
      const node: TreeNode = {
        kind: "project",
        name: file.basename,
        path: file.path,
        file,
      };
      current.children?.push(node);
    }

    this.sortTree(root);
    return root.children ?? [];
  }

  /** Sørg for at en mappe-sti findes i træet; returnér den dybeste folder-node. */
  private ensureFolderNode(root: TreeNode, parts: string[]): TreeNode {
    let current = root;
    for (let i = 0; i < parts.length; i++) {
      const folderName = parts[i];
      const folderPath = parts.slice(0, i + 1).join("/");
      let folder = current.children?.find(
        (c) => c.kind === "folder" && c.name === folderName
      );
      if (!folder) {
        folder = {
          kind: "folder",
          name: folderName,
          path: folderPath,
          children: [],
        };
        current.children?.push(folder);
      }
      current = folder;
    }
    return current;
  }

  private sortTree(node: TreeNode): void {
    if (!node.children) return;
    node.children.sort((a, b) => {
      if (a.kind !== b.kind) return a.kind === "folder" ? -1 : 1;
      return a.name.localeCompare(b.name, "da");
    });
    for (const child of node.children) {
      if (child.kind === "folder") this.sortTree(child);
    }
  }

  /** Læs tasks fra én fil. */
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

  /** En task er "actionable" hvis: ikke done, ikke defereret, og ingen forfader er åben. */
  private isActionable(task: Task, allTasks: Task[]): boolean {
    if (task.done) return false;
    if (this.isTaskDeferred(task)) return false;
    if (isBlockedByAncestor(task, allTasks)) return false;
    return true;
  }

  /** Indsaml alle tasks fra Inbox + Single Tasks + aktive projekter, grupperet på tag. */
  private async collectTagsAcrossActive(): Promise<Map<string, Task[]>> {
    const sources: TFile[] = [];
    const inbox = this.app.vault.getAbstractFileByPath(INBOX_PATH);
    if (inbox instanceof TFile) sources.push(inbox);
    const singles = this.app.vault.getAbstractFileByPath(SINGLE_TASKS_PATH);
    if (singles instanceof TFile) sources.push(singles);

    for (const file of this.findFilesByStatus(["active"], true)) {
      sources.push(file);
    }

    const tagsMap = new Map<string, Task[]>();
    for (const file of sources) {
      const tasks = await this.tasksInFile(file);
      for (const t of tasks) {
        if (!this.isActionable(t, tasks)) continue;
        for (const tag of t.tags) {
          if (!tagsMap.has(tag)) tagsMap.set(tag, []);
          tagsMap.get(tag)!.push(t);
        }
      }
    }
    return tagsMap;
  }

  /* ============================================================
     ACTIONS
     ============================================================ */

  private async toggleTaskDone(task: Task): Promise<void> {
    const content = await this.app.vault.read(task.file);
    const lines = content.split("\n");
    const line = lines[task.lineNumber];
    if (!line) {
      new Notice("Kunne ikke finde linjen — filen er måske ændret.");
      return;
    }
    const newLine = task.done
      ? line.replace(/-\s*\[[xX]\]/, "- [ ]")
      : line.replace(/-\s*\[\s\]/, "- [x]");
    if (newLine === line) {
      new Notice("Kunne ikke opdatere linjen.");
      return;
    }
    lines[task.lineNumber] = newLine;
    await this.app.vault.modify(task.file, lines.join("\n"));
  }

  private async openTaskSource(task: Task): Promise<void> {
    const leaf = this.app.workspace.getLeaf(false);
    await leaf.openFile(task.file, { eState: { line: task.lineNumber } });
  }

  private async appendTaskToFile(file: TFile, text: string): Promise<void> {
    const taskLine = `- [ ] ${text} ➕ ${todayISO()}`;
    const current = await this.app.vault.read(file);
    const needsNewline = current.length > 0 && !current.endsWith("\n");
    const next = current + (needsNewline ? "\n" : "") + taskLine + "\n";
    await this.app.vault.modify(file, next);
  }

  private async ensureInboxFile(): Promise<TFile> {
    const existing = this.app.vault.getAbstractFileByPath(INBOX_PATH);
    if (existing instanceof TFile) return existing;
    await ensureFolder(this.app, "GTD");
    const initial =
      "# Inbox\n\nUsorterede tanker, ideer og to-do's. " +
      "Behandl regelmæssigt: hvad er det? Er det handlingsorienteret? " +
      "Hvis ja: hvilket projekt hører det til?\n\n";
    return await this.app.vault.create(INBOX_PATH, initial);
  }

  /** Skift status på et projekt — håndterer log + arkivering. */
  private async changeStatus(
    file: TFile,
    newStatus: ProjectStatus
  ): Promise<void> {
    const oldStatus = getGtdStatus(this.app, file);
    if (oldStatus === newStatus) return;

    const name = file.basename;
    const content = await this.app.vault.read(file);
    const empty = isProjectFileEmpty(content);
    let updated = content;

    // Marker åbne tasks som done hvis vi afslutter
    if (newStatus === "completed") {
      updated = updated.replace(/^(\s*-\s*)\[\s\]/gm, `$1[x]`);
    }

    // Opdater frontmatter
    const stampField =
      newStatus === "completed"
        ? "gtd-completed"
        : newStatus === "dropped"
        ? "gtd-dropped"
        : newStatus === "someday"
        ? "gtd-someday-since"
        : newStatus === "awaiting"
        ? "gtd-awaiting-since"
        : "gtd-activated";
    updated = setFrontmatterFields(updated, {
      "gtd-status": newStatus,
      [stampField]: todayISO(),
    });

    await this.app.vault.modify(file, updated);

    // Log + arkivering
    let logPath: string | null = null;
    let logTitle = "";
    let logLine = "";
    let archiveFolder: string | null = null;

    if (newStatus === "completed") {
      logPath = COMPLETED_LOG;
      logTitle = "Afsluttede projekter";
      logLine = `- [x] [[${name}]] — afsluttet ${todayISO()}`;
      archiveFolder = "GTD/Archive/Projects";
    } else if (newStatus === "dropped") {
      logPath = DROPPED_LOG;
      logTitle = "Droppede projekter";
      logLine = `- ~~[[${name}]]~~ — droppet ${todayISO()}`;
      archiveFolder = "GTD/Archive/Dropped";
    } else if (newStatus === "someday") {
      logPath = SOMEDAY_LOG;
      logTitle = "Someday / Maybe";
      logLine = `- [[${name}]] — parkeret ${todayISO()}`;
      archiveFolder = null;
    }
    // awaiting + active: ingen log, ingen arkivering

    if (logPath) {
      await appendToLog(this.app, logPath, logTitle, logLine);
    }

    if (empty && archiveFolder) {
      const yearFolder = `${archiveFolder}/${currentYear()}`;
      await ensureFolder(this.app, yearFolder);
      const newPath = `${yearFolder}/${file.name}`;
      await this.app.fileManager.renameFile(file, newPath);
      this.selectedProjectPath = newPath;
      new Notice(`✅ Status ændret til ${newStatus}, filen er arkiveret.`);
    } else {
      new Notice(`✅ Status ændret til ${newStatus}.`);
    }

    void this.render();
  }
}

/* ============================================================
   Modul-level helpers
   ============================================================ */

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function toLocalDateISO(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

const DK_DAYS_SHORT = ["Søn", "Man", "Tir", "Ons", "Tor", "Fre", "Lør"];

const DK_MONTHS = [
  "jan",
  "feb",
  "mar",
  "apr",
  "maj",
  "jun",
  "jul",
  "aug",
  "sep",
  "okt",
  "nov",
  "dec",
];

function formatDayHeader(date: Date, dayOffset: number): string {
  const day = DK_DAYS_SHORT[date.getDay()];
  const month = DK_MONTHS[date.getMonth()];
  const dateNum = date.getDate();
  if (dayOffset === 0) return `I dag\n${day} ${dateNum}. ${month}`;
  if (dayOffset === 1) return `I morgen\n${day} ${dateNum}. ${month}`;
  return `${day} ${dateNum}. ${month}`;
}

/* ============================================================
   Single Task Modal — text + due/defer/tags
   ============================================================ */

interface SingleTaskData {
  text: string;
  dueDate?: string;
  deferDate?: string;
  tags?: string[];
}

class SingleTaskModal extends Modal {
  private readonly onSubmit: (data: SingleTaskData) => Promise<void>;
  private textEl!: HTMLInputElement;
  private dueEl!: HTMLInputElement;
  private deferEl!: HTMLInputElement;
  private tagsEl!: HTMLInputElement;

  constructor(
    app: App,
    onSubmit: (data: SingleTaskData) => Promise<void>
  ) {
    super(app);
    this.onSubmit = onSubmit;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: "🎯 Ny Single Task" });

    // Tekst
    contentEl.createEl("label", {
      text: "Hvad skal gøres?",
      cls: "setting-item-name",
    });
    this.textEl = contentEl.createEl("input", {
      type: "text",
      attr: { placeholder: "Fx Køb gave til mor" },
    });
    this.styleInput(this.textEl);
    this.textEl.focus();

    // Due dato
    contentEl.createEl("label", {
      text: "Deadline (📅)",
      cls: "setting-item-name",
    });
    this.dueEl = contentEl.createEl("input", { type: "date" });
    this.styleInput(this.dueEl);

    // Defer dato
    contentEl.createEl("label", {
      text: "Defer indtil (⏳) — skjules fra views indtil denne dato",
      cls: "setting-item-name",
    });
    this.deferEl = contentEl.createEl("input", { type: "date" });
    this.styleInput(this.deferEl);

    // Tags
    contentEl.createEl("label", {
      text: "Tags (valgfri, fx 'ærinder hus')",
      cls: "setting-item-name",
    });
    this.tagsEl = contentEl.createEl("input", {
      type: "text",
      attr: { placeholder: "ærinder hus" },
    });
    this.styleInput(this.tagsEl);

    // Knapper
    const buttonRow = contentEl.createDiv();
    buttonRow.style.marginTop = "14px";
    buttonRow.style.display = "flex";
    buttonRow.style.gap = "8px";
    buttonRow.style.justifyContent = "flex-end";

    const cancelBtn = buttonRow.createEl("button", { text: "Annullér" });
    cancelBtn.onclick = () => this.close();

    const submitBtn = buttonRow.createEl("button", {
      text: "Opret (↵)",
      cls: "mod-cta",
    });
    submitBtn.onclick = () => void this.submit();

    for (const input of [this.textEl, this.dueEl, this.deferEl, this.tagsEl]) {
      input.addEventListener("keydown", (e: KeyboardEvent) => {
        if (e.key === "Enter") {
          e.preventDefault();
          void this.submit();
        } else if (e.key === "Escape") {
          e.preventDefault();
          this.close();
        }
      });
    }
  }

  private styleInput(input: HTMLInputElement): void {
    input.style.width = "100%";
    input.style.padding = "8px";
    input.style.marginTop = "4px";
    input.style.marginBottom = "12px";
    input.style.fontSize = "14px";
  }

  private async submit(): Promise<void> {
    const text = this.textEl.value.trim();
    if (!text) {
      new Notice("Skriv en task-tekst først.");
      return;
    }
    const tags = this.tagsEl.value
      .trim()
      .split(/\s+/)
      .map((t) => t.replace(/^#/, ""))
      .filter((t) => t.length > 0);

    const data: SingleTaskData = {
      text,
      dueDate: this.dueEl.value || undefined,
      deferDate: this.deferEl.value || undefined,
      tags: tags.length > 0 ? tags : undefined,
    };

    this.close();
    await this.onSubmit(data);
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

/** Simpel én-felt tekst-prompt modal. */
class TextPromptModal extends Modal {
  private readonly title: string;
  private readonly placeholder: string;
  private readonly initial: string;
  private readonly onSubmit: (value: string) => void | Promise<void>;
  private inputEl!: HTMLInputElement;

  constructor(
    app: App,
    title: string,
    placeholder: string,
    initial: string,
    onSubmit: (value: string) => void | Promise<void>
  ) {
    super(app);
    this.title = title;
    this.placeholder = placeholder;
    this.initial = initial;
    this.onSubmit = onSubmit;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: this.title });

    this.inputEl = contentEl.createEl("input", {
      type: "text",
      attr: { placeholder: this.placeholder },
    });
    this.inputEl.value = this.initial;
    this.inputEl.style.width = "100%";
    this.inputEl.style.padding = "8px";
    this.inputEl.style.marginTop = "8px";
    this.inputEl.style.fontSize = "14px";
    this.inputEl.focus();

    const buttonRow = contentEl.createDiv();
    buttonRow.style.marginTop = "14px";
    buttonRow.style.display = "flex";
    buttonRow.style.gap = "8px";
    buttonRow.style.justifyContent = "flex-end";

    const cancelBtn = buttonRow.createEl("button", { text: "Annullér" });
    cancelBtn.onclick = () => this.close();

    const okBtn = buttonRow.createEl("button", {
      text: "OK (↵)",
      cls: "mod-cta",
    });
    okBtn.onclick = () => void this.submit();

    this.inputEl.addEventListener("keydown", (e: KeyboardEvent) => {
      if (e.key === "Enter") {
        e.preventDefault();
        void this.submit();
      } else if (e.key === "Escape") {
        e.preventDefault();
        this.close();
      }
    });
  }

  private async submit(): Promise<void> {
    const value = this.inputEl.value;
    this.close();
    await this.onSubmit(value);
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

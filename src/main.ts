import {
  App,
  Modal,
  Notice,
  Plugin,
  TFile,
  WorkspaceLeaf,
} from "obsidian";
import { DashboardView, VIEW_TYPE_DASHBOARD } from "./dashboard-view";
import {
  ActionSidebarView,
  VIEW_TYPE_ACTION_SIDEBAR,
} from "./action-sidebar-view";
import {
  completeProject,
  createProject,
  defererProjectToSomeday,
  dropProject,
} from "./project-actions";
import {
  GTD_FOLDER,
  INBOX_PATH,
  ensureFolder,
  todayISO,
} from "./project-utils";
import {
  DEFAULT_SETTINGS,
  JonerGTDSettingTab,
  JonerGTDSettings,
} from "./settings";
import { CalendarService } from "./calendar-service";

export const CALENDAR_UPDATED_EVENT = "joner-gtd:calendar-updated";

export default class JonerGTDPlugin extends Plugin {
  settings!: JonerGTDSettings;
  calendarService!: CalendarService;

  async onload(): Promise<void> {
    console.log("Joner GTD: indlæst");

    await this.loadSettings();
    this.calendarService = new CalendarService(this);

    // --- Views ---
    this.registerView(
      VIEW_TYPE_DASHBOARD,
      (leaf: WorkspaceLeaf) =>
        new DashboardView(leaf, {
          onNewProject: async () => {
            const file = await createProject(this.app);
            return file?.path ?? null;
          },
          getCalendarService: () => this.calendarService,
          refreshCalendars: (force = false) =>
            this.calendarService.refreshAll(force),
          getForecastDays: () => this.settings.forecastDays,
          hasCalendarSources: () => this.calendarService.hasAnySources(),
          openSettings: () => this.openPluginSettings(),
        })
    );
    this.registerView(
      VIEW_TYPE_ACTION_SIDEBAR,
      (leaf: WorkspaceLeaf) => new ActionSidebarView(leaf)
    );

    // --- Ribbon-ikoner ---
    this.addRibbonIcon("inbox", "GTD: Hurtig capture til Inbox", () => {
      new QuickCaptureModal(this.app, async (text) => {
        await this.appendToInbox(text);
      }).open();
    });
    this.addRibbonIcon("check-circle-2", "Åbn GTD Dashboard", () => {
      void this.activateDashboard();
    });
    this.addRibbonIcon(
      "list-checks",
      "Åbn Næste & Afventer sidebar",
      () => {
        void this.activateActionSidebar();
      }
    );

    // --- Status bar ---
    this.addStatusBarItem().setText("🗂 GTD");

    // --- Settings tab ---
    this.addSettingTab(new JonerGTDSettingTab(this.app, this));

    // --- Kommandoer ---

    this.addCommand({
      id: "joner-gtd-open-dashboard",
      name: "GTD: Åbn Dashboard",
      callback: () => void this.activateDashboard(),
    });

    this.addCommand({
      id: "joner-gtd-open-action-sidebar",
      name: "GTD: Åbn Næste & Afventer sidebar",
      callback: () => void this.activateActionSidebar(),
    });

    this.addCommand({
      id: "joner-gtd-quick-capture",
      name: "GTD: Hurtig capture til Inbox",
      callback: () => {
        new QuickCaptureModal(this.app, async (text) => {
          await this.appendToInbox(text);
        }).open();
      },
    });

    this.addCommand({
      id: "joner-gtd-new-project",
      name: "GTD: Nyt projekt",
      callback: async () => {
        const file = await createProject(this.app);
        if (file) {
          const dashboardOpen =
            this.app.workspace.getLeavesOfType(VIEW_TYPE_DASHBOARD).length > 0;
          if (!dashboardOpen) {
            await this.app.workspace.getLeaf(false).openFile(file);
          }
        }
      },
    });

    this.addCommand({
      id: "joner-gtd-complete-project",
      name: "GTD: Afslut det aktive projekt",
      callback: () => void completeProject(this.app),
    });

    this.addCommand({
      id: "joner-gtd-drop-project",
      name: "GTD: Drop det aktive projekt",
      callback: () => void dropProject(this.app),
    });

    this.addCommand({
      id: "joner-gtd-someday-project",
      name: "GTD: Parkér projekt som Someday/Maybe",
      callback: () => void defererProjectToSomeday(this.app),
    });

    this.addCommand({
      id: "joner-gtd-refresh-calendars",
      name: "GTD: Genopfrisk kalendere",
      callback: () => void this.calendarService.refreshAll(true),
    });

    // --- Initial calendar fetch + start scheduled refresh ---
    if (this.calendarService.hasAnySources()) {
      // Don't block plugin load — fetch in background
      void this.calendarService.refreshAll(false);
    }
    this.calendarService.startAutoRefresh();
  }

  async onunload(): Promise<void> {
    console.log("Joner GTD: aflæst");
    this.calendarService?.stopAutoRefresh();
  }

  async loadSettings(): Promise<void> {
    const data = await this.loadData();
    this.settings = Object.assign({}, DEFAULT_SETTINGS, data ?? {});
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  /** Genstart kalender-auto-refresh efter ændring i interval-indstilling. */
  rescheduleCalendarRefresh(): void {
    this.calendarService.startAutoRefresh();
  }

  /** Fortæl dashboard-views at kalender-data er opdateret. */
  notifyCalendarUpdated(): void {
    this.app.workspace.trigger(CALENDAR_UPDATED_EVENT);
  }

  openPluginSettings(): void {
    // @ts-ignore — Obsidian's internal API
    this.app.setting?.open?.();
    // @ts-ignore
    this.app.setting?.openTabById?.(this.manifest.id);
  }

  /** Åbn dashboard i hovedvinduet (eller fokusér eksisterende). */
  async activateDashboard(): Promise<void> {
    const { workspace } = this.app;
    const existing = workspace.getLeavesOfType(VIEW_TYPE_DASHBOARD);
    let leaf: WorkspaceLeaf;

    if (existing.length > 0) {
      leaf = existing[0];
    } else {
      leaf = workspace.getLeaf(false);
      await leaf.setViewState({
        type: VIEW_TYPE_DASHBOARD,
        active: true,
      });
    }

    workspace.revealLeaf(leaf);
  }

  /** Åbn Næste & Afventer i højre sidebar. */
  async activateActionSidebar(): Promise<void> {
    const { workspace } = this.app;
    const existing = workspace.getLeavesOfType(VIEW_TYPE_ACTION_SIDEBAR);
    let leaf: WorkspaceLeaf | null;

    if (existing.length > 0) {
      leaf = existing[0];
    } else {
      leaf = workspace.getRightLeaf(false);
      if (leaf) {
        await leaf.setViewState({
          type: VIEW_TYPE_ACTION_SIDEBAR,
          active: true,
        });
      }
    }

    if (leaf) workspace.revealLeaf(leaf);
  }

  /** Append en task til Inbox-filen. */
  async appendToInbox(text: string): Promise<void> {
    await ensureFolder(this.app, GTD_FOLDER);
    const file = await this.ensureInboxFile();
    const taskLine = `- [ ] ${text} ➕ ${todayISO()}`;
    const current = await this.app.vault.read(file);
    const needsNewline = current.length > 0 && !current.endsWith("\n");
    const next = current + (needsNewline ? "\n" : "") + taskLine + "\n";
    await this.app.vault.modify(file, next);
    new Notice(`📥 Tilføjet til Inbox: "${text}"`);
  }

  async ensureInboxFile(): Promise<TFile> {
    const existing = this.app.vault.getAbstractFileByPath(INBOX_PATH);
    if (existing instanceof TFile) return existing;
    await ensureFolder(this.app, GTD_FOLDER);
    const initial =
      "# Inbox\n\n" +
      "Usorterede tanker, ideer og to-do's. " +
      "Behandl regelmæssigt: hvad er det? Er det handlingsorienteret?\n\n";
    return await this.app.vault.create(INBOX_PATH, initial);
  }
}

/** Hurtig capture-modal — bruges når man IKKE er i dashboard. */
class QuickCaptureModal extends Modal {
  private readonly onSubmit: (text: string) => Promise<void>;
  private inputEl!: HTMLInputElement;

  constructor(app: App, onSubmit: (text: string) => Promise<void>) {
    super(app);
    this.onSubmit = onSubmit;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();

    contentEl.createEl("h2", { text: "📥 Hurtig capture til Inbox" });

    this.inputEl = contentEl.createEl("input", {
      type: "text",
      attr: {
        placeholder: "Hvad skal du huske? (#tag virker også)",
      },
    });
    this.inputEl.style.width = "100%";
    this.inputEl.style.padding = "10px";
    this.inputEl.style.marginTop = "8px";
    this.inputEl.style.fontSize = "15px";
    this.inputEl.focus();

    const buttonRow = contentEl.createDiv();
    buttonRow.style.marginTop = "14px";
    buttonRow.style.display = "flex";
    buttonRow.style.gap = "8px";
    buttonRow.style.justifyContent = "flex-end";

    const cancelBtn = buttonRow.createEl("button", { text: "Annullér" });
    cancelBtn.onclick = () => this.close();

    const submitBtn = buttonRow.createEl("button", {
      text: "Gem (↵)",
      cls: "mod-cta",
    });
    submitBtn.onclick = () => void this.submit();

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
    const text = this.inputEl.value.trim();
    if (!text) {
      new Notice("Skriv noget før du gemmer");
      return;
    }
    this.close();
    await this.onSubmit(text);
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

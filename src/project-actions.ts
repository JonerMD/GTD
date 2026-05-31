import { App, Modal, Notice, TFile, TFolder } from "obsidian";
import {
  ARCHIVE_DROPPED_FOLDER,
  ARCHIVE_PROJECTS_FOLDER,
  COMPLETED_LOG,
  DROPPED_LOG,
  PROJECTS_FOLDER,
  SOMEDAY_LOG,
  appendToLog,
  currentYear,
  ensureFolder,
  isActiveProject,
  isProjectFileEmpty,
  projectTemplate,
  safeFileName,
  setFrontmatterFields,
  todayISO,
} from "./project-utils";

/** Bed brugeren om projektnavn + valgfri undergruppe. Returnerer den oprettede fil (eller null). */
export function createProject(app: App): Promise<TFile | null> {
  return new Promise<TFile | null>((resolve) => {
    const modal = new NewProjectModal(app);
    modal.onResult = resolve;
    modal.open();
  });
}

/** Afslut det aktive projekt (fra current file). */
export async function completeProject(app: App): Promise<void> {
  await transitionProject(app, {
    targetStatus: "completed",
    logPath: COMPLETED_LOG,
    logTitle: "Afsluttede projekter",
    formatLogLine: (name) =>
      `- [x] [[${name}]] — afsluttet ${todayISO()}`,
    archiveFolder: ARCHIVE_PROJECTS_FOLDER,
    markTasksDone: true,
    verb: "afsluttet",
  });
}

/** Drop det aktive projekt. */
export async function dropProject(app: App): Promise<void> {
  await transitionProject(app, {
    targetStatus: "dropped",
    logPath: DROPPED_LOG,
    logTitle: "Droppede projekter",
    formatLogLine: (name) =>
      `- ~~[[${name}]]~~ — droppet ${todayISO()}`,
    archiveFolder: ARCHIVE_DROPPED_FOLDER,
    markTasksDone: false,
    verb: "droppet",
  });
}

/** Flyt projektet til Someday/Maybe. */
export async function defererProjectToSomeday(app: App): Promise<void> {
  await transitionProject(app, {
    targetStatus: "someday",
    logPath: SOMEDAY_LOG,
    logTitle: "Someday / Maybe",
    formatLogLine: (name) => `- [[${name}]] — parkeret ${todayISO()}`,
    archiveFolder: null, // someday-projekter arkiveres ikke; rige sider bliver
    markTasksDone: false,
    verb: "parkeret som someday",
  });
}

interface TransitionOptions {
  targetStatus: "completed" | "dropped" | "someday";
  logPath: string;
  logTitle: string;
  formatLogLine: (name: string) => string;
  archiveFolder: string | null;
  markTasksDone: boolean;
  verb: string;
}

async function transitionProject(
  app: App,
  opts: TransitionOptions
): Promise<void> {
  const file = app.workspace.getActiveFile();
  if (!file) {
    new Notice("Åbn et projekt først.");
    return;
  }
  if (!isActiveProject(app, file)) {
    new Notice("Denne fil er ikke markeret som et aktivt projekt.");
    return;
  }

  const name = file.basename;
  const content = await app.vault.read(file);
  const empty = isProjectFileEmpty(content);

  // Markér alle åbne tasks som done hvis relevant
  let updated = content;
  if (opts.markTasksDone) {
    updated = updated.replace(
      /^(\s*-\s*)\[\s\]/gm,
      `$1[x]`
    );
  }

  // Opdater frontmatter med target-status + datostempel
  const stampField =
    opts.targetStatus === "completed"
      ? "gtd-completed"
      : opts.targetStatus === "dropped"
      ? "gtd-dropped"
      : "gtd-someday-since";
  updated = setFrontmatterFields(updated, {
    "gtd-status": opts.targetStatus,
    [stampField]: todayISO(),
  });

  await app.vault.modify(file, updated);

  // Tilføj log-linje
  await appendToLog(app, opts.logPath, opts.logTitle, opts.formatLogLine(name));

  // Hvis tom side + arkiv-mappe defineret → flyt
  if (empty && opts.archiveFolder) {
    const yearFolder = `${opts.archiveFolder}/${currentYear()}`;
    await ensureFolder(app, yearFolder);
    const newPath = `${yearFolder}/${file.name}`;
    await app.fileManager.renameFile(file, newPath);
    new Notice(`✅ Projekt ${opts.verb} og arkiveret.`);
    return;
  }

  if (empty && !opts.archiveFolder) {
    // someday + tom: filen bliver i Projects/, men status er someday
    // Next Actions filtrerer den allerede ud via gtd-status
    new Notice(`💤 Projekt ${opts.verb}.`);
    return;
  }

  new Notice(`✅ Projekt ${opts.verb} (siden bliver — har andet indhold).`);
}

/** Modal til projektnavn + undergruppe. */
class NewProjectModal extends Modal {
  onResult: (file: TFile | null) => void = () => {};
  private submitted = false;
  private nameEl!: HTMLInputElement;
  private folderEl!: HTMLInputElement;

  constructor(app: App) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: "📁 Nyt projekt" });

    // Projektnavn
    contentEl.createEl("label", {
      text: "Projektnavn",
      cls: "setting-item-name",
    });
    this.nameEl = contentEl.createEl("input", {
      type: "text",
      attr: { placeholder: "Fx Renovering af badeværelse" },
    });
    this.styleInput(this.nameEl);
    this.nameEl.focus();

    // Undergruppe
    contentEl.createEl("label", {
      text: "Undergruppe (valgfri)",
      cls: "setting-item-name",
    });
    this.folderEl = contentEl.createEl("input", {
      type: "text",
      attr: {
        placeholder: "Fx Hospital · Hjemme · Firma (tom = ingen)",
        list: "gtd-folder-suggestions",
      },
    });
    this.styleInput(this.folderEl);

    // Autocomplete fra eksisterende undermapper
    const folders = this.findExistingFolders();
    if (folders.length > 0) {
      const list = contentEl.createEl("datalist", {
        attr: { id: "gtd-folder-suggestions" },
      });
      for (const f of folders) {
        list.createEl("option", { value: f });
      }
    }

    contentEl.createEl("p", {
      text: "Filen oprettes som GTD/Projects/[undergruppe]/[navn].md",
      cls: "setting-item-description",
    });

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

    for (const input of [this.nameEl, this.folderEl]) {
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

  private findExistingFolders(): string[] {
    const folder = this.app.vault.getAbstractFileByPath(PROJECTS_FOLDER);
    if (!(folder instanceof TFolder)) return [];
    const result: string[] = [];
    const traverse = (f: TFolder, prefix: string) => {
      for (const child of f.children) {
        if (child instanceof TFolder) {
          const rel = prefix ? `${prefix}/${child.name}` : child.name;
          result.push(rel);
          traverse(child, rel);
        }
      }
    };
    traverse(folder, "");
    return result.sort((a, b) => a.localeCompare(b, "da"));
  }

  private async submit(): Promise<void> {
    const name = this.nameEl.value.trim();
    if (!name) {
      new Notice("Skriv et projektnavn først.");
      return;
    }
    const safe = safeFileName(name);
    if (!safe) {
      new Notice("Ugyldigt projektnavn.");
      return;
    }
    const subfolder = this.folderEl.value.trim().replace(/^\/+|\/+$/g, "");
    const targetFolder = subfolder
      ? `${PROJECTS_FOLDER}/${subfolder}`
      : PROJECTS_FOLDER;
    const path = `${targetFolder}/${safe}.md`;
    const existing = this.app.vault.getAbstractFileByPath(path);
    if (existing) {
      new Notice(`Et projekt "${safe}" findes allerede her.`);
      return;
    }
    await ensureFolder(this.app, targetFolder);
    const file = await this.app.vault.create(path, projectTemplate(safe));
    new Notice(`📁 Oprettet: ${safe}`);
    this.submitted = true;
    this.onResult(file);
    this.close();
  }

  onClose(): void {
    this.contentEl.empty();
    if (!this.submitted) this.onResult(null);
  }
}

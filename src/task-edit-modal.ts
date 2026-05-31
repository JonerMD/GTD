import { App, Modal, Notice, TFile } from "obsidian";
import { Task } from "./task";
import { INBOX_PATH, SINGLE_TASKS_PATH, todayISO } from "./project-utils";

/** Modal til at redigere en eksisterende task: tekst, tags, due, defer, done-status. */
export class TaskEditModal extends Modal {
  private task: Task;
  private textEl!: HTMLInputElement;
  private tagsEl!: HTMLInputElement;
  private dueEl!: HTMLInputElement;
  private deferEl!: HTMLInputElement;
  private doneEl!: HTMLInputElement;

  constructor(app: App, task: Task) {
    super(app);
    this.task = task;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: "✏️ Rediger task" });

    const sourceLabel =
      this.task.file.path === INBOX_PATH
        ? "Inbox"
        : this.task.file.path === SINGLE_TASKS_PATH
        ? "Single Tasks"
        : this.task.file.basename;
    contentEl.createEl("p", {
      text: `Fra: ${sourceLabel}`,
      cls: "setting-item-description",
    });

    // TEKST
    contentEl.createEl("label", { text: "Tekst", cls: "setting-item-name" });
    this.textEl = contentEl.createEl("input", { type: "text" });
    this.textEl.value = this.task.text;
    this.styleInput(this.textEl);
    this.textEl.focus();
    this.textEl.select();

    // TAGS
    contentEl.createEl("label", {
      text: "Tags (rumskilte, uden #)",
      cls: "setting-item-name",
    });
    this.tagsEl = contentEl.createEl("input", {
      type: "text",
      attr: { placeholder: "fx opkald ærinder" },
    });
    this.tagsEl.value = this.task.tags.join(" ");
    this.styleInput(this.tagsEl);

    // DUE
    this.dueEl = this.renderDateField(
      contentEl,
      "Due (📅)",
      this.task.dueDate ?? ""
    );

    // DEFER
    this.deferEl = this.renderDateField(
      contentEl,
      "Defer (⏳)",
      this.task.deferDate ?? ""
    );

    // DONE
    const doneWrap = contentEl.createDiv();
    doneWrap.style.marginTop = "12px";
    doneWrap.style.display = "flex";
    doneWrap.style.alignItems = "center";
    doneWrap.style.gap = "8px";
    this.doneEl = doneWrap.createEl("input", { type: "checkbox" });
    this.doneEl.checked = this.task.done;
    doneWrap.createEl("label", { text: "Afsluttet" });

    // KNAPPER
    const buttonRow = contentEl.createDiv();
    buttonRow.style.marginTop = "18px";
    buttonRow.style.display = "flex";
    buttonRow.style.gap = "8px";
    buttonRow.style.justifyContent = "space-between";

    const leftBtns = buttonRow.createDiv();
    leftBtns.style.display = "flex";
    leftBtns.style.gap = "8px";

    const sourceBtn = leftBtns.createEl("button", {
      text: "Åbn kildefil",
    });
    sourceBtn.onclick = async () => {
      this.close();
      const leaf = this.app.workspace.getLeaf(false);
      await leaf.openFile(this.task.file, {
        eState: { line: this.task.lineNumber },
      });
    };

    const deleteBtn = leftBtns.createEl("button", { text: "🗑 Slet" });
    deleteBtn.onclick = async () => {
      // Vis confirm i selve modalen — undgå at lukke for tidligt
      const confirmed = window.confirm(
        `Slet tasken helt fra "${sourceLabel}"?\n\n"${this.task.text}"`
      );
      if (!confirmed) return;
      await this.deleteTask();
    };

    const rightBtns = buttonRow.createDiv();
    rightBtns.style.display = "flex";
    rightBtns.style.gap = "8px";

    const cancelBtn = rightBtns.createEl("button", { text: "Annullér" });
    cancelBtn.onclick = () => this.close();

    const submitBtn = rightBtns.createEl("button", {
      text: "Gem (↵)",
      cls: "mod-cta",
    });
    submitBtn.onclick = () => void this.save();

    // Keyboard shortcuts
    for (const input of [this.textEl, this.tagsEl, this.dueEl, this.deferEl]) {
      input.addEventListener("keydown", (e: KeyboardEvent) => {
        if (e.key === "Enter") {
          e.preventDefault();
          void this.save();
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
    input.style.marginBottom = "8px";
    input.style.fontSize = "14px";
  }

  private renderDateField(
    parent: HTMLElement,
    label: string,
    initialValue: string
  ): HTMLInputElement {
    parent.createEl("label", { text: label, cls: "setting-item-name" });
    const row = parent.createDiv();
    row.style.display = "flex";
    row.style.gap = "8px";
    row.style.marginTop = "4px";
    row.style.marginBottom = "4px";

    const input = row.createEl("input", { type: "date" });
    input.value = initialValue;
    input.style.flex = "1";
    input.style.padding = "6px 8px";
    input.style.fontSize = "13px";

    const clearBtn = row.createEl("button", { text: "×" });
    clearBtn.style.padding = "4px 10px";
    clearBtn.onclick = () => {
      input.value = "";
    };

    // Quick-add row
    const quickRow = parent.createDiv();
    quickRow.style.display = "flex";
    quickRow.style.gap = "4px";
    quickRow.style.marginBottom = "10px";

    const shortcuts: { label: string; addDays?: number; addMonths?: number }[] =
      [
        { label: "+1d", addDays: 1 },
        { label: "+5d", addDays: 5 },
        { label: "+1u", addDays: 7 },
        { label: "+1m", addMonths: 1 },
      ];
    for (const sc of shortcuts) {
      const btn = quickRow.createEl("button", { text: sc.label });
      btn.style.padding = "3px 8px";
      btn.style.fontSize = "11px";
      btn.onclick = () => {
        const base = input.value
          ? new Date(input.value + "T00:00:00")
          : new Date();
        if (sc.addDays !== undefined) base.setDate(base.getDate() + sc.addDays);
        if (sc.addMonths !== undefined)
          base.setMonth(base.getMonth() + sc.addMonths);
        const y = base.getFullYear();
        const m = String(base.getMonth() + 1).padStart(2, "0");
        const d = String(base.getDate()).padStart(2, "0");
        input.value = `${y}-${m}-${d}`;
      };
    }
    return input;
  }

  private async save(): Promise<void> {
    const text = this.textEl.value.trim();
    if (!text) {
      new Notice("Task-teksten må ikke være tom.");
      return;
    }

    // Bevar oprindelig indrykning (whitespace prefix)
    const leadingWs = this.task.rawLine.match(/^\s*/)?.[0] ?? "";

    const newDone = this.doneEl.checked;
    const checkmark = newDone ? "[x]" : "[ ]";

    const newTags = this.tagsEl.value
      .trim()
      .split(/\s+/)
      .map((t) => t.replace(/^#/, ""))
      .filter((t) => t.length > 0);

    const parts: string[] = [`${leadingWs}- ${checkmark}`, text];
    if (newTags.length > 0) {
      parts.push(newTags.map((t) => `#${t}`).join(" "));
    }
    if (this.dueEl.value) parts.push(`📅 ${this.dueEl.value}`);
    if (this.deferEl.value) parts.push(`⏳ ${this.deferEl.value}`);
    if (this.task.createdDate) parts.push(`➕ ${this.task.createdDate}`);
    if (newDone) {
      // Hvis task lige er afsluttet, tilføj ✅ i dag.
      // Hvis allerede afsluttet, bevar evt. eksisterende ✅ dato (læs fra rawLine)
      const existingCompleted = this.task.rawLine.match(/✅\s*(\d{4}-\d{2}-\d{2})/);
      const completedDate =
        this.task.done && existingCompleted
          ? existingCompleted[1]
          : todayISO();
      parts.push(`✅ ${completedDate}`);
    }

    const newLine = parts.join(" ");

    try {
      const content = await this.app.vault.read(this.task.file);
      const lines = content.split("\n");
      if (this.task.lineNumber >= lines.length) {
        new Notice("Kunne ikke finde linjen — filen er måske ændret.");
        return;
      }
      lines[this.task.lineNumber] = newLine;
      await this.app.vault.modify(this.task.file, lines.join("\n"));
      new Notice("✓ Task opdateret");
      this.close();
    } catch (err) {
      console.error("Joner GTD: fejl ved task-redigering", err);
      new Notice("Kunne ikke gemme. Tjek konsollen for detaljer.");
    }
  }

  private async deleteTask(): Promise<void> {
    try {
      const content = await this.app.vault.read(this.task.file);
      const lines = content.split("\n");
      if (this.task.lineNumber >= lines.length) {
        new Notice("Kunne ikke finde linjen — filen er måske ændret.");
        return;
      }
      // Slet linjen helt
      lines.splice(this.task.lineNumber, 1);
      await this.app.vault.modify(this.task.file, lines.join("\n"));
      new Notice("🗑 Task slettet");
      this.close();
    } catch (err) {
      console.error("Joner GTD: fejl ved task-sletning", err);
      new Notice("Kunne ikke slette. Tjek konsollen.");
    }
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

/** Helper: tjek om en task er tagget som awaiting (#afventer, #awaiting, #afventer-svar). */
export function isTaskAwaitingTagged(task: Task): boolean {
  return task.tags.some((t) => {
    const lower = t.toLowerCase();
    return (
      lower === "afventer" ||
      lower === "awaiting" ||
      lower === "afventer-svar"
    );
  });
}

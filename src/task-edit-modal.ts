import { App, Modal, Notice, TFile } from "obsidian";
import { Task, assignParents, parseTaskLine } from "./task";
import {
  INBOX_PATH,
  SINGLE_TASKS_PATH,
  appendSomedayItem,
  parseDateExpression,
  todayISO,
} from "./project-utils";

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

    // RÆKKEFØLGE & HIERARKI
    contentEl.createEl("label", {
      text: "Rækkefølge & hierarki",
      cls: "setting-item-name",
    });
    const hierWrap = contentEl.createDiv();
    hierWrap.style.marginTop = "4px";
    hierWrap.style.display = "flex";
    hierWrap.style.flexWrap = "wrap";
    hierWrap.style.gap = "6px";

    const upBtn = hierWrap.createEl("button", { text: "▲ Flyt op" });
    upBtn.onclick = () => void this.moveBlock(-1);
    const downBtn = hierWrap.createEl("button", { text: "▼ Flyt ned" });
    downBtn.onclick = () => void this.moveBlock(1);
    const outdentBtn = hierWrap.createEl("button", { text: "⇤ Ryk ud" });
    outdentBtn.onclick = () => void this.changeIndent(-1);
    const indentBtn = hierWrap.createEl("button", { text: "⇥ Ryk ind" });
    indentBtn.onclick = () => void this.changeIndent(1);

    // NY UNDEROPGAVE
    const subWrap = contentEl.createDiv();
    subWrap.style.marginTop = "10px";
    subWrap.style.display = "flex";
    subWrap.style.gap = "6px";
    const subInput = subWrap.createEl("input", {
      type: "text",
      attr: { placeholder: "Ny underopgave under denne task…" },
    });
    subInput.style.flex = "1";
    subInput.style.padding = "6px 8px";
    subInput.style.fontSize = "13px";
    const addSubBtn = subWrap.createEl("button", {
      text: "➕ Tilføj",
      cls: "mod-cta",
    });
    const doAddSub = async () => {
      const t = subInput.value.trim();
      if (!t) return;
      const ok = await this.addSubtask(t);
      if (ok) {
        subInput.value = "";
        subInput.focus();
      }
    };
    addSubBtn.onclick = () => void doAddSub();
    subInput.addEventListener("keydown", (e: KeyboardEvent) => {
      if (e.key === "Enter") {
        e.preventDefault();
        void doAddSub();
      }
    });

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

    const somedayBtn = leftBtns.createEl("button", { text: "💤 Til Someday" });
    somedayBtn.onclick = async () => {
      await this.moveToSomeday();
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
    row.style.marginBottom = "10px";

    // Ét tekstfelt: forstår både "+1d", "11/02/2026" og "2026-02-11"
    const input = row.createEl("input", {
      type: "text",
      attr: { placeholder: "+1d · 11/02/2026 · tom = ingen" },
    });
    input.value = initialValue;
    input.style.flex = "1";
    input.style.padding = "6px 8px";
    input.style.fontSize = "13px";

    const apply = () => {
      const raw = input.value.trim();
      if (raw === "") return;
      const parsed = parseDateExpression(raw);
      if (!parsed) {
        new Notice(
          `Forstod ikke "${raw}". Brug fx +1d, +2m, 11/02/2026 eller 2026-02-11.`
        );
        return;
      }
      input.value = parsed;
    };
    input.addEventListener("keydown", (e: KeyboardEvent) => {
      if (e.key === "Enter") {
        e.preventDefault();
        apply();
      }
    });
    input.addEventListener("blur", () => apply());

    const clearBtn = row.createEl("button", { text: "×" });
    clearBtn.style.padding = "4px 10px";
    clearBtn.onclick = () => {
      input.value = "";
    };

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

    // Normalisér dato-felterne (i tilfælde af at et udtryk ikke er blevet anvendt endnu)
    const normalizeDate = (raw: string): string => {
      const v = raw.trim();
      if (!v) return "";
      return parseDateExpression(v) ?? "";
    };
    const dueVal = normalizeDate(this.dueEl.value);
    const deferVal = normalizeDate(this.deferEl.value);

    const parts: string[] = [`${leadingWs}- ${checkmark}`, text];
    if (newTags.length > 0) {
      parts.push(newTags.map((t) => `#${t}`).join(" "));
    }
    if (dueVal) parts.push(`📅 ${dueVal}`);
    if (deferVal) parts.push(`⏳ ${deferVal}`);
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

  /** Ryk tasken (med dens sub-tasks) ind/ud i hierarkiet. */
  private async changeIndent(delta: 1 | -1): Promise<void> {
    try {
      const content = await this.app.vault.read(this.task.file);
      const lines = content.split("\n");
      const start = this.task.lineNumber;
      if (start >= lines.length) return;

      const indentOf = (l: string): number => {
        let n = 0;
        for (const c of l) {
          if (c === " ") n++;
          else if (c === "\t") n += 4;
          else break;
        }
        return n;
      };

      const baseIndent = indentOf(lines[start]);
      // Blok = task-linjen + efterfølgende mere-indrykkede linjer
      let end = start + 1;
      while (end < lines.length) {
        const l = lines[end];
        if (l.trim() === "") break;
        if (indentOf(l) > baseIndent) end++;
        else break;
      }

      if (delta === 1) {
        // Ryk ind: tilføj en tab til hele blokken
        for (let i = start; i < end; i++) lines[i] = "\t" + lines[i];
      } else {
        if (baseIndent === 0) {
          new Notice("Tasken er allerede yderst.");
          return;
        }
        // Ryk ud: fjern ét niveau (en tab eller op til 4 mellemrum) fra hver linje
        for (let i = start; i < end; i++) {
          lines[i] = lines[i].replace(/^(\t| {1,4})/, "");
        }
      }

      await this.app.vault.modify(this.task.file, lines.join("\n"));
      new Notice(delta === 1 ? "⇥ Rykket ind" : "⇤ Rykket ud");
      this.close();
    } catch (err) {
      console.error("Joner GTD: fejl ved indrykning", err);
      new Notice("Kunne ikke ændre hierarki.");
    }
  }

  /** Beregn indrykning af en linje (tab = 4). */
  private indentOf(l: string): number {
    let n = 0;
    for (const c of l) {
      if (c === " ") n++;
      else if (c === "\t") n += 4;
      else break;
    }
    return n;
  }

  /** [start, end) for tasken + dens efterfølgende mere-indrykkede linjer. */
  private blockRange(lines: string[], start: number, indent: number): [number, number] {
    let end = start + 1;
    while (end < lines.length) {
      const l = lines[end];
      if (l.trim() === "") break;
      if (this.indentOf(l) > indent) end++;
      else break;
    }
    return [start, end];
  }

  /** Flyt tasken (med dens sub-tasks) op/ned forbi nabo-søskende. */
  private async moveBlock(dir: -1 | 1): Promise<void> {
    try {
      const content = await this.app.vault.read(this.task.file);
      const lines = content.split("\n");

      // Parse alle tasks i filen for at finde søskende
      const tasks: Task[] = [];
      for (let i = 0; i < lines.length; i++) {
        const parsed = parseTaskLine(lines[i], this.task.file, i);
        if (parsed) tasks.push(parsed);
      }
      assignParents(tasks);

      const me = tasks.find((t) => t.lineNumber === this.task.lineNumber);
      if (!me) {
        new Notice("Kunne ikke finde tasken — filen er måske ændret.");
        return;
      }
      const siblings = tasks
        .filter((t) => t.indent === me.indent && t.parentLine === me.parentLine)
        .sort((a, b) => a.lineNumber - b.lineNumber);
      const idx = siblings.findIndex((t) => t.lineNumber === me.lineNumber);
      const target = siblings[idx + dir];
      if (!target) {
        new Notice(dir === -1 ? "Allerede øverst." : "Allerede nederst.");
        return;
      }

      const [bStart, bEnd] = this.blockRange(lines, me.lineNumber, me.indent);
      const [tStart, tEnd] = this.blockRange(
        lines,
        target.lineNumber,
        target.indent
      );

      let newLines: string[];
      if (dir === -1) {
        newLines = [
          ...lines.slice(0, tStart),
          ...lines.slice(bStart, bEnd),
          ...lines.slice(tEnd, bStart),
          ...lines.slice(tStart, tEnd),
          ...lines.slice(bEnd),
        ];
      } else {
        newLines = [
          ...lines.slice(0, bStart),
          ...lines.slice(tStart, tEnd),
          ...lines.slice(bEnd, tStart),
          ...lines.slice(bStart, bEnd),
          ...lines.slice(tEnd),
        ];
      }

      await this.app.vault.modify(this.task.file, newLines.join("\n"));
      new Notice(dir === -1 ? "▲ Flyttet op" : "▼ Flyttet ned");
      this.close();
    } catch (err) {
      console.error("Joner GTD: fejl ved flytning", err);
      new Notice("Kunne ikke flytte tasken.");
    }
  }

  /** Indsæt en ny underopgave (et niveau dybere) sidst blandt tasken's børn.
   *  Returnerer true ved succes. Lukker IKKE modalen (så man kan tilføje flere). */
  private async addSubtask(text: string): Promise<boolean> {
    try {
      const content = await this.app.vault.read(this.task.file);
      const lines = content.split("\n");
      const start = this.task.lineNumber;
      if (start >= lines.length) return false;

      // Bevar tasken's leading whitespace, tilføj én tab for barnet
      const leadingWs = lines[start].match(/^\s*/)?.[0] ?? "";
      const childPrefix = leadingWs + "\t";

      const baseIndent = this.indentOf(lines[start]);
      const [, blockEnd] = this.blockRange(lines, start, baseIndent);

      const newLine = `${childPrefix}- [ ] ${text} ➕ ${todayISO()}`;
      lines.splice(blockEnd, 0, newLine);

      await this.app.vault.modify(this.task.file, lines.join("\n"));
      new Notice(`➕ Underopgave tilføjet: ${text}`);
      return true;
    } catch (err) {
      console.error("Joner GTD: fejl ved underopgave", err);
      new Notice("Kunne ikke tilføje underopgave.");
      return false;
    }
  }

  /** Flyt tasken til Someday-listen (append til Someday.md + fjern fra kilden). */
  private async moveToSomeday(): Promise<void> {
    try {
      // Brug den nuværende tekst i feltet (så evt. redigering tages med)
      const text = this.textEl.value.trim() || this.task.text;
      await appendSomedayItem(this.app, text);

      const content = await this.app.vault.read(this.task.file);
      const lines = content.split("\n");
      if (this.task.lineNumber < lines.length) {
        lines.splice(this.task.lineNumber, 1);
        await this.app.vault.modify(this.task.file, lines.join("\n"));
      }
      new Notice("💤 Flyttet til Someday / Maybe");
      this.close();
    } catch (err) {
      console.error("Joner GTD: fejl ved flyt til Someday", err);
      new Notice("Kunne ikke flytte. Tjek konsollen.");
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

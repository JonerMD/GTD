import { TFile } from "obsidian";

/** En task fundet i en markdown-fil. */
export interface Task {
  text: string; // ren beskrivelse (uden tags og dato-emojis)
  rawLine: string; // hele den oprindelige linje
  tags: string[]; // ["opkald", "computer"]
  file: TFile; // hvor den ligger
  lineNumber: number; // 0-indekseret
  done: boolean;
  createdDate?: string; // YYYY-MM-DD
  deferDate?: string; // ⏳ YYYY-MM-DD
  dueDate?: string; // 📅 YYYY-MM-DD
  indent: number; // indrykning i tegn (mellemrum/tab = 4)
  parentLine?: number; // linjenummer på parent-task (hvis nested)
}

const TASK_LINE_RE = /^(\s*)-\s*\[([ xX/])\]\s+(.*)$/;
const TAG_RE = /#([\p{L}\p{N}_\-/]+)/gu;
const DEFER_RE = /⏳\s*(\d{4}-\d{2}-\d{2})/;
const DUE_RE = /📅\s*(\d{4}-\d{2}-\d{2})/;
const CREATED_RE = /➕\s*(\d{4}-\d{2}-\d{2})/;

/** Beregn indrykning i "tegn" (tab tæller som 4). */
function computeIndent(line: string): number {
  let indent = 0;
  for (const c of line) {
    if (c === " ") indent++;
    else if (c === "\t") indent += 4;
    else break;
  }
  return indent;
}

/** Eksporteret indrykning-helper (bruges af reorder-logik i view'et). */
export function getLineIndent(line: string): number {
  return computeIndent(line);
}

/** Forsøg at parse én markdown-linje som task. Returnerer null hvis det ikke er en task. */
export function parseTaskLine(
  line: string,
  file: TFile,
  lineNumber: number
): Task | null {
  const m = line.match(TASK_LINE_RE);
  if (!m) return null;

  const status = m[2];
  const body = m[3];
  const done = status === "x" || status === "X";
  const indent = computeIndent(line);

  const tags: string[] = [];
  const tagRe = new RegExp(TAG_RE.source, TAG_RE.flags);
  let tagMatch: RegExpExecArray | null;
  while ((tagMatch = tagRe.exec(body)) !== null) {
    tags.push(tagMatch[1]);
  }

  const deferDate = body.match(DEFER_RE)?.[1];
  const dueDate = body.match(DUE_RE)?.[1];
  const createdDate = body.match(CREATED_RE)?.[1];

  // Ryd tekst: fjern dato-emojis med datoer og fjern tags
  const text = body
    .replace(/➕\s*\d{4}-\d{2}-\d{2}/g, "")
    .replace(/⏳\s*\d{4}-\d{2}-\d{2}/g, "")
    .replace(/📅\s*\d{4}-\d{2}-\d{2}/g, "")
    .replace(new RegExp(TAG_RE.source, TAG_RE.flags), "")
    .replace(/\s+/g, " ")
    .trim();

  // Ignorér tasks der ikke har nogen reel tekst (tomme placeholders)
  if (text.length === 0) return null;

  return {
    text,
    rawLine: line,
    tags,
    file,
    lineNumber,
    done,
    createdDate,
    deferDate,
    dueDate,
    indent,
  };
}

/** Beregn parent-relationer ud fra indrykning. Skal kaldes EFTER alle tasks er parset
 *  fra en fil. Muterer task.parentLine. */
export function assignParents(tasks: Task[]): void {
  const stack: Task[] = [];
  for (const task of tasks) {
    while (stack.length > 0 && stack[stack.length - 1].indent >= task.indent) {
      stack.pop();
    }
    if (stack.length > 0) {
      task.parentLine = stack[stack.length - 1].lineNumber;
    }
    stack.push(task);
  }
}

/** En task er "blokeret" hvis nogen forfader-task er åben (= ikke krydset af). */
export function isBlockedByAncestor(task: Task, allTasks: Task[]): boolean {
  let currentParentLine = task.parentLine;
  while (currentParentLine !== undefined) {
    const parent = allTasks.find((t) => t.lineNumber === currentParentLine);
    if (!parent) return false;
    if (!parent.done) return true;
    currentParentLine = parent.parentLine;
  }
  return false;
}

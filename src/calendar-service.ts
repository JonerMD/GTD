import { Notice, requestUrl } from "obsidian";
import ICAL from "ical.js";
import type JonerGTDPlugin from "./main";
import { CalendarSource } from "./settings";

/** En parset event efter recurrence-ekspansion. */
export interface ParsedEvent {
  uid: string;
  summary: string;
  location?: string;
  /** Hele datoer eller datotider i lokal tid, ISO-format. */
  startISO: string; // "YYYY-MM-DD" for all-day, "YYYY-MM-DDTHH:MM" for timed
  endISO?: string;
  allDay: boolean;
  sourceId: string;
  sourceName: string;
  sourceColor: string;
}

export class CalendarService {
  private plugin: JonerGTDPlugin;
  private cache = new Map<string, ParsedEvent[]>(); // sourceId → events
  private lastFetched = new Map<string, number>(); // sourceId → timestamp
  private refreshTimer: number | null = null;

  constructor(plugin: JonerGTDPlugin) {
    this.plugin = plugin;
  }

  /** Hent alle aktive kilder (med cache-respect medmindre force=true). */
  async refreshAll(force = false): Promise<void> {
    const sources = this.plugin.settings.calendarSources.filter(
      (s) => s.enabled && s.url
    );

    const intervalMs =
      this.plugin.settings.refreshIntervalMinutes * 60 * 1000;
    const now = Date.now();

    const promises = sources.map(async (source) => {
      const last = this.lastFetched.get(source.id) ?? 0;
      if (!force && now - last < intervalMs && this.cache.has(source.id)) {
        return;
      }
      try {
        await this.fetchAndParse(source);
        this.lastFetched.set(source.id, Date.now());
      } catch (err) {
        console.error(`Joner GTD: kunne ikke hente "${source.name}"`, err);
        new Notice(
          `Kalender "${source.name}": kunne ikke hentes. Tjek URL.`
        );
      }
    });

    await Promise.all(promises);
    this.plugin.notifyCalendarUpdated();
  }

  private async fetchAndParse(source: CalendarSource): Promise<void> {
    let url = source.url.trim();
    if (url.startsWith("webcal://")) {
      url = "https://" + url.slice("webcal://".length);
    }
    const response = await requestUrl({ url, method: "GET" });
    const icsText = response.text;
    const events = this.parseIcs(icsText, source);
    this.cache.set(source.id, events);
  }

  private parseIcs(icsText: string, source: CalendarSource): ParsedEvent[] {
    const jcal = ICAL.parse(icsText);
    const root = new ICAL.Component(jcal);
    const vevents = root.getAllSubcomponents("vevent");

    // Range: dagens dato → forecast-grænse
    const now = new Date();
    const rangeStart = startOfDay(now);
    const rangeEnd = new Date(rangeStart);
    rangeEnd.setDate(
      rangeEnd.getDate() + this.plugin.settings.forecastDays + 1
    );

    const out: ParsedEvent[] = [];

    for (const vevent of vevents) {
      const event = new ICAL.Event(vevent);
      try {
        if (event.isRecurring()) {
          this.expandRecurring(event, rangeStart, rangeEnd, source, out);
        } else {
          const startJs = event.startDate.toJSDate();
          const endJs = event.endDate.toJSDate();
          if (endJs < rangeStart || startJs >= rangeEnd) continue;
          out.push(this.makeEvent(event, startJs, endJs, source));
        }
      } catch (err) {
        // Skip malformed event silently
        console.warn("Joner GTD: kunne ikke parse event", err);
      }
    }
    return out;
  }

  private expandRecurring(
    event: ICAL.Event,
    rangeStart: Date,
    rangeEnd: Date,
    source: CalendarSource,
    out: ParsedEvent[]
  ): void {
    const duration =
      event.endDate.toJSDate().getTime() -
      event.startDate.toJSDate().getTime();
    const iter = event.iterator();
    let next: ICAL.Time | null;
    let safety = 0;
    while ((next = iter.next())) {
      safety++;
      if (safety > 5000) break; // hård guard
      const startJs = next.toJSDate();
      if (startJs >= rangeEnd) break;
      const endJs = new Date(startJs.getTime() + duration);
      if (endJs < rangeStart) continue;
      // Brug occurrence details for at få korrekte felter (fx ved EXDATE)
      const details = event.getOccurrenceDetails(next);
      out.push(
        this.makeEvent(
          details.item ?? event,
          details.startDate.toJSDate(),
          details.endDate.toJSDate(),
          source
        )
      );
    }
  }

  private makeEvent(
    event: ICAL.Event,
    startJs: Date,
    endJs: Date,
    source: CalendarSource
  ): ParsedEvent {
    const allDay = event.startDate.isDate;
    return {
      uid: event.uid ?? "",
      summary: event.summary ?? "(uden titel)",
      location: event.location ?? undefined,
      startISO: allDay ? toLocalDate(startJs) : toLocalDateTime(startJs),
      endISO: allDay ? toLocalDate(endJs) : toLocalDateTime(endJs),
      allDay,
      sourceId: source.id,
      sourceName: source.name,
      sourceColor: source.color,
    };
  }

  /** Hent events der overlapper med en given dato (lokal YYYY-MM-DD). */
  eventsOnDate(dateISO: string): ParsedEvent[] {
    const result: ParsedEvent[] = [];
    for (const events of this.cache.values()) {
      for (const ev of events) {
        if (this.eventOverlapsDate(ev, dateISO)) {
          result.push(ev);
        }
      }
    }
    // Sortér: heldags først, så efter starttid
    result.sort((a, b) => {
      if (a.allDay !== b.allDay) return a.allDay ? -1 : 1;
      return a.startISO.localeCompare(b.startISO);
    });
    return result;
  }

  private eventOverlapsDate(ev: ParsedEvent, dateISO: string): boolean {
    if (ev.allDay) {
      const start = ev.startISO; // YYYY-MM-DD
      // For all-day events, ICS standard: end is EXCLUSIVE next day. ical.js follows.
      const endExclusive = ev.endISO ?? start;
      return dateISO >= start && dateISO < endExclusive;
    }
    const startDate = ev.startISO.slice(0, 10);
    const endDate = ev.endISO?.slice(0, 10) ?? startDate;
    return dateISO >= startDate && dateISO <= endDate;
  }

  startAutoRefresh(): void {
    this.stopAutoRefresh();
    const intervalMs =
      this.plugin.settings.refreshIntervalMinutes * 60 * 1000;
    this.refreshTimer = window.setInterval(() => {
      void this.refreshAll(false);
    }, intervalMs);
  }

  stopAutoRefresh(): void {
    if (this.refreshTimer !== null) {
      window.clearInterval(this.refreshTimer);
      this.refreshTimer = null;
    }
  }

  hasAnySources(): boolean {
    return this.plugin.settings.calendarSources.some(
      (s) => s.enabled && s.url
    );
  }
}

function startOfDay(d: Date): Date {
  const out = new Date(d);
  out.setHours(0, 0, 0, 0);
  return out;
}

function pad(n: number): string {
  return String(n).padStart(2, "0");
}

function toLocalDate(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function toLocalDateTime(d: Date): string {
  return `${toLocalDate(d)}T${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

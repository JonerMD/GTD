import { App, PluginSettingTab, Setting } from "obsidian";
import type JonerGTDPlugin from "./main";

export interface CalendarSource {
  id: string;
  name: string;
  url: string;
  color: string;
  enabled: boolean;
}

export interface JonerGTDSettings {
  calendarSources: CalendarSource[];
  refreshIntervalMinutes: number;
  forecastDays: number;
}

export const DEFAULT_SETTINGS: JonerGTDSettings = {
  calendarSources: [],
  refreshIntervalMinutes: 30,
  forecastDays: 30,
};

function makeId(): string {
  return Math.random().toString(36).slice(2, 10);
}

export class JonerGTDSettingTab extends PluginSettingTab {
  private readonly plugin: JonerGTDPlugin;

  constructor(app: App, plugin: JonerGTDPlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("h2", { text: "Joner GTD — Indstillinger" });

    // ============ Forecast ============
    containerEl.createEl("h3", { text: "Forecast" });

    new Setting(containerEl)
      .setName("Antal dage frem")
      .setDesc("Hvor mange dage Forecast skal dække (default 30).")
      .addText((text) =>
        text
          .setPlaceholder("30")
          .setValue(String(this.plugin.settings.forecastDays))
          .onChange(async (value) => {
            const n = parseInt(value, 10);
            if (Number.isFinite(n) && n > 0 && n <= 365) {
              this.plugin.settings.forecastDays = n;
              await this.plugin.saveSettings();
            }
          })
      );

    new Setting(containerEl)
      .setName("Refresh-interval (minutter)")
      .setDesc("Hvor ofte kalender-data hentes på ny.")
      .addText((text) =>
        text
          .setPlaceholder("30")
          .setValue(String(this.plugin.settings.refreshIntervalMinutes))
          .onChange(async (value) => {
            const n = parseInt(value, 10);
            if (Number.isFinite(n) && n > 0 && n <= 1440) {
              this.plugin.settings.refreshIntervalMinutes = n;
              await this.plugin.saveSettings();
              this.plugin.rescheduleCalendarRefresh();
            }
          })
      );

    // ============ Kalender-kilder ============
    containerEl.createEl("h3", { text: "Kalender-kilder" });
    containerEl.createEl("p", {
      text:
        "Tilføj én eller flere offentliggjorte iCal-URL'er fra Apple Calendar " +
        "(højreklik på kalender → Share Calendar → Public Calendar). " +
        "URL'er der starter med webcal:// konverteres automatisk til https://.",
      cls: "setting-item-description",
    });

    for (const source of this.plugin.settings.calendarSources) {
      this.renderSourceRow(containerEl, source);
    }

    new Setting(containerEl).addButton((btn) =>
      btn
        .setButtonText("+ Tilføj kalender")
        .setCta()
        .onClick(async () => {
          this.plugin.settings.calendarSources.push({
            id: makeId(),
            name: "Ny kalender",
            url: "",
            color: "#4a90e2",
            enabled: true,
          });
          await this.plugin.saveSettings();
          this.display();
        })
    );

    new Setting(containerEl)
      .addButton((btn) =>
        btn
          .setButtonText("↻ Refresh alle kalendere nu")
          .onClick(async () => {
            await this.plugin.calendarService.refreshAll(true);
          })
      )
      .addExtraButton((btn) =>
        btn
          .setIcon("info")
          .setTooltip("Henter alle aktive kalendere fra deres URL'er")
      );
  }

  private renderSourceRow(containerEl: HTMLElement, source: CalendarSource): void {
    const wrap = containerEl.createDiv({ cls: "gtd-source-row" });
    wrap.style.border = "1px solid var(--background-modifier-border)";
    wrap.style.borderRadius = "6px";
    wrap.style.padding = "10px";
    wrap.style.marginBottom = "8px";

    // Top row: navn + farve + enabled toggle + delete
    const top = wrap.createDiv();
    top.style.display = "flex";
    top.style.gap = "8px";
    top.style.alignItems = "center";
    top.style.marginBottom = "8px";

    const colorInput = top.createEl("input", {
      type: "color",
      attr: { value: source.color },
    });
    colorInput.style.width = "32px";
    colorInput.style.height = "32px";
    colorInput.style.padding = "0";
    colorInput.style.border = "none";
    colorInput.style.cursor = "pointer";
    colorInput.onchange = async () => {
      source.color = colorInput.value;
      await this.plugin.saveSettings();
    };

    const nameInput = top.createEl("input", {
      type: "text",
      attr: { placeholder: "Navn (fx Privat, Patienter)", value: source.name },
    });
    nameInput.style.flex = "1";
    nameInput.style.padding = "6px 8px";
    nameInput.onchange = async () => {
      source.name = nameInput.value.trim() || "Uden navn";
      await this.plugin.saveSettings();
    };

    const enabledLabel = top.createEl("label");
    enabledLabel.style.display = "flex";
    enabledLabel.style.alignItems = "center";
    enabledLabel.style.gap = "4px";
    enabledLabel.style.fontSize = "12px";
    const enabledInput = enabledLabel.createEl("input", { type: "checkbox" });
    enabledInput.checked = source.enabled;
    enabledInput.onchange = async () => {
      source.enabled = enabledInput.checked;
      await this.plugin.saveSettings();
    };
    enabledLabel.appendText("aktiv");

    const deleteBtn = top.createEl("button", { text: "Slet" });
    deleteBtn.onclick = async () => {
      const idx = this.plugin.settings.calendarSources.findIndex(
        (s) => s.id === source.id
      );
      if (idx >= 0) {
        this.plugin.settings.calendarSources.splice(idx, 1);
        await this.plugin.saveSettings();
        this.display();
      }
    };

    // URL felt
    const urlInput = wrap.createEl("input", {
      type: "text",
      attr: {
        placeholder: "webcal://p01-... eller https://...",
        value: source.url,
      },
    });
    urlInput.style.width = "100%";
    urlInput.style.padding = "6px 8px";
    urlInput.style.fontSize = "12px";
    urlInput.style.fontFamily = "var(--font-monospace)";
    urlInput.onchange = async () => {
      source.url = urlInput.value.trim();
      await this.plugin.saveSettings();
    };
  }
}

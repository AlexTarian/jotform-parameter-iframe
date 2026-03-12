(() => {
  "use strict";

  const TOKEN_REGEX = /\{([^{}]+)\}/g;
  const DEFAULT_HEIGHT = 600;
  const DEFAULT_TITLE = "Embedded content";

  const statusEl = document.getElementById("status");
  const frameEl = document.getElementById("embeddedFrame");

  let widgetStarted = false;

  function setStatus(message, type = "info") {
    if (!statusEl) return;

    statusEl.textContent = message;
    statusEl.className = `status status--${type} is-visible`;
  }

  function clearStatus() {
    if (!statusEl) return;
    statusEl.textContent = "";
    statusEl.className = "status status--info";
  }

  function getQuerySettings() {
    const params = new URLSearchParams(window.location.search);
    const settings = {};

    for (const [key, value] of params.entries()) {
      settings[key] = value;
    }

    return settings;
  }

  function getWidgetSettings() {
    const querySettings = getQuerySettings();

    if (
      typeof window.JFCustomWidget !== "undefined" &&
      typeof window.JFCustomWidget.getWidgetSettings === "function"
    ) {
      try {
        return {
          ...querySettings,
          ...window.JFCustomWidget.getWidgetSettings(),
        };
      } catch (error) {
        console.warn("Could not read Jotform widget settings:", error);
      }
    }

    return querySettings;
  }

  function normalizeSettings(raw) {
    const urlTemplate =
      raw.urlTemplate ||
      raw.URL ||
      raw.url ||
      "";

    const iframeTitle =
      raw.iframeTitle ||
      raw.title ||
      DEFAULT_TITLE;

    const iframeHeight = normalizeHeight(
      raw.iframeHeight || raw.height || raw.frameHeight
    );

    const sandbox = typeof raw.iframeSandbox === "string"
      ? raw.iframeSandbox.trim()
      : "";

    return {
      urlTemplate: String(urlTemplate).trim(),
      iframeTitle: String(iframeTitle).trim() || DEFAULT_TITLE,
      iframeHeight,
      iframeSandbox: sandbox,
    };
  }

  function normalizeHeight(value) {
    const parsed = Number.parseInt(String(value || ""), 10);
    if (Number.isFinite(parsed) && parsed >= 200 && parsed <= 4000) {
      return parsed;
    }
    return DEFAULT_HEIGHT;
  }

  function extractTokens(template) {
    return [...template.matchAll(TOKEN_REGEX)].map((match) => match[1]);
  }

  function getFieldIdFromToken(token) {
    const trimmed = String(token).trim();

    // Matches q123_something
    const qMatch = trimmed.match(/^q(\d+)(?:_|$)/i);
    if (qMatch) return qMatch[1];

    // Matches #input_165, #first_3, #last_3, etc.
    const hashMatch = trimmed.match(/^#?[a-zA-Z]+_(\d+)$/);
    if (hashMatch) return hashMatch[1];

    // Matches plain numeric token: 165
    const numericMatch = trimmed.match(/^(\d+)$/);
    if (numericMatch) return numericMatch[1];

    return null;
  }

  function getUniqueFieldIds(tokens) {
    const ids = tokens
      .map(getFieldIdFromToken)
      .filter(Boolean);

    return [...new Set(ids)];
  }
  
function getPreviewFieldValues(tokens) {
  const params = new URLSearchParams(window.location.search);
  const values = {};

  for (const token of tokens) {
    const fieldId = getFieldIdFromToken(token);

    values[token] =
      params.get(token) ??
      params.get(token.replace(/^#/, "")) ??
      (fieldId ? params.get(fieldId) : null) ??
      (fieldId ? params.get(`q${fieldId}`) : null) ??
      "";
  }

  return values;
}

function buildTokenValueMap(tokens, resultData) {
  const valuesById = new Map();

  if (Array.isArray(resultData)) {
    for (const item of resultData) {
      if (!item) continue;

      const rawId = item.id ?? item.qid ?? item.fieldId ?? item.name;
      const value = item.value ?? "";

      if (rawId !== undefined && rawId !== null) {
        const numeric = String(rawId).match(/\d+/);
        if (numeric) {
          valuesById.set(numeric[0], String(value));
        }
      }
    }
  }

  const finalMap = {};
  for (const token of tokens) {
    const fieldId = getFieldIdFromToken(token);
    finalMap[token] = fieldId ? (valuesById.get(fieldId) || "") : "";
  }

  return finalMap;
}

  function replaceTokens(template, tokenValues) {
    return template.replace(TOKEN_REGEX, (_, tokenName) => {
      const rawValue = tokenValues[tokenName] ?? "";
      return encodeURIComponent(String(rawValue));
    });
  }

  function isSafeHttpUrl(value) {
    try {
      const parsed = new URL(value);
      return parsed.protocol === "https:" || parsed.protocol === "http:";
    } catch {
      return false;
    }
  }

  function applyFrameSettings(settings) {
    frameEl.style.height = `${settings.iframeHeight}px`;
    frameEl.title = settings.iframeTitle;

    if (settings.iframeSandbox) {
      frameEl.setAttribute("sandbox", settings.iframeSandbox);
    } else {
      frameEl.removeAttribute("sandbox");
    }

    if (
      typeof window.JFCustomWidget !== "undefined" &&
      typeof window.JFCustomWidget.requestFrameResize === "function"
    ) {
      try {
        window.JFCustomWidget.requestFrameResize({
          height: settings.iframeHeight + 16,
        });
      } catch (error) {
        console.warn("Frame resize request failed:", error);
      }
    }
  }

  class ParameterIframeWidget {
    constructor() {
      this.settings = normalizeSettings(getWidgetSettings());
      this.tokens = extractTokens(this.settings.urlTemplate);
      this.fieldIds = getUniqueFieldIds(this.tokens);
    }

    init() {
      applyFrameSettings(this.settings);

      if (!this.settings.urlTemplate) {
        setStatus("Missing required widget setting: URL or urlTemplate.", "error");
        return;
      }

      this.bindFieldListeners();
      this.updateFrame();
    }

bindFieldListeners() {
  if (
    typeof window.JFCustomWidget === "undefined" ||
    typeof window.JFCustomWidget.listenFromField !== "function"
  ) {
    return;
  }

  for (const token of this.tokens) {
    const fieldId = getFieldIdFromToken(token);
    if (!fieldId) continue;

    const candidates = [
      token,
      token.replace(/^#/, ""),
      `q${fieldId}`,
      fieldId
    ];

    for (const candidate of candidates) {
      try {
        window.JFCustomWidget.listenFromField(candidate, "change", () => {
          this.updateFrame();
        });
      } catch (error) {
        // Quietly try the next format
      }
    }
  }
}

    updateFrame() {
      if (!this.tokens.length) {
        this.setFrameSource(this.settings.urlTemplate);
        return;
      }

      if (
        typeof window.JFCustomWidget === "undefined" ||
        typeof window.JFCustomWidget.getFieldsValueById !== "function"
      ) {
        const previewValues = getPreviewFieldValues(this.tokens);
        const previewUrl = replaceTokens(this.settings.urlTemplate, previewValues);
        this.setFrameSource(previewUrl);
        return;
      }

      try {
        window.JFCustomWidget.getFieldsValueById(this.fieldIds, (response) => {
          const tokenValues = buildTokenValueMap(this.tokens, response?.data);
          const finalUrl = replaceTokens(this.settings.urlTemplate, tokenValues);
          this.setFrameSource(finalUrl);
        });
      } catch (error) {
        console.error("Failed to read Jotform field values:", error);
        setStatus("Could not read Jotform field values.", "error");
      }
    }

    setFrameSource(url) {
      const trimmed = String(url || "").trim();

      if (!trimmed) {
        setStatus("The final iframe URL is empty.", "warn");
        frameEl.removeAttribute("src");
        return;
      }

      if (!isSafeHttpUrl(trimmed)) {
        setStatus(
          "Blocked iframe URL. Only absolute http:// or https:// URLs are allowed.",
          "error"
        );
        frameEl.removeAttribute("src");
        return;
      }

      clearStatus();
      frameEl.src = trimmed;

      if (
        typeof window.JFCustomWidget !== "undefined" &&
        typeof window.JFCustomWidget.sendData === "function"
      ) {
        try {
          window.JFCustomWidget.sendData({
            value: trimmed,
          });
        } catch (error) {
          console.warn("Could not send widget data back to Jotform:", error);
        }
      }
    }
  }
  function startWidget() {
    if (widgetStarted) return;
    widgetStarted = true;

    const widget = new ParameterIframeWidget();
    widget.init();
  }

  document.addEventListener("DOMContentLoaded", () => {
    let readyTriggered = false;

    const safeStart = () => {
      if (readyTriggered) return;
      readyTriggered = true;
      startWidget();
    };

    if (
      typeof window.JFCustomWidget !== "undefined" &&
      typeof window.JFCustomWidget.subscribe === "function"
    ) {
      try {
        window.JFCustomWidget.subscribe("ready", () => {
          safeStart();
        });
      } catch (error) {
        console.warn("JFCustomWidget ready subscription failed:", error);
      }
    }

    // Fallback for standalone GitHub Pages testing
    window.setTimeout(() => {
      safeStart();
    }, 500);
  });
})();

(() => {
  "use strict";

  const TOKEN_REGEX = /\{([^{}]+)\}/g;
  const DEFAULT_HEIGHT = 600;
  const DEFAULT_TITLE = "Embedded content";

  const statusEl = document.getElementById("status");
  const frameEl = document.getElementById("embeddedFrame");
  const debugLogEl = document.getElementById("debugLog");

  let widgetStarted = false;

  function writeDebug(label, value) {
    const line = `[${new Date().toISOString()}] ${label}: ${
      typeof value === "string" ? value : JSON.stringify(value, null, 2)
    }`;

    console.log(line);

    if (debugLogEl) {
      debugLogEl.textContent += `\n${line}`;
    }
  }

  function resetDebug() {
    if (debugLogEl) {
      debugLogEl.textContent = "Widget booting...";
    }
  }

  function setStatus(message, type = "info") {
    if (!statusEl) return;
    statusEl.textContent = message;
    statusEl.className = `status status--${type} is-visible`;
    writeDebug("status", { type, message });
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
        const merged = {
          ...querySettings,
          ...window.JFCustomWidget.getWidgetSettings(),
        };
        writeDebug("widgetSettings", merged);
        return merged;
      } catch (error) {
        console.warn("Could not read Jotform widget settings:", error);
        writeDebug("widgetSettingsError", String(error));
      }
    }

    writeDebug("querySettingsOnly", querySettings);
    return querySettings;
  }

  function normalizeSettings(raw) {
    const urlTemplate = raw.urlTemplate || raw.URL || raw.url || "";
    const iframeTitle = raw.iframeTitle || raw.title || DEFAULT_TITLE;
    const iframeHeight = normalizeHeight(
      raw.iframeHeight || raw.height || raw.frameHeight
    );
    const sandbox =
      typeof raw.iframeSandbox === "string" ? raw.iframeSandbox.trim() : "";

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

    const splitParts = trimmed.split("_");
    if (splitParts.length > 1 && /^\d+$/.test(splitParts[1])) {
      return splitParts[1];
    }

    const qMatch = trimmed.match(/^q(\d+)(?:_|$)/i);
    if (qMatch) return qMatch[1];

    const numericMatch = trimmed.match(/^(\d+)$/);
    if (numericMatch) return numericMatch[1];

    return null;
  }

  function replaceTokensInOrder(template, tokens, values) {
    let fullURL = template;

    tokens.forEach((token, index) => {
      const rawValue = values[index] ?? "";
      fullURL = fullURL.replace(`{${token}}`, encodeURIComponent(String(rawValue)));
    });

    return fullURL;
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
    if (!frameEl) return;

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
        writeDebug("requestFrameResizeError", String(error));
      }
    }
  }

  class ParameterIframeWidget {
    constructor() {
      this.settings = normalizeSettings(getWidgetSettings());
      this.tokens = extractTokens(this.settings.urlTemplate);
      this.fieldIds = this.tokens.map(getFieldIdFromToken).filter(Boolean);

      writeDebug("normalizedSettings", this.settings);
      writeDebug("tokens", this.tokens);
      writeDebug("fieldIds", this.fieldIds);
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
        writeDebug("bindFieldListeners", "JFCustomWidget.listenFromField unavailable");
        return;
      }

      this.tokens.forEach((token) => {
        try {
          window.JFCustomWidget.listenFromField(token, "change", () => {
            writeDebug("fieldChange", token);
            this.updateFrame();
          });
          writeDebug("listenerBound", token);
        } catch (error) {
          writeDebug("listenerBindError", { token, error: String(error) });
        }
      });
    }

    updateFrame() {
      if (!this.tokens.length) {
        writeDebug("noTokens", "Using URL as-is");
        this.setFrameSource(this.settings.urlTemplate);
        return;
      }

      if (
        typeof window.JFCustomWidget === "undefined" ||
        typeof window.JFCustomWidget.getFieldsValueById !== "function"
      ) {
        writeDebug("getFieldsValueById", "Unavailable in standalone mode");
        setStatus("Jotform field API is unavailable in standalone mode.", "warn");
        return;
      }

      try {
        writeDebug("requestFieldValuesById", this.fieldIds);

        window.JFCustomWidget.getFieldsValueById(this.fieldIds, (response) => {
          writeDebug("rawFieldResponse", response);

          const prefills = Array.isArray(response?.data)
            ? response.data.map((item) => item?.value ?? "")
            : [];

          writeDebug("prefillsInOrder", prefills);

          const tokenValuePairs = this.tokens.map((token, index) => ({
            token,
            fieldId: this.fieldIds[index] ?? null,
            value: prefills[index] ?? "",
          }));

          writeDebug("tokenValuePairs", tokenValuePairs);

          const finalUrl = replaceTokensInOrder(
            this.settings.urlTemplate,
            this.tokens,
            prefills
          );

          writeDebug("finalUrl", finalUrl);
          this.setFrameSource(finalUrl);
        });
      } catch (error) {
        console.error("Failed to read Jotform field values:", error);
        writeDebug("updateFrameError", String(error));
        setStatus("Could not read Jotform field values.", "error");
      }
    }

    setFrameSource(url) {
      if (!frameEl) return;

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
      writeDebug("iframeSrcSet", trimmed);

      if (
        typeof window.JFCustomWidget !== "undefined" &&
        typeof window.JFCustomWidget.sendData === "function"
      ) {
        try {
          window.JFCustomWidget.sendData({ value: trimmed });
        } catch (error) {
          writeDebug("sendDataError", String(error));
        }
      }
    }
  }

  function startWidget() {
    if (widgetStarted) return;
    widgetStarted = true;
    resetDebug();
    writeDebug("startup", "Starting widget");

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
          writeDebug("readyEvent", "JFCustomWidget ready fired");
          safeStart();
        });
      } catch (error) {
        writeDebug("readySubscribeError", String(error));
      }
    }

    window.setTimeout(() => {
      writeDebug("readyFallback", "Timeout fallback fired");
      safeStart();
    }, 500);
  });
})();

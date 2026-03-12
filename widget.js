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

  function buildCandidateNames(token) {
    const trimmed = String(token).trim();
    const fieldId = getFieldIdFromToken(trimmed);
    const withoutHash = trimmed.replace(/^#/, "");
    const candidates = new Set([trimmed, withoutHash]);

    if (fieldId) {
      candidates.add(fieldId);
      candidates.add(`q${fieldId}`);
      candidates.add(`input_${fieldId}`);
      candidates.add(`#input_${fieldId}`);
      candidates.add(`first_${fieldId}`);
      candidates.add(`#first_${fieldId}`);
      candidates.add(`last_${fieldId}`);
      candidates.add(`#last_${fieldId}`);
      candidates.add(`middle_${fieldId}`);
      candidates.add(`#middle_${fieldId}`);
      candidates.add(`phone_${fieldId}`);
      candidates.add(`#phone_${fieldId}`);
    }

    return [...candidates].filter(Boolean);
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

  function getStandalonePreviewValues(tokens) {
    const params = new URLSearchParams(window.location.search);
    const values = [];

    for (const token of tokens) {
      const candidates = buildCandidateNames(token);
      let found = "";

      for (const candidate of candidates) {
        if (params.has(candidate)) {
          found = params.get(candidate) || "";
          break;
        }
      }

      values.push(found);
    }

    return values;
  }

  function extractValueFromResponsePayload(payload) {
    if (payload == null) return "";

    if (typeof payload === "string" || typeof payload === "number" || typeof payload === "boolean") {
      return String(payload);
    }

    if (Array.isArray(payload)) {
      return payload
        .map((item) => extractValueFromResponsePayload(item))
        .filter(Boolean)
        .join(" ");
    }

    if (typeof payload === "object") {
      if (typeof payload.value !== "undefined") {
        return extractValueFromResponsePayload(payload.value);
      }

      if (typeof payload.data !== "undefined") {
        return extractValueFromResponsePayload(payload.data);
      }

      if (typeof payload.text !== "undefined") {
        return extractValueFromResponsePayload(payload.text);
      }

      if (typeof payload.answer !== "undefined") {
        return extractValueFromResponsePayload(payload.answer);
      }
    }

    return "";
  }

  function getValueFromDomFallback(token) {
    const candidates = buildCandidateNames(token);
    const selectors = [];

    for (const candidate of candidates) {
      selectors.push(`[name="${candidate}"]`);
      selectors.push(`#${candidate}`);
      selectors.push(`[data-component="${candidate}"]`);
    }

    for (const selector of selectors) {
      try {
        const el = document.querySelector(selector);
        if (!el) continue;

        if (typeof el.value !== "undefined" && String(el.value).trim() !== "") {
          return String(el.value);
        }

        if (typeof el.textContent !== "undefined" && String(el.textContent).trim() !== "") {
          return String(el.textContent).trim();
        }
      } catch (error) {
        // ignore invalid selectors
      }
    }

    return "";
  }

  function getFieldValueFromListeners(token) {
    return new Promise((resolve) => {
      if (
        typeof window.JFCustomWidget === "undefined" ||
        typeof window.JFCustomWidget.listenFromField !== "function"
      ) {
        resolve(getValueFromDomFallback(token));
        return;
      }

      const candidates = buildCandidateNames(token);
      let resolved = false;
      let attempted = 0;

      const finish = (value, meta = {}) => {
        if (resolved) return;
        resolved = true;
        writeDebug("directLookupResolved", {
          token,
          value,
          ...meta,
        });
        resolve(String(value ?? ""));
      };

      const maybeFinishFromPayload = (candidate, eventName, payload) => {
        const extracted = extractValueFromResponsePayload(payload);
        if (extracted !== "") {
          finish(extracted, {
            candidate,
            eventName,
            source: "listener",
            payload,
          });
        }
      };

      const timer = window.setTimeout(() => {
        const domValue = getValueFromDomFallback(token);
        finish(domValue, {
          source: domValue ? "domFallback" : "timeout",
          candidates,
        });
      }, 400);

      candidates.forEach((candidate) => {
        ["input", "change", "blur", "ready"].forEach((eventName) => {
          attempted += 1;

          try {
            window.JFCustomWidget.listenFromField(candidate, eventName, (payload) => {
              maybeFinishFromPayload(candidate, eventName, payload);
            });
          } catch (error) {
            writeDebug("directLookupListenerError", {
              token,
              candidate,
              eventName,
              error: String(error),
            });
          }
        });
      });

      writeDebug("directLookupAttempted", {
        token,
        candidates,
        attempted,
      });

      Promise.resolve().then(() => {
        const domValue = getValueFromDomFallback(token);
        if (domValue) {
          window.clearTimeout(timer);
          finish(domValue, {
            source: "domImmediate",
            candidates,
          });
        }
      });
    });
  }

  async function getDirectTokenValues(tokens) {
    const values = [];

    for (const token of tokens) {
      const value = await getFieldValueFromListeners(token);
      values.push(value);
    }

    return values;
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
        const candidates = buildCandidateNames(token);

        candidates.forEach((candidate) => {
          try {
            window.JFCustomWidget.listenFromField(candidate, "change", () => {
              writeDebug("fieldChange", { token, candidate });
              this.updateFrame();
            });
            writeDebug("listenerBound", { token, candidate, event: "change" });
          } catch (error) {
            writeDebug("listenerBindError", {
              token,
              candidate,
              error: String(error),
            });
          }
        });
      });
    }

    async updateFrame() {
      if (!this.tokens.length) {
        writeDebug("noTokens", "Using URL as-is");
        this.setFrameSource(this.settings.urlTemplate);
        return;
      }

      if (
        typeof window.JFCustomWidget === "undefined" ||
        typeof window.JFCustomWidget.getFieldsValueById !== "function"
      ) {
        const previewValues = getStandalonePreviewValues(this.tokens);
        const previewUrl = replaceTokensInOrder(
          this.settings.urlTemplate,
          this.tokens,
          previewValues
        );

        writeDebug("standalonePreviewValues", previewValues);
        writeDebug("standalonePreviewUrl", previewUrl);

        this.setFrameSource(previewUrl);
        return;
      }

      try {
        writeDebug("requestFieldValuesById", this.fieldIds);

        window.JFCustomWidget.getFieldsValueById(this.fieldIds, async (response) => {
          writeDebug("rawFieldResponse", response);

          let prefills = Array.isArray(response?.data)
            ? response.data.map((item) => item?.value ?? "")
            : [];

          writeDebug("prefillsInOrder", prefills);

          const hasAnyValues = prefills.some((value) => String(value || "").trim() !== "");

          if (!hasAnyValues) {
            writeDebug("fallbackMode", "getFieldsValueById returned empty; trying direct token lookup");
            prefills = await getDirectTokenValues(this.tokens);
            writeDebug("prefillsFromDirectLookup", prefills);
          }

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

import { assert, describe, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { beforeEach, vi } from "vite-plus/test";

type RegisterBeforeSendHeaders = (
  filter: Electron.WebRequestFilter,
  listener: NonNullable<Parameters<Electron.WebRequest["onBeforeSendHeaders"]>[0]>,
) => void;

const { fromPartition, sessions } = vi.hoisted(() => ({
  fromPartition: vi.fn(),
  sessions: new Map<
    string,
    {
      readonly clearCache: ReturnType<typeof vi.fn>;
      readonly clearStorageData: ReturnType<typeof vi.fn>;
      readonly getUserAgent: ReturnType<typeof vi.fn<() => string>>;
      readonly setPermissionRequestHandler: ReturnType<typeof vi.fn>;
      readonly setPermissionCheckHandler: ReturnType<typeof vi.fn>;
      readonly setUserAgent: ReturnType<typeof vi.fn>;
      readonly webRequest: {
        readonly onBeforeSendHeaders: ReturnType<typeof vi.fn<RegisterBeforeSendHeaders>>;
      };
    }
  >(),
}));

const { fromWebContents } = vi.hoisted(() => ({
  fromWebContents: vi.fn<(webContents: unknown) => unknown>(() => null),
}));

vi.mock("electron", () => ({
  BrowserWindow: { fromWebContents },
  session: {
    fromPartition,
  },
}));

import * as ElectronDialog from "../electron/ElectronDialog.ts";
import * as BrowserSession from "./BrowserSession.ts";
import { installBrowserIdentity } from "./BrowserIdentity.ts";

const { showMessageBox } = vi.hoisted(() => ({
  showMessageBox: vi.fn<
    (options: Electron.MessageBoxOptions, owner?: Electron.BrowserWindow) => number
  >(() => 1),
}));
const layerDialog = Layer.succeed(ElectronDialog.ElectronDialog, {
  pickFolder: () => Effect.die("unused"),
  pickFiles: () => Effect.die("unused"),
  showMessageBox: (options, owner) =>
    Effect.sync(() => ({ response: showMessageBox(options, owner), checkboxChecked: false })),
  showErrorBox: () => Effect.void,
});
const layer = BrowserSession.layer.pipe(
  Layer.provide(Layer.merge(NodeServices.layer, layerDialog)),
);

const nativeUserAgent =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) T3CodeNightly/0.1.4-nightly.20261027.3770 Chrome/152.0.7977.167 Electron/44.9.3 Safari/537.36";
const chromeUserAgent =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) T3CodeNightly/0.1.4-nightly.20261027.3770 Chrome/152.0.7977.167 Safari/537.36";

const userAgentTab = () => ({
  getUserAgent: () => nativeUserAgent,
  setUserAgent: vi.fn(),
  isDestroyed: () => false,
});

const sendHeaders = (
  browserSession: Electron.Session,
  tab: ReturnType<typeof userAgentTab> | undefined,
  url: string,
  resourceType: Electron.OnBeforeSendHeadersListenerDetails["resourceType"] = "mainFrame",
  requestHeaders: Record<string, string> = {
    "User-Agent": tab?.getUserAgent() ?? nativeUserAgent,
    "Sec-CH-UA": '"Chromium";v="152"',
    Authorization: "test-header",
  },
) => {
  const listener = vi.mocked(
    browserSession.webRequest.onBeforeSendHeaders as RegisterBeforeSendHeaders,
  ).mock.lastCall?.[1];
  if (!listener) return requestHeaders;
  let response: Electron.BeforeSendResponse = {};
  listener(
    {
      id: 1,
      method: "GET",
      referrer: "",
      timestamp: 0,
      url,
      resourceType,
      requestHeaders,
      webContents: tab as unknown as Electron.WebContents,
    },
    (result) => {
      response = result;
    },
  );
  return response.requestHeaders ?? requestHeaders;
};

describe("BrowserSession", () => {
  beforeEach(() => {
    sessions.clear();
    fromPartition.mockReset();
    fromPartition.mockImplementation((partition: string) => {
      const browserSession = {
        clearCache: vi.fn(() => Promise.resolve()),
        clearStorageData: vi.fn(() => Promise.resolve()),
        getUserAgent: vi.fn(() => nativeUserAgent),
        setPermissionRequestHandler: vi.fn(),
        setPermissionCheckHandler: vi.fn(),
        setUserAgent: vi.fn(),
        webRequest: { onBeforeSendHeaders: vi.fn<RegisterBeforeSendHeaders>() },
      };
      sessions.set(partition, browserSession);
      return browserSession;
    });
  });

  it.effect("derives deterministic partitions and memoizes sessions", () =>
    Effect.gen(function* () {
      const browserSessions = yield* BrowserSession.BrowserSession;

      const partition = yield* browserSessions.getPartition("scope-a");
      const first = yield* browserSessions.getSession("scope-a");
      const second = yield* browserSessions.getSession("scope-a");

      assert.strictEqual(partition, "persist:t3code-preview-f051bb2c68cb7b2fe969");
      assert.strictEqual(first, second);
      assert.strictEqual(fromPartition.mock.calls.length, 1);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("keeps scopes that differ only by a lone surrogate in separate partitions", () =>
    Effect.gen(function* () {
      const browserSessions = yield* BrowserSession.BrowserSession;

      const loneSurrogate = yield* browserSessions.getPartition("p\ud800");
      const replacementChar = yield* browserSessions.getPartition("p\ufffd");
      assert.notStrictEqual(loneSurrogate, replacementChar);

      const literal = yield* browserSessions.getPartition("p\\ud800");
      assert.notStrictEqual(literal, loneSurrogate);

      assert.strictEqual(
        yield* browserSessions.getPartition("scope-a"),
        "persist:t3code-preview-f051bb2c68cb7b2fe969",
      );
    }).pipe(Effect.provide(layer)),
  );

  it.effect("keeps legacy defaults disjoint from nondefault profile partitions", () =>
    Effect.gen(function* () {
      const browserSessions = yield* BrowserSession.BrowserSession;

      const legacyDefault = yield* browserSessions.getPartition("a::b");
      const nondefaultProfile = yield* browserSessions.getPartition("a::b", true, "profile");

      assert.strictEqual(legacyDefault, "persist:t3code-preview-78f0be89237d77f7a70e");
      assert.strictEqual(nondefaultProfile, "persist:t3code-preview-profile-78f0be89237d77f7a70e");
      assert.notStrictEqual(nondefaultProfile, legacyDefault);
      assert.isTrue(browserSessions.isPartition(legacyDefault));
      assert.isTrue(browserSessions.isPartition(nondefaultProfile));
    }).pipe(Effect.provide(layer)),
  );

  it.effect("keeps the guest's effective User-Agent equal to Electron's native one", () =>
    Effect.gen(function* () {
      const nativeUserAgent =
        "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) T3Code(Alpha)/0.0.33 Chrome/146.0.7680.216 Electron/41.5.0 Safari/537.36";
      fromPartition.mockReset();
      fromPartition.mockImplementation((partition: string) => {
        let userAgent = nativeUserAgent;
        const browserSession = {
          clearCache: vi.fn(() => Promise.resolve()),
          clearStorageData: vi.fn(() => Promise.resolve()),
          getUserAgent: vi.fn(() => userAgent),
          setPermissionRequestHandler: vi.fn(),
          setPermissionCheckHandler: vi.fn(),
          setUserAgent: vi.fn((next: string) => {
            userAgent = next;
          }),
          webRequest: {
            onBeforeSendHeaders: vi.fn<RegisterBeforeSendHeaders>(),
          },
        };
        sessions.set(partition, browserSession);
        return browserSession;
      });

      const browserSessions = yield* BrowserSession.BrowserSession;
      const partition = yield* browserSessions.getPartition("scope-a");
      yield* browserSessions.getSession("scope-a");

      const browserSession = sessions.get(partition);
      assert.isDefined(browserSession);
      assert.strictEqual(browserSession.getUserAgent(), nativeUserAgent);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("presents WhatsApp's initial request and page as the actual Chrome version", () =>
    Effect.gen(function* () {
      const browserSessions = yield* BrowserSession.BrowserSession;
      const browserSession = yield* browserSessions.getSession("whatsapp");
      const tab = userAgentTab();
      const headers = sendHeaders(browserSession, tab, "https://web.whatsapp.com/");
      const page = { userAgent: nativeUserAgent, appVersion: nativeUserAgent.slice(8) };
      installBrowserIdentity("https://web.whatsapp.com/", page);

      assert.strictEqual(headers["User-Agent"], chromeUserAgent);
      assert.strictEqual(page.userAgent, chromeUserAgent);
      assert.strictEqual(page.appVersion, chromeUserAgent.slice(8));
      assert.strictEqual(headers["Sec-CH-UA"], '"Chromium";v="152"');
      assert.strictEqual(headers.Authorization, "test-header");
      assert.strictEqual(browserSession.getUserAgent(), nativeUserAgent);
      assert.strictEqual(tab.setUserAgent.mock.calls.length, 0);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("keeps the native identity for another site in the same tab and session", () =>
    Effect.gen(function* () {
      const browserSessions = yield* BrowserSession.BrowserSession;
      const browserSession = yield* browserSessions.getSession("whatsapp");
      const tab = userAgentTab();
      sendHeaders(browserSession, tab, "https://web.whatsapp.com/");
      const headers = sendHeaders(browserSession, tab, "https://example.com/");
      const page = { userAgent: nativeUserAgent, appVersion: nativeUserAgent.slice(8) };
      installBrowserIdentity("https://example.com/", page);

      assert.strictEqual(headers["User-Agent"], nativeUserAgent);
      assert.strictEqual(page.userAgent, nativeUserAgent);
      assert.strictEqual(page.appVersion, nativeUserAgent.slice(8));
      assert.strictEqual(browserSession.getUserAgent(), nativeUserAgent);
      assert.strictEqual(tab.setUserAgent.mock.calls.length, 0);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("limits compatibility to the exact secure WhatsApp Web origin", () =>
    Effect.gen(function* () {
      const browserSessions = yield* BrowserSession.BrowserSession;
      const browserSession = yield* browserSessions.getSession("whatsapp");
      const tab = userAgentTab();
      for (const url of [
        "http://web.whatsapp.com/",
        "https://web.whatsapp.com:444/",
        "https://web.whatsapp.com.example.com/",
        "https://example.com/?next=https://web.whatsapp.com/",
      ]) {
        const headers = sendHeaders(browserSession, tab, url);
        const page = { userAgent: nativeUserAgent, appVersion: nativeUserAgent.slice(8) };
        installBrowserIdentity(url, page);
        assert.strictEqual(headers["User-Agent"], nativeUserAgent);
        assert.strictEqual(page.userAgent, nativeUserAgent);
      }
    }).pipe(Effect.provide(layer)),
  );

  it.effect("adjusts WhatsApp subframes without changing the embedding tab or other origins", () =>
    Effect.gen(function* () {
      const browserSessions = yield* BrowserSession.BrowserSession;
      const browserSession = yield* browserSessions.getSession("whatsapp");
      const tab = userAgentTab();
      const frameHeaders = sendHeaders(
        browserSession,
        tab,
        "https://web.whatsapp.com/",
        "subFrame",
      );
      const assetHeaders = sendHeaders(
        browserSession,
        tab,
        "https://static.whatsapp.net/app.js",
        "script",
      );
      assert.strictEqual(frameHeaders["User-Agent"], chromeUserAgent);
      assert.strictEqual(assetHeaders["User-Agent"], nativeUserAgent);
      assert.strictEqual(tab.getUserAgent(), nativeUserAgent);
      assert.strictEqual(tab.setUserAgent.mock.calls.length, 0);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("handles lowercase and absent user-agent headers", () =>
    Effect.gen(function* () {
      const browserSessions = yield* BrowserSession.BrowserSession;
      const browserSession = yield* browserSessions.getSession("whatsapp");
      const tab = userAgentTab();
      const headers = sendHeaders(browserSession, tab, "https://web.whatsapp.com/", "mainFrame", {
        "user-agent": nativeUserAgent,
      });
      assert.deepStrictEqual(headers, { "user-agent": chromeUserAgent });
      assert.deepStrictEqual(
        sendHeaders(browserSession, tab, "https://web.whatsapp.com/", "xhr", {}),
        {},
      );
    }).pipe(Effect.provide(layer)),
  );

  it.effect("adjusts background WhatsApp requests without requiring live web contents", () =>
    Effect.gen(function* () {
      const browserSessions = yield* BrowserSession.BrowserSession;
      const browserSession = yield* browserSessions.getSession("whatsapp");
      const headers = sendHeaders(browserSession, undefined, "https://web.whatsapp.com/", "xhr");
      assert.strictEqual(headers["User-Agent"], chromeUserAgent);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("grants clipboard-sanitized-write through both the request and check handlers", () =>
    Effect.gen(function* () {
      const browserSessions = yield* BrowserSession.BrowserSession;
      const partition = yield* browserSessions.getPartition("scope-a");
      yield* browserSessions.getSession("scope-a");

      const browserSession = sessions.get(partition);
      assert.isDefined(browserSession);

      const requestHandler = browserSession.setPermissionRequestHandler.mock.calls[0]?.[0];
      const checkHandler = browserSession.setPermissionCheckHandler.mock.calls[0]?.[0];
      assert.isFunction(requestHandler);
      assert.isFunction(checkHandler);

      const requestAllows = (permission: string): boolean => {
        let granted: boolean | undefined;
        requestHandler(null, permission, (value: boolean) => {
          granted = value;
        });
        assert.isDefined(granted);
        return granted;
      };

      for (const permission of [
        "clipboard-read",
        "clipboard-sanitized-write",
        "geolocation",
        "fullscreen",
      ]) {
        assert.isTrue(requestAllows(permission), `request handler should allow ${permission}`);
        assert.isTrue(
          checkHandler(null, permission) as boolean,
          `check handler should allow ${permission}`,
        );
      }

      // `clipboard-write` is not a real Electron permission — the async write API
      // uses `clipboard-sanitized-write` — so the stale name must not be granted,
      // and unrelated permissions stay denied.
      for (const permission of ["clipboard-write", "notifications", "midi"]) {
        assert.isFalse(requestAllows(permission), `request handler should deny ${permission}`);
        assert.isFalse(
          checkHandler(null, permission) as boolean,
          `check handler should deny ${permission}`,
        );
      }
    }).pipe(Effect.provide(layer)),
  );

  it.effect("opens custom-scheme links externally only after the user confirms", () =>
    Effect.gen(function* () {
      const browserSessions = yield* BrowserSession.BrowserSession;
      const partition = yield* browserSessions.getPartition("scope-a");
      yield* browserSessions.getSession("scope-a");
      const requestHandler =
        sessions.get(partition)?.setPermissionRequestHandler.mock.calls[0]?.[0];
      assert.isFunction(requestHandler);

      const request = (externalURL: string) =>
        Effect.callback<boolean>((resume) => {
          requestHandler(
            null,
            "openExternal",
            (granted: boolean) => resume(Effect.succeed(granted)),
            { externalURL },
          );
        });

      showMessageBox.mockReset();
      showMessageBox.mockReturnValueOnce(0).mockReturnValueOnce(1);
      assert.isTrue(yield* request("slack://open?team=T1"));
      assert.isFalse(yield* request("zoommtg://zoom.us/join"));
      assert.strictEqual(showMessageBox.mock.calls.length, 2);

      for (const url of ["file:///etc/passwd", "javascript:alert(1)", "data:text/html,x"]) {
        assert.isFalse(yield* request(url), `${url} must never open externally`);
      }
      assert.strictEqual(showMessageBox.mock.calls.length, 2);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("clears a partition whose session has not been opened yet", () =>
    Effect.gen(function* () {
      const browserSessions = yield* BrowserSession.BrowserSession;
      const partition = yield* browserSessions.getPartition("scope-untouched");

      assert.isUndefined(sessions.get(partition));
      yield* browserSessions.clearCookies([partition]);
      assert.isUndefined(sessions.get(partition));

      yield* browserSessions.getSession("scope-untouched");
      yield* browserSessions.clearCookies([partition]);

      const created = sessions.get(partition);
      assert.isDefined(created);
      assert.strictEqual(created.clearStorageData.mock.calls.length, 1);
    }).pipe(Effect.provide(layer)),
  );
});

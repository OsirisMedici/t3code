import "~/index.css";
import { EnvironmentId } from "@t3tools/contracts";
import type { PreviewStreamEvents } from "@t3tools/client-runtime/preview/server-browser-stream";
import { expect, it, vi } from "vite-plus/test";

import { page } from "vite-plus/test/browser";
import { act, render } from "../../test/render";

const stream = vi.hoisted(() => ({
  events: null as PreviewStreamEvents | null,
  send: vi.fn(),
}));
vi.mock("~/state/previewStream", () => ({
  usePreviewStreamAccess: () => access,
  refreshPreviewStreamAccess: vi.fn(),
}));
vi.mock(import("@t3tools/client-runtime/preview/server-browser-stream"), async (original) => ({
  ...(await original()),
  createPreviewStreamClient: (_target, events) => {
    stream.events = events;
    return { send: stream.send, stop: () => {} };
  },
  createPreviewFramePainter: (canvas, firstFrame) => ({
    paint: () => {
      canvas.width = 1280;
      canvas.height = 800;
      firstFrame?.();
    },
    stop: () => {},
  }),
}));

import { ServerBrowserSurface } from "./ServerBrowserSurface";

const access = {
  httpBase: "http://fixture.test",
  wsBase: "ws://fixture.test",
  query: {},
  credentials: false,
};
const control = { canOperate: true, controller: "agent", generation: 1, dialog: null } as const;

async function mountBrowser() {
  stream.events = null;
  stream.send.mockReset();
  await using stack = new AsyncDisposableStack();
  const screen = stack.use(
    await render(
      <div style={{ width: 640, height: 480 }}>
        <ServerBrowserSurface
          environmentId={EnvironmentId.make("fixture")}
          threadId="thread"
          tabId="tab"
          visible
          className="size-full"
        />
      </div>,
    ),
  );
  await vi.waitFor(() => expect(stream.events).not.toBeNull());
  await act(() => {
    stream.events!.onViewport({ width: 1280, height: 800 });
    stream.events!.onControl?.(control);
    stream.events!.onFrame(new ArrayBuffer(0));
  });
  const cleanup = stack.move();
  return { ...screen, [Symbol.asyncDispose]: () => cleanup.disposeAsync() };
}

it("accepts the first click on an agent tab and keeps typing focused after automatic release", async () => {
  await using screen = await mountBrowser();
  const canvas = screen.container.querySelector("canvas")!;
  const input = screen.container.querySelector("textarea")!;
  await page.elementLocator(canvas).click();
  expect(document.activeElement).toBe(input);
  await act(() => {
    stream.events!.onControl?.({ ...control, controller: "you", generation: 2 });
    stream.events!.onControl?.({ ...control, generation: 3 });
  });
  expect(document.activeElement).toBe(input);
  expect(input.disabled).toBe(false);
  expect(stream.send).toHaveBeenCalledWith(
    expect.objectContaining({ type: "mouse", action: "down" }),
  );
  expect(stream.send).not.toHaveBeenCalledWith({ type: "takeControl" });
});

it("delivers editing shortcuts and pasted text to the page without selecting the hidden input", async () => {
  await using screen = await mountBrowser();
  const input = screen.container.querySelector("textarea")!;
  input.focus();
  const shortcut = new KeyboardEvent("keydown", {
    key: "a",
    code: "KeyA",
    keyCode: 65,
    ctrlKey: true,
    bubbles: true,
    cancelable: true,
  });
  input.dispatchEvent(shortcut);
  expect(shortcut.defaultPrevented).toBe(true);
  expect(input.selectionStart).toBe(1);
  expect(input.selectionEnd).toBe(1);
  expect(stream.send).toHaveBeenCalledWith(
    expect.objectContaining({ type: "key", key: "a", modifiers: 2 }),
  );
  const clipboard = new DataTransfer();
  clipboard.setData("text/plain", "pasted\ntext");
  input.dispatchEvent(
    new ClipboardEvent("paste", { clipboardData: clipboard, bubbles: true, cancelable: true }),
  );
  expect(stream.send.mock.calls.filter(([message]) => message.type === "text")).toEqual([
    [{ type: "text", text: "pasted\ntext" }],
  ]);
  expect(input.value).toBe("\u200b");
  input.blur();
  expect(stream.send).toHaveBeenCalledWith({ type: "blur" });
});

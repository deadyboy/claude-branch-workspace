import { test, expect } from "@playwright/test";

/**
 * Regression for the pending refresh effect: a connected socket can be silent
 * after startup, while a turn opened by REST still needs to converge to a
 * terminal node state through the persistent low-frequency poll.
 */
test("pending turn recovers without a websocket event", async ({ page }) => {
  test.setTimeout(20_000);

  let posted = false;
  let releaseCancelled = false;
  let pendingNodeReads = 0;
  const nodeId = "e2e-pending-recovery-node";

  // Keep the browser socket open but swallow every frame. This exercises the
  // REST reconciliation path without relying on the fake runtime event order.
  await page.addInitScript(() => {
    class SilentWebSocket extends EventTarget {
      static CONNECTING = 0;
      static OPEN = 1;
      static CLOSING = 2;
      static CLOSED = 3;
      url: string;
      readyState = SilentWebSocket.CONNECTING;
      bufferedAmount = 0;
      onopen: ((event: Event) => void) | null = null;
      onmessage: ((event: MessageEvent) => void) | null = null;
      onclose: ((event: CloseEvent) => void) | null = null;
      onerror: ((event: Event) => void) | null = null;

      constructor(url: string | URL) {
        super();
        this.url = String(url);
        queueMicrotask(() => {
          if (this.readyState !== SilentWebSocket.CONNECTING) return;
          this.readyState = SilentWebSocket.OPEN;
          const event = new Event("open");
          this.onopen?.(event);
          this.dispatchEvent(event);
        });
      }

      send(_data: string): void {
        // Deliberately discard hello/cursor messages and all server frames.
      }

      close(): void {
        if (this.readyState === SilentWebSocket.CLOSED) return;
        this.readyState = SilentWebSocket.CLOSED;
        const event = new CloseEvent("close");
        this.onclose?.(event);
        this.dispatchEvent(event);
      }
    }

    Object.defineProperty(window, "WebSocket", {
      configurable: true,
      writable: true,
      value: SilentWebSocket,
    });
  });

  await page.route(/\/api\/branches\/[^/]+\/messages$/, async (route) => {
    posted = true;
    await route.fulfill({
      status: 202,
      contentType: "application/json",
      body: JSON.stringify({ nodeId }),
    });
  });

  await page.route(/\/api\/branches\/[^/]+\/nodes$/, async (route) => {
    if (!posted) {
      await route.continue();
      return;
    }
    pendingNodeReads += 1;
    const branchId = new URL(route.request().url()).pathname.split("/")[3];
    const now = new Date().toISOString();
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify([{
        id: nodeId,
        projectId: "e2e-pending-recovery-project",
        branchId,
        parentNodeId: null,
        localTurnIndex: 0,
        userMessageRef: "",
        assistantMessageRef: null,
        runtimeUserMessageId: null,
        runtimeAssistantMessageId: null,
        status: releaseCancelled ? "cancelled" : "pending",
        createdAt: now,
        completedAt: now,
      }]),
    });
  });

  // Keep the awaited branch refresh deterministic while the test advances the
  // browser clock; these are state reads, not part of the event under test.
  await page.route(/\/api\/branches\/[^/]+\/conversation$/, async (route) => {
    if (!posted) {
      await route.continue();
      return;
    }
    await route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
  });
  await page.route(/\/api\/branches\/[^/]+\/agent-runs$/, async (route) => {
    if (!posted) {
      await route.continue();
      return;
    }
    await route.fulfill({ status: 200, contentType: "application/json", body: "[]" });
  });
  await page.route(/\/api\/branches\/[^/]+\/workspace$/, async (route) => {
    if (!posted) {
      await route.continue();
      return;
    }
    await route.fulfill({
      status: 200,
      contentType: "application/json",
      body: JSON.stringify({ mode: "shared", path: null, isGit: false, dirty: false, conflicts: [], sharedWith: [] }),
    });
  });

  // Install before navigation so every application timer, including the
  // recurring pending poll, can be advanced deterministically.
  await page.clock.install();
  await page.goto("/");
  await expect(page.locator(".socket-txt")).toHaveText("connected", { timeout: 10_000 });
  const composer = page.locator(".composer textarea");
  await expect(composer).toBeEnabled({ timeout: 10_000 });

  await composer.fill("recovery probe");
  await composer.press("Control+Enter");
  await expect(composer).toBeDisabled({ timeout: 5_000 });
  // No WS terminal event is delivered. Advance beyond the former 24*1.5s
  // cutoff while REST keeps reporting pending; the poll must remain alive.
  // Network promises resume between clock advances, so use short real-host
  // yields between deterministic timer jumps.
  const yieldToNetwork = () => new Promise<void>((resolve) => setTimeout(resolve, 50));
  await page.clock.runFor(2_000);
  await yieldToNetwork();
  for (let i = 0; i < 9; i += 1) {
    await page.clock.runFor(5_000);
    await yieldToNetwork();
  }
  expect(pendingNodeReads).toBeGreaterThan(8);
  await expect(composer).toBeDisabled();

  releaseCancelled = true;
  await page.clock.runFor(5_000);
  await expect(composer).toBeEnabled({ timeout: 8_000 });
  await expect(page.locator(".tl-type")).toHaveCount(0);
});

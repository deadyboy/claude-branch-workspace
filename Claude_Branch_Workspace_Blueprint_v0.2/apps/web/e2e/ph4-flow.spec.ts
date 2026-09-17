// Phase 4 S7 — end-to-end golden path over the REAL served app.
//
// The control plane (fake runtime) serves the built SPA at 127.0.0.1:15723;
// every REST call and the WS stream are same-origin (gate 12). Coverage:
//   - g10  golden path: boot → auto-project + root Main → multi-turn chat
//   - g14  Shared-only UI (no worktree selector; mode tag 'S')
//   - g1   committed-tree integrity: forked child shows inherited + local,
//         and the parent's later turns NEVER leak into the child
//   - g7   attention loop: card seeded from an attention event, allow/deny
//   - g8   live timeline fills + monotonic seqRel
//
// The UI currently exposes only "Fork from latest turn" (historical-node fork
// semantics are covered by the g1 server tests via the API), so this spec
// drives the UI's Fork control. Run: pnpm --filter @cbw/web e2e

import { test, expect, type Page } from "@playwright/test";

// ---- helpers -------------------------------------------------------------

async function waitSocketOpen(page: Page): Promise<void> {
  await expect(page.locator(".socket-txt")).toHaveText(/connected/, { timeout: 20_000 });
}

/** Type + send a message; waits until the turn's echo appears in the chat. */
async function sendAndWait(page: Page, text: string): Promise<void> {
  const composer = page.locator(".composer textarea");
  await composer.fill(text);
  await composer.press("Control+Enter");
  // The turn is reflected in chat once the branch sits idle again.
  await expect(page.locator(".composer textarea")).toBeEnabled({ timeout: 20_000 });
}

/** Switch the active branch by its tree label. */
async function switchBranch(page: Page, label: string): Promise<void> {
  const row = page.locator(".tree-row").filter({ hasText: label }).first();
  await row.locator(".tree-main").click();
  await expect(row).toHaveClass(/active/);
}

async function currentChatTexts(page: Page): Promise<string[]> {
  return page.locator(".msg-body").allTextContents();
}

// ---- spec ----------------------------------------------------------------

test("ph4 golden path: boot, multi-turn, fork, no-leak, attention", async ({ page }) => {
  test.setTimeout(120_000);

  await page.goto("/");

  // g10 — boot auto-creates project + root Main
  await waitSocketOpen(page);
  const mainRow = page.locator(".tree-row").filter({ hasText: "Main" });
  await expect(mainRow).toBeVisible();
  // g14 — Shared-only: mode tag is 'S', and the header advertises Shared only
  await expect(page.locator(".mode-tag").first()).toHaveText("S");
  await expect(page.locator(".pane-hd", { }).filter({ hasText: "Shared only" }).first()).toBeVisible();

  // ---- multi-turn on Main (g10) ----
  await sendAndWait(page, "explain the design");
  await expect(page.locator(".msg-body").filter({ hasText: "echo for: explain the design" })).toBeVisible();

  await sendAndWait(page, "refactor a.ts");
  await expect(page.locator(".msg-body").filter({ hasText: "echo for: refactor a.ts" })).toBeVisible();

  // g8 — timeline filled with live events + monotonic seq
  const tlTypes = page.locator(".tl-type");
  await expect(tlTypes.first()).toBeVisible({ timeout: 20_000 });
  const seqs = await page.locator(".tl-seq").allTextContents();
  const numeric = seqs.map((s) => Number(s)).filter((n) => !Number.isNaN(n));
  expect(numeric.length).toBeGreaterThan(4);
  for (let i = 1; i < numeric.length; i++) expect(numeric[i]).toBeGreaterThanOrEqual(numeric[i - 1]);

  // Agent Monitor shows completed runs for this branch
  await expect(page.locator(".run-card").first()).toBeVisible({ timeout: 15_000 });
  await expect(page.locator(".run-card").first()).toContainText("completed");

  // ---- fork Main from latest turn -> Child (g1) ----
  const mainRow2 = page.locator(".tree-row").filter({ hasText: "Main" }).first();
  await mainRow2.getByRole("button", { name: "Fork", exact: true }).click();
  const dialog = mainRow2.locator(".fork-dialog");
  await expect(dialog).toBeVisible();
  await dialog.locator("input").fill("Child");
  await dialog.getByRole("button", { name: "Fork", exact: true }).click();
  await expect(page.locator(".tree-row").filter({ hasText: "Child" })).toBeVisible({ timeout: 15_000 });

  // ---- child shows inherited (from Main) + local turns (gate 3 / g1) ----
  await switchBranch(page, "Child");
  await expect(page.locator(".msg").filter({ hasText: "echo for: refactor a.ts" })).toBeVisible();
  // both turns before the fork are inherited into the child
  const inherited = page.locator(".msg .badge.inherited");
  await expect(inherited).toHaveCount(4); // 2 user + 2 assistant inherited
  // no 'local' yet on the child
  await expect(page.locator(".msg .badge.local")).toHaveCount(0);

  // child can continue its own turn (g10)
  await sendAndWait(page, "review the plan");
  await expect(page.locator(".msg-body").filter({ hasText: "echo for: review the plan" })).toBeVisible();
  await expect(page.locator(".msg .badge.local")).toHaveCount(2); // user + assistant local

  // ---- g1 no-leak: parent turns AFTER the fork never reach the child ----
  // continue the PARENT with a new turn
  await switchBranch(page, "Main");
  await sendAndWait(page, "never tell child this secret");
  await expect(page.locator(".msg-body").filter({ hasText: "echo for: never tell child this secret" })).toBeVisible();

  // back to child: that last Main turn must be ABSENT
  await switchBranch(page, "Child");
  const childTexts = await currentChatTexts(page);
  expect(childTexts.join("\n")).not.toContain("never tell child this secret");
  expect(childTexts.join("\n")).toContain("echo for: review the plan");

  // ---- g7 attention loop: card seeded from an attention event, answer it ----
  await sendAndWait(page, "approve the change");
  const attnCard = page.locator(".attn-pinned .attn-card").first();
  await expect(attnCard).toBeVisible({ timeout: 20_000 });
  await expect(attnCard.locator(".attn-title")).toHaveText("Approve running npm test on this branch");
  await attnCard.getByRole("button", { name: "Allow" }).click();
  await expect(attnCard.locator(".attn-answered")).toContainText("Answered: allow", { timeout: 15_000 });
});

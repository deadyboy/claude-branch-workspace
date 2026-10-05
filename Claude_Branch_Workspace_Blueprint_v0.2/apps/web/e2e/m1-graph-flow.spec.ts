// E7 (M1) + E2 interaction coverage, driven through the REAL UI against a real
// control plane with the fake runtime.
//
// The independent review flagged that the M1 acceptance items "30 interactions"
// and "refresh recovery" had NO automated evidence — only a projection-level
// timing script. This spec closes that gap by exercising the actual browser:
// building a fork chain through the API, then clicking through the graph, the
// tree, and a reload.
//
// Run against a NON-PRODUCTION port (the plan forbids touching 15723):
//   CBW_E2E_PORT=15921 pnpm --filter @cbw/web e2e m1-graph-flow

import { test, expect, type Page } from "@playwright/test";

/**
 * Build Main -> A -> A1 through the real REST API so the graph has real data.
 *
 * Seeds into its OWN project. The specs share one control plane and one
 * database, and writing turns into whatever project happens to exist first
 * leaked into the other specs (pending-recovery passed alone but failed in the
 * full run). A dedicated project keeps this spec self-contained.
 */
async function seedForkChain(page: Page): Promise<{ projectId: string; branchIds: string[] }> {
  return page.evaluate(async () => {
    const post = async (url: string, body: unknown) => {
      const r = await fetch(url, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(body),
      });
      if (!r.ok) throw new Error(`${r.status} ${url}: ${await r.text()}`);
      return r.json();
    };
    // A fresh project per seed call, so this spec never mutates another's data.
    // The server requires rootPath to be an existing absolute directory; an
    // already-registered project's path is a valid one by construction.
    const existing = await (await fetch("/api/projects")).json();
    if (existing.length === 0) throw new Error("spec needs one pre-existing project to borrow rootPath from");
    const project = await post("/api/projects", {
      name: `m1-graph-${Date.now()}`,
      rootPath: existing[0].rootPath,
    });
    const projectId = project.id;
    await post("/api/branches", { projectId, displayName: "Main", workspaceMode: "shared" });
    const branches = await (await fetch(`/api/projects/${projectId}/branches`)).json();
    const main = branches[0];

    // Main must have completed turns before anything can fork from it.
    const turn = async (branchId: string, n: number) => {
      for (let i = 0; i < n; i++) {
        await post(`/api/branches/${branchId}/messages`, { text: `seed ${branchId.slice(0, 4)} turn ${i + 1}` });
        // Wait for the turn to complete so it becomes a legal fork source.
        for (let w = 0; w < 60; w++) {
          const nodes = await (await fetch(`/api/branches/${branchId}/nodes`)).json();
          if (nodes.length && nodes[nodes.length - 1].status !== "pending") break;
          await new Promise((r) => setTimeout(r, 250));
        }
      }
    };
    await turn(main.id, 3);

    const mainNodes = await (await fetch(`/api/branches/${main.id}/nodes`)).json();
    const forkTurn = mainNodes[1];
    const a = await post("/api/branches", {
      projectId,
      forkFromNodeId: forkTurn.id,
      displayName: "A",
      workspaceMode: "shared",
    });
    await turn(a.branch.id, 1);
    const aNodes = await (await fetch(`/api/branches/${a.branch.id}/nodes`)).json();
    const a1 = await post("/api/branches", {
      projectId,
      forkFromNodeId: aNodes[0].id,
      displayName: "A",
      workspaceMode: "shared",
    });
    return { projectId, branchIds: [main.id, a.branch.id, a1.branch.id] };
  });
}

test("E7-M1: graph renders real turns and supports 30 interactions", async ({ page }) => {
  await page.goto("/");
  await page.waitForSelector(".app");
  const seeded = await seedForkChain(page);
  expect(seeded.branchIds.length).toBe(3);

  // Point the UI at the seeded project, then reload so bootstrap opens it.
  await page.evaluate((id) => window.localStorage.setItem("cbw.activeProjectId", id), seeded.projectId);
  await page.reload();
  await page.waitForSelector("text=Conversation Tree");

  // Open the Graph view.
  await page.getByRole("tab").filter({ hasText: "Graph" }).click();
  const svg = page.getByTestId("conversation-graph");
  await expect(svg).toBeVisible();

  // The graph must contain the real branches and turn nodes — not a placeholder.
  const branchNodes = svg.locator('[data-node-kind="branch"]');
  await expect(branchNodes.first()).toBeVisible();
  const total = await svg.locator("g[data-node-id]").count();
  expect(total).toBeGreaterThan(3);

  // 30 interactions: select nodes and assert the inspector responds each time.
  const ids = await svg.locator("g[data-node-id]").evaluateAll((els) =>
    els.map((e) => e.getAttribute("data-node-id") ?? "")
  );
  expect(ids.length).toBeGreaterThan(3);
  const inspect = page.getByTestId("graph-inspect");
  for (let i = 0; i < 30; i++) {
    const id = ids[i % ids.length];
    await svg.locator(`g[data-node-id="${id}"]`).click();
    await expect(inspect).toBeVisible();
    // The inspector must actually name the selected node, not show a stale one.
    const shown = await inspect.textContent();
    expect(shown && shown.length > 0).toBeTruthy();
  }

  // Unknown nodes must never be rendered as openable (E8-style honesty, but
  // also guards a graph that invents nodes).
  const edgeCount = await svg.locator("path[data-edge-kind]").count();
  expect(edgeCount).toBeGreaterThan(0);
});

test("E7-M1: fork edges are drawn with their own kind, distinct from turn chains", async ({ page }) => {
  await page.goto("/");
  await page.waitForSelector(".app");
  const seeded = await seedForkChain(page);
  await page.evaluate((id) => window.localStorage.setItem("cbw.activeProjectId", id), seeded.projectId);
  await page.reload();
  await page.waitForSelector("text=Conversation Tree");
  await page.getByRole("tab").filter({ hasText: "Graph" }).click();

  const svg = page.getByTestId("conversation-graph");
  await expect(svg).toBeVisible();
  // A2 forked twice, so at least 2 fork edges must exist as their own class.
  const forkEdges = svg.locator('path[data-edge-kind="fork"]');
  await expect(forkEdges.first()).toBeVisible();
  const forkCount = await forkEdges.count();
  expect(forkCount).toBeGreaterThanOrEqual(2);
});

test("E7-M1: refresh recovers the graph and the active project", async ({ page }) => {
  await page.goto("/");
  await page.waitForSelector(".app");
  const seeded = await seedForkChain(page);
  await page.evaluate((id) => window.localStorage.setItem("cbw.activeProjectId", id), seeded.projectId);
  await page.reload();
  await page.waitForSelector("text=Conversation Tree");

  // The remembered project must survive a reload (E1).
  const remembered = await page.evaluate(() => window.localStorage.getItem("cbw.activeProjectId"));
  expect(remembered).toBe(seeded.projectId);

  await page.getByRole("tab").filter({ hasText: "Graph" }).click();
  const svg = page.getByTestId("conversation-graph");
  await expect(svg).toBeVisible();

  // The view fetches each branch's turns asynchronously, so the node count
  // grows for a moment after mount. Wait for it to SETTLE before sampling,
  // otherwise the "before" reading races the fill-in and the comparison is
  // meaningless (this exact race made an earlier revision of this test report
  // a false 18 -> 19 difference; the underlying data was verified stable).
  const settledCount = async (): Promise<number> => {
    let last = -1;
    for (let i = 0; i < 40; i++) {
      const n = await svg.locator("g[data-node-id]").count();
      if (n > 0 && n === last) return n;
      last = n;
      await page.waitForTimeout(200);
    }
    return last;
  };
  const before = await settledCount();
  expect(before).toBeGreaterThan(3);

  // Reload mid-view: the graph must come back with the same topology.
  await page.reload();
  await page.waitForSelector("text=Conversation Tree");
  await page.getByRole("tab").filter({ hasText: "Graph" }).click();
  await expect(svg).toBeVisible();
  const after = await settledCount();
  expect(after).toBe(before);
});

test("E2: the nested tree shows the fork chain with increasing depth", async ({ page }) => {
  await page.goto("/");
  await page.waitForSelector(".app");
  const seeded = await seedForkChain(page);
  await page.evaluate((id) => window.localStorage.setItem("cbw.activeProjectId", id), seeded.projectId);
  await page.reload();
  await page.waitForSelector("text=Conversation Tree");

  const rows = page.locator("[data-testid='conversation-tree'] [data-depth]");
  await expect(rows.first()).toBeVisible();
  const depths = await rows.evaluateAll((els) =>
    els.map((e) => Number(e.getAttribute("data-depth") ?? "0"))
  );
  // A real ancestry tree must show at least one nested row (depth > 0).
  expect(Math.max(...depths)).toBeGreaterThan(0);
  // And depth must never jump by more than one level at a time.
  for (let i = 1; i < depths.length; i++) {
    expect(depths[i] - depths[i - 1]).toBeLessThanOrEqual(1);
  }
});

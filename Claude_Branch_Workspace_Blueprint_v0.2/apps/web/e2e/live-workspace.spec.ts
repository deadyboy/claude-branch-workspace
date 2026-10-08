// Opt-in product-entry acceptance. Never part of the default mock suite.
// CBW_E2E_LIVE=1 plus an isolated CBW_E2E_PORT / CBW_E2E_DB are required.
import { test, expect, type Page } from "@playwright/test";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";

test.skip(process.env.CBW_E2E_LIVE !== "1", "requires explicit live opt-in");

async function send(page: Page, text: string) {
  await expect(page.locator(".composer textarea")).toBeEnabled({ timeout: 180_000 });
  await page.locator(".composer textarea").fill(text);
  const response = page.waitForResponse((r) => /\/api\/branches\/[^/]+\/messages$/.test(r.url()) && r.request().method() === "POST");
  await page.getByRole("button", { name: "Continue branch", exact: true }).click();
  const accepted = await response;
  expect(accepted.status()).toBe(202);
  const { nodeId } = await accepted.json();
  await expect.poll(async () => (await (await page.request.get(`/api/nodes/${nodeId}`)).json()).status,
    { timeout: 180_000, intervals: [1000, 2000] }).not.toBe("pending");
  expect((await (await page.request.get(`/api/nodes/${nodeId}`)).json()).status).toBe("completed");
  const branchId = new URL(accepted.url()).pathname.split("/")[3];
  const chat = await (await page.request.get(`/api/branches/${branchId}/conversation`)).json();
  return { nodeId, branchId, answer: chat.filter((m: { nodeId: string; role: string }) => m.nodeId === nodeId && m.role === "assistant").map((m: { content: string }) => m.content).join("\n") };
}

test("live M1/M2: UI project, historical worktree fork, and task writes a real file", async ({ page }, testInfo) => {
  test.setTimeout(720_000);
  page.setDefaultTimeout(30_000);
  const directory = mkdtempSync(join(tmpdir(), "cbw-ui-live-"));
  writeFileSync(join(directory, "README.md"), "Synthetic UI live acceptance.\n");
  for (const args of [["init", directory], ["-C", directory, "add", "."], ["-C", directory, "-c", "user.name=CBW Test", "-c", "user.email=cbw@example.invalid", "commit", "-m", "fixture"]]) {
    execFileSync("git", args, { windowsHide: true, stdio: "pipe" });
  }
  await page.goto("/");
  await page.locator(".project-switch").click();
  const hub = page.getByRole("dialog", { name: "Projects" });
  await hub.getByRole("button", { name: "Add project", exact: true }).click();
  const projectName = `Live acceptance ${randomUUID().slice(0, 8)}`;
  await hub.getByLabel("Project name").fill(projectName);
  await hub.getByLabel("Execution host path").fill(directory);
  await hub.getByRole("button", { name: "Add", exact: true }).click();
  await hub.getByTitle("Open this project").filter({ hasText: projectName }).click();
  await expect(hub).not.toBeVisible();
  const past = `PAST_${randomUUID()}`;
  const future = `FUTURE_${randomUUID()}`;
  const first = await send(page, `Remember exactly ${past}. Reply READY only. Do not use tools.`);
  expect(first.answer).toContain("READY");
  await send(page, `Remember the additional label ${future}. Reply RECORDED only. Do not use tools.`);
  await page.getByRole("tab", { name: "Graph", exact: true }).click();
  await page.getByTestId("conversation-graph").locator(`g[data-node-id="turn:${first.nodeId}"]`).click();
  await expect(page.getByTestId("graph-context")).toContainText(past);
  await expect(page.getByTestId("graph-context")).not.toContainText(future);
  await page.getByTestId("graph-fork-button").click();
  const fork = page.getByRole("dialog", { name: "Fork branch" });
  await fork.getByLabel("Branch name").fill("Historical live child");
  await fork.getByLabel("Workspace mode").selectOption("worktree");
  await fork.getByRole("button", { name: "Fork", exact: true }).click();
  await expect(page.locator(".chat .pane-hd").first()).toContainText("Historical live child", { timeout: 180_000 });
  const child = await send(page, "List the exact PAST_ and FUTURE_ labels from our conversation. Do not invent labels or use tools.");
  expect(child.answer).toContain(past);
  expect(child.answer).not.toContain(future);
  console.info("[live] historical worktree isolation passed");
  await page.getByRole("tab", { name: "Team", exact: true }).click();
  await page.getByRole("button", { name: "Dispatch task", exact: true }).click();
  const marker = `FILE_${randomUUID()}`;
  await page.getByLabel("Task title", { exact: true }).fill("Write acceptance artifact");
  await page.getByLabel("Task instructions", { exact: true }).fill(`In your current workspace write a new file acceptance.txt containing exactly ${marker}. Do not modify any other files or use subagents. Then call cbw-control register_artifact using the current branchId and nodeId from your system context, path acceptance.txt, kind file. Then reply DONE.`);
  await page.getByLabel("Dispatch workspace mode").selectOption("worktree");
  await page.getByRole("button", { name: "Dispatch", exact: true }).click();
  const card = page.getByTestId("task-card").filter({ hasText: "Write acceptance artifact" });
  await Promise.race([
    expect(card).toContainText("completed", { timeout: 240_000 }),
    page.getByRole("alert").waitFor({ state: "visible", timeout: 240_000 }).then(async () => {
      throw new Error(`Dispatch failed: ${await page.getByRole("alert").textContent()}`);
    }),
  ]);
  const taskId = await card.getAttribute("data-task-id");
  const detail = await (await page.request.get(`/api/tasks/${taskId}`)).json();
  expect(detail.attempts).toHaveLength(1);
  expect(detail.attempts[0].status).toBe("completed");
  const workspace = await (await page.request.get(`/api/branches/${detail.branchId}/workspace`)).json();
  expect(workspace.mode).toBe("worktree");
  expect(readFileSync(join(workspace.path, "acceptance.txt"), "utf8").trim()).toBe(marker);
  const changes = await (await page.request.get(`/api/branches/${detail.branchId}/changes`)).json();
  expect(JSON.stringify(changes)).toContain("acceptance.txt");
  expect(execFileSync("git", ["-C", directory, "status", "--porcelain"], { windowsHide: true, encoding: "utf8" })).toBe("");
  await page.getByRole("tab", { name: "Project", exact: true }).click();
  await page.getByRole("button", { name: "Preview acceptance.txt", exact: true }).click();
  await expect(page.getByTestId("project-file-content")).toContainText(marker);
  await page.screenshot({ path: testInfo.outputPath("live-project.png"), fullPage: true });
  await page.getByRole("button", { name: "Open source turn", exact: true }).click();
  await expect(page.locator(".chat")).toContainText("DONE");
  await page.getByRole("tab", { name: "Results", exact: true }).click();
  await page.getByTitle("acceptance.txt", { exact: true }).click();
  await page.getByTestId("change-current-content").click();
  await expect(page.getByTestId("change-current-content-body")).toContainText(marker);
  await page.getByTestId("changes-open-conversation").click();
  await expect(page.locator(".chat")).toContainText("DONE");
  await page.getByRole("tab", { name: "Team", exact: true }).click();
  console.info("[live] task file, Project provenance and Results navigation passed");
  await card.getByTitle("Open this task in Chat").click();
  const delegatedMarker = `DELEGATED_${randomUUID()}`;
  const delegatedTitle = `MCP worker ${randomUUID().slice(0, 8)}`;
  const orchestrated = await send(page, [
    "Use only the cbw-control MCP tools to delegate one small task. Do not use Bash, built-in Agent or other tools.",
    `Create a shared branch from completed node ${detail.attempts[0].nodeId} in project ${detail.projectId}, displayName MCP acceptance worker.`,
    `Create a task on that new branch titled ${delegatedTitle}, instructions: Reply exactly ${delegatedMarker}. Do not use any tools or delegate further.`,
    "Run that task. Call get_turn_result on the returned nodeId with waitMs=20000 until terminal, at most six calls total.",
    `Only after its completed output includes ${delegatedMarker}, reply VERIFIED ${delegatedMarker}. Otherwise report the observed failure and stop.`,
  ].join("\n"));
  expect(orchestrated.answer).toContain(`VERIFIED ${delegatedMarker}`);
  await page.getByRole("tab", { name: "Team", exact: true }).click();
  const delegatedCard = page.getByTestId("task-card").filter({ hasText: delegatedTitle });
  await expect(delegatedCard).toContainText("completed");
  const delegatedId = await delegatedCard.getAttribute("data-task-id");
  const delegatedDetail = await (await page.request.get(`/api/tasks/${delegatedId}`)).json();
  expect(delegatedDetail.attempts).toHaveLength(1);
  expect(delegatedDetail.attempts[0].status).toBe("completed");
  await testInfo.attach("live-evidence", { body: JSON.stringify({ projectDirectory: directory, firstNode: first.nodeId, historicalChild: child.branchId, taskId, workspace: workspace.path }), contentType: "application/json" });
  await page.screenshot({ path: testInfo.outputPath("live-team.png"), fullPage: true });
});

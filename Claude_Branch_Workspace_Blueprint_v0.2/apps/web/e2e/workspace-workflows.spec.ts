import { test, expect, type Page } from "@playwright/test";
import { mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync } from "node:child_process";

let fixture: string;
test.beforeAll(() => {
  fixture = mkdtempSync(join(tmpdir(), "cbw-ui-workflows-"));
  writeFileSync(join(fixture, "report.md"), "# Synthetic project\nUI_FILE_PROVENANCE_MARKER\n");
  mkdirSync(join(fixture, "nested"));
  writeFileSync(join(fixture, "nested", "details.txt"), "NESTED_PREVIEW_MARKER\n");
  for (const args of [
    ["init", fixture], ["-C", fixture, "add", "."],
    ["-C", fixture, "-c", "user.name=CBW Test", "-c", "user.email=cbw@example.invalid", "commit", "-m", "fixture"],
  ]) execFileSync("git", args, { windowsHide: true, stdio: "pipe" });
  // Retain only synthetic artifacts to allow inspection after a failed run.
});

test("E8: project files expand and preview without inventing source links", async ({ page }) => {
  await openFixture(page, `project-files-${Date.now()}`);
  await page.getByRole("tab", { name: "Project", exact: true }).click();
  const files = page.getByTestId("project-directory-tree");
  await files.getByRole("button").filter({ hasText: "report.md" }).click();
  await expect(page.getByTestId("project-file-content")).toContainText("UI_FILE_PROVENANCE_MARKER");
  await expect(page.getByTestId("project-graph-selection")).toContainText("No source relationship recorded");
  await page.getByTestId("project-graph-expand").click();
  await files.getByRole("button").filter({ hasText: "details.txt" }).click();
  await expect(page.getByTestId("project-file-content")).toContainText("NESTED_PREVIEW_MARKER");
});

async function openFixture(page: Page, name: string) {
  const created = await page.request.post("/api/projects", { data: { name, rootPath: fixture } });
  expect(created.status()).toBe(201);
  const project = await created.json();
  const root = await (await page.request.post("/api/branches", { data: { projectId: project.id, displayName: "Main" } })).json();
  await page.goto("/");
  await page.evaluate((id) => localStorage.setItem("cbw.activeProjectId", id), project.id);
  await page.reload();
  await expect(page.locator(".project-switch")).toContainText(name);
  return { project, branch: root.branch };
}

test("E1: add a project through the UI, then restore it after refresh", async ({ page }) => {
  await page.goto("/");
  await page.locator(".project-switch").click();
  const hub = page.getByRole("dialog", { name: "Projects" });
  await hub.getByRole("button", { name: "Add project", exact: true }).click();
  const name = `UI-created-${Date.now()}`;
  await hub.getByLabel("Project name").fill(name);
  await hub.getByLabel("Execution host path").fill(fixture);
  await hub.getByRole("button", { name: "Add", exact: true }).click();
  await hub.getByTitle("Open this project").filter({ hasText: name }).click();
  await expect(page.locator(".project-switch")).toContainText(name);
  await expect(page.locator(".project-root")).toHaveText(fixture);
  await page.reload();
  await expect(page.locator(".project-switch")).toContainText(name);
  await expect(page.locator(".composer textarea")).toBeEnabled();
});

test("E5: dispatch executes, retry creates a new real turn, and task opens its conversation", async ({ page }) => {
  test.setTimeout(90_000);
  const { project } = await openFixture(page, `team-retry-${Date.now()}`);
  await page.getByRole("tab", { name: "Team", exact: true }).click();
  await page.getByRole("button", { name: "Dispatch task", exact: true }).click();
  await page.getByLabel("Task title", { exact: true }).fill("Retry probe");
  await page.getByLabel("Task instructions", { exact: true }).fill("E2E_RETRY_ONCE");
  await page.getByRole("button", { name: "Dispatch", exact: true }).click();
  const card = page.getByTestId("task-card").filter({ hasText: "Retry probe" });
  await expect(card).toBeVisible();
  await expect(card).toContainText("failed", { timeout: 20_000 });
  const taskId = await card.getAttribute("data-task-id");
  const failed = await (await page.request.get(`/api/tasks/${taskId}`)).json();
  expect(failed.projectId).toBe(project.id);
  expect(failed.attempts).toHaveLength(1);
  expect(failed.attempts[0].status).toBe("failed");
  expect(failed.attempts[0].nodeId).toBeTruthy();
  await card.getByTestId("task-retry").click();
  await expect(card).toContainText("completed", { timeout: 20_000 });
  const complete = await (await page.request.get(`/api/tasks/${taskId}`)).json();
  expect(complete.attempts).toHaveLength(2);
  expect(complete.attempts.map((a: { status: string }) => a.status).sort()).toEqual(["completed", "failed"]);
  expect(new Set(complete.attempts.map((a: { nodeId: string }) => a.nodeId)).size).toBe(2);
  await card.getByTitle("Open this task in Chat").click();
  await expect(page.locator(".chat")).toBeVisible();
  await expect(page.locator(".msg-body").filter({ hasText: "echo for: E2E_RETRY_ONCE" })).toBeVisible();
});

test("E5: isolated dispatch uses a real worktree from the selected branch", async ({ page }) => {
  test.setTimeout(90_000);
  const { branch } = await openFixture(page, `team-isolated-${Date.now()}`);
  await page.locator(".composer textarea").fill("seed isolation anchor");
  await page.getByRole("button", { name: "Continue branch", exact: true }).click();
  await expect(page.locator(".msg-body").filter({ hasText: "echo for: seed isolation anchor" })).toBeVisible();
  await page.getByRole("tab", { name: "Team", exact: true }).click();
  await page.getByRole("button", { name: "Dispatch task", exact: true }).click();
  await page.getByLabel("Task title", { exact: true }).fill("Isolated worker");
  await page.getByLabel("Task instructions", { exact: true }).fill("isolated task content");
  await page.getByLabel("Dispatch workspace mode").selectOption("worktree");
  await page.getByRole("button", { name: "Dispatch", exact: true }).click();
  const card = page.getByTestId("task-card").filter({ hasText: "Isolated worker" });
  await expect(card).toContainText("completed", { timeout: 30_000 });
  const taskId = await card.getAttribute("data-task-id");
  const task = await (await page.request.get(`/api/tasks/${taskId}`)).json();
  const child = await (await page.request.get(`/api/branches/${task.branchId}`)).json();
  const workspace = await (await page.request.get(`/api/branches/${task.branchId}/workspace`)).json();
  expect(child.parentBranchId).toBe(branch.id);
  expect(workspace.mode).toBe("worktree");
  expect(workspace.path).not.toBe(fixture);
  expect(execFileSync("git", ["-C", fixture, "status", "--porcelain"], { encoding: "utf8", windowsHide: true })).toBe("");
});

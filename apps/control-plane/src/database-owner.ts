import { createServer, type Server } from "node:net";
import { createHash } from "node:crypto";
import { realpathSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";

/** OS-released ownership guard: a second process must not reconcile a live DB. */
export async function claimDatabase(path: string): Promise<Server> {
  const canonical = join(realpathSync(dirname(resolve(path))), basename(path));
  const key = createHash("sha256").update(process.platform === "win32" ? canonical.toLowerCase() : canonical).digest("hex");
  const server = createServer(socket => socket.end());
  await new Promise<void>((resolve, reject) => {
    const failed = () => reject(new Error("database ownership unavailable; another control plane may be using this database"));
    server.once("error", failed);
    const ready = () => { server.off("error", failed); resolve(); };
    // Named pipes leave no stale PID files after crashes. Other platforms use
    // a deterministic loopback lock port and conservatively reject collisions.
    if (process.platform === "win32") server.listen(`\\\\.\\pipe\\cbw-db-${key}`, ready);
    else server.listen({ host: "127.0.0.1", port: 20000 + parseInt(key.slice(0, 8), 16) % 40000, exclusive: true }, ready);
  });
  server.unref();
  return server;
}

import { open, realpath, stat } from "node:fs/promises";
import { isAbsolute, relative, resolve } from "node:path";

export const MAX_CONTENT_BYTES = 64 * 1024;
export class FileAccessError extends Error {
  constructor(message: string, readonly code = 403) { super(message); }
}
const sensitive = /^(?:\.env(?:\..*)?|\.envrc|\.git|\.ssh|\.aws|\.azure|\.npmrc|\.netrc|\.pgpass|\.htpasswd|credentials(?:\.json)?|secrets?\.(?:json|ya?ml|toml)|id_(?:rsa|dsa|ecdsa|ed25519))$|\.(?:pem|key|pfx|p12|keystore|jks)$/i;
const inside = (root: string, path: string) => { const rel = relative(root, path); return rel === "" || (!isAbsolute(rel) && rel !== ".." && !rel.startsWith("..\\") && !rel.startsWith("../")); };
const protectedPath = (path: string) => path.split(/[\\/]/).some(part => sensitive.test(part));

// Shared by content reads and artifact metadata: reject before reading bytes.
export async function resolveSafeFile(rootPath: string, path: string) {
  if (!path || isAbsolute(path) || /[:\x00]/.test(path)) throw new FileAccessError("path must be relative", 400);
  const root = await realpath(rootPath);
  const abs = resolve(root, path);
  if (!inside(root, abs)) throw new FileAccessError("path escapes workspace");
  if (protectedPath(path)) throw new FileAccessError("protected file cannot be opened");
  const real = await realpath(abs).catch((err: NodeJS.ErrnoException) => {
    if (err.code === "ENOENT" || err.code === "ENOTDIR") return null;
    throw err;
  });
  const normalizedPath = relative(root, abs).replaceAll("\\", "/");
  if (!real) return { path: normalizedPath, absolutePath: abs, exists: false, sizeBytes: 0 };
  if (!inside(root, real)) throw new FileAccessError("symlink escapes workspace");
  if (protectedPath(relative(root, real))) throw new FileAccessError("protected file cannot be opened");
  const info = await stat(real);
  if (!info.isFile()) throw new FileAccessError("path must identify a regular file", 400);
  return { path: normalizedPath, absolutePath: real, exists: true, sizeBytes: info.size };
}
export async function readFileContent(rootPath: string, path: string) {
  const file = await resolveSafeFile(rootPath, path);
  const base = { path: file.path, exists: file.exists, binary: false, sizeBytes: file.sizeBytes, content: null as string | null, truncated: false };
  if (!file.exists) return base;
  const handle = await open(file.absolutePath, "r");
  try {
    const buf = Buffer.alloc(Math.min(file.sizeBytes, MAX_CONTENT_BYTES) + 4);
    const { bytesRead } = await handle.read(buf, 0, buf.length, 0);
    const bytes = buf.subarray(0, Math.min(bytesRead, MAX_CONTENT_BYTES));
    base.truncated = file.sizeBytes > MAX_CONTENT_BYTES;
    if (bytes.includes(0)) return { ...base, binary: true };
    // A bounded UTF-8 prefix may end inside one code point. Trim only that tail.
    for (let tail = 0; tail <= (base.truncated ? 3 : 0); tail++) {
      try { base.content = new TextDecoder("utf-8", { fatal: true }).decode(bytes.subarray(0, bytes.length - tail)); return base; }
      catch { /* invalid UTF-8 is represented as binary, never replacement text */ }
    }
    return { ...base, binary: true };
  } finally { await handle.close(); }
}

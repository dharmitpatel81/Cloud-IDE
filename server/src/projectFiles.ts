import { mkdir, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import { z } from "zod";

const WORKSPACE_DIR = path.join(process.cwd(), "workspace");
export const MAX_FILES = 200;
export const MAX_FILE_CHARS = 1024 * 1024;
const MAX_DEPTH = 8;
const SAFE_NAME = /^[\w.\- ]{1,100}$/;
const RESERVED_NAME = /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i;

const fileEntry = z.object({ path: z.string().max(1000), content: z.string().max(MAX_FILE_CHARS) });
// No minimum: an empty project is a legitimate thing to open a terminal in.
// /run adds its own .min(1), since it needs an entry file to exist.
export const fileList = z.array(fileEntry).max(MAX_FILES);
export type FileEntry = z.infer<typeof fileEntry>;

// Path validation is the real check here — every path becomes a real file on
// this machine. The editor applies the same naming rules (web/src/files.ts),
// but that copy is only UX.
export function isSafePath(filePath: string) {
  const parts = filePath.split("/");
  return (
    parts.length <= MAX_DEPTH &&
    parts.every(
      (part) =>
        SAFE_NAME.test(part) &&
        part !== "." &&
        part !== ".." &&
        part === part.trim() &&
        !part.endsWith(".") &&
        !RESERVED_NAME.test(part),
    )
  );
}

/** What's wrong with this set of files, in words fit for the user. */
export function problemWithFiles(files: FileEntry[]): string | null {
  // Case-insensitive, because "a.py" and "A.py" are one file on this disk if
  // the server runs on Windows or macOS.
  const taken = new Set<string>();
  for (const file of files) {
    if (!isSafePath(file.path)) return `"${file.path}" isn't a valid file path.`;
    const key = file.path.toLowerCase();
    if (taken.has(key)) return `Two files are named "${file.path}".`;
    taken.add(key);
  }
  for (const file of files) {
    const parts = file.path.toLowerCase().split("/");
    for (let i = 1; i < parts.length; i++) {
      const folder = parts.slice(0, i).join("/");
      if (taken.has(folder)) return `"${folder}" is both a file and a folder.`;
    }
  }
  return null;
}

/** Writes a validated file list into a fresh directory under the workspace
 *  root and returns it, plus a cleanup function that removes it again.
 *  Assumes `problemWithFiles` has already been checked. */
export async function writeProjectFiles(files: FileEntry[]): Promise<{ dir: string; cleanup: () => Promise<void> }> {
  await mkdir(WORKSPACE_DIR, { recursive: true });
  const dir = path.join(WORKSPACE_DIR, randomUUID());
  const cleanup = () => rm(dir, { recursive: true, force: true }).catch(() => {});

  try {
    for (const file of files) {
      const target = path.resolve(dir, ...file.path.split("/"));
      // Belt and braces. isSafePath already rejects "..", but containment
      // that hangs on one regex staying right is one refactor away from a
      // traversal. No realpath needed: the folder is brand new and only we
      // write into it, so there are no symlinks to follow.
      if (!target.startsWith(dir + path.sep)) throw new Error("Invalid file path.");
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, file.content);
    }
  } catch (err) {
    await cleanup();
    throw err;
  }
  return { dir, cleanup };
}

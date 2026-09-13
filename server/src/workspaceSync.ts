import { createRequire } from "node:module";
import { lstat, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { randomUUID } from "node:crypto";
import path from "node:path";
import type * as YTypes from "yjs";
import { getYDoc } from "y-websocket/bin/utils";
import { MAX_FILES, MAX_FILE_CHARS, isSafePath, writeProjectFiles } from "./projectFiles.js";

// y-websocket's server helper is CommonJS, so its docs are built by Yjs's
// CommonJS copy. A plain `import` would load the ES copy, whose Y.Text those
// docs reject ("Unexpected content type"). Borrow the copy y-websocket uses.
const Y = createRequire(import.meta.url)("yjs") as typeof YTypes;

const POLL_MS = 1000;
const DEBOUNCE_MS = 250;
// Tool output, not the project: never mirrored into the document, never
// walked — node_modules alone is thousands of files a second to stat.
const IGNORED_DIRS = new Set(["node_modules", ".git", "__pycache__", ".venv", ".cache"]);

async function walk(base: string, rel: string, files: Map<string, string>, dirs: Set<string>) {
  const absolute = rel ? path.join(base, ...rel.split("/")) : base;
  const entries = await readdir(absolute, { withFileTypes: true });
  for (const entry of entries) {
    const childRel = rel ? `${rel}/${entry.name}` : entry.name;
    if (!isSafePath(childRel)) continue;
    if (entry.isDirectory()) {
      if (IGNORED_DIRS.has(entry.name)) continue;
      dirs.add(childRel);
      await walk(base, childRel, files, dirs);
    } else if (entry.isFile()) {
      files.set(childRel, path.join(absolute, entry.name));
    }
  }
}

export type Mirror = { dir: string; stop: () => Promise<void> };

/** Keeps a directory on disk and the project's Y.Doc in agreement, both ways:
 *  edits in the editor land in the directory (what the terminal sees), and
 *  files the shell creates or changes land in the document (what the editor
 *  sees). Naive on purpose — the disk side is *polled* once a second, whole
 *  files are compared as strings, and there's no conflict handling beyond
 *  "whichever side changed since we last looked wins". The `mirror` map is
 *  the memory of what both sides last agreed on; a side that differs from it
 *  is the one that changed. */
export async function startMirror(projectId: string): Promise<Mirror> {
  const doc = getYDoc(projectId);
  const paths = doc.getMap<string>("paths");
  const contents = doc.getMap<YTypes.Text>("contents");
  const folders = doc.getMap<boolean>("folders");

  const mirror = new Map<string, string>();
  const knownFolders = new Set<string>();
  // mtime+size of every file as of the last poll, so unchanged files are
  // never re-read.
  const diskStamp = new Map<string, string>();

  const inside = (rel: string) => {
    const target = path.resolve(dir, ...rel.split("/"));
    return target.startsWith(dir + path.sep) ? target : null;
  };

  /** The document's files, minus anything unsafe to put on this disk. */
  function docFiles(): Map<string, { id: string; text: YTypes.Text }> {
    const out = new Map<string, { id: string; text: YTypes.Text }>();
    const seen = new Set<string>();
    for (const [id, filePath] of paths.entries()) {
      const text = contents.get(id);
      if (typeof filePath !== "string" || !text || !isSafePath(filePath)) continue;
      // "a.py" and "A.py" are one file on a Windows or macOS disk.
      const key = filePath.toLowerCase();
      if (seen.has(key)) continue;
      seen.add(key);
      out.set(filePath, { id, text });
    }
    return out;
  }

  const initial = [...docFiles()].map(([filePath, { text }]) => ({ path: filePath, content: text.toString() }));
  const { dir, cleanup } = await writeProjectFiles(initial);
  for (const file of initial) mirror.set(file.path, file.content);
  for (const folder of folders.keys()) {
    const target = isSafePath(folder) ? inside(folder) : null;
    if (!target) continue;
    await mkdir(target, { recursive: true });
    knownFolders.add(folder);
  }

  // Both directions run through one chain, so a doc→disk pass never
  // interleaves with a disk→doc pass and each sees the other's result.
  let chain = Promise.resolve();
  let stopped = false;
  const enqueue = (job: () => Promise<void>) => {
    chain = chain.then(() => (stopped ? undefined : job())).catch((err: unknown) => {
      console.error(`workspace mirror for project ${projectId} failed:`, err);
    });
    return chain;
  };

  async function pushToDisk() {
    const wanted = docFiles();
    for (const [filePath, { text }] of wanted) {
      const content = text.toString();
      if (mirror.get(filePath) === content) continue;
      const target = inside(filePath);
      if (!target || !(await noLinkOnPath(dir, filePath))) continue;
      await mkdir(path.dirname(target), { recursive: true });
      await writeFile(target, content);
      mirror.set(filePath, content);
      diskStamp.delete(filePath); // let the next poll re-stamp what we wrote
    }
    for (const filePath of [...mirror.keys()]) {
      if (wanted.has(filePath)) continue;
      const target = inside(filePath);
      if (target && (await noLinkOnPath(dir, filePath))) await rm(target, { force: true });
      mirror.delete(filePath);
      diskStamp.delete(filePath);
    }
    const wantedFolders = new Set([...folders.keys()].filter(isSafePath));
    for (const folder of wantedFolders) {
      if (knownFolders.has(folder)) continue;
      const target = inside(folder);
      if (target && (await noLinkOnPath(dir, folder))) await mkdir(target, { recursive: true });
      knownFolders.add(folder);
    }
    for (const folder of [...knownFolders]) {
      if (wantedFolders.has(folder)) continue;
      const target = inside(folder);
      if (target && (await noLinkOnPath(dir, folder))) await rm(target, { recursive: true, force: true });
      knownFolders.delete(folder);
    }
  }

  async function pullFromDisk() {
    const onDisk = new Map<string, string>();
    const dirsOnDisk = new Set<string>();
    await walk(dir, "", onDisk, dirsOnDisk);

    const byPath = docFiles();
    const changes: (() => void)[] = [];

    for (const [rel, absolute] of onDisk) {
      // lstat, not stat: a file swapped for a link since the walk must not be
      // followed. readFile below still follows one swapped in after this line.
      const info = await lstat(absolute).catch(() => null);
      if (!info || !info.isFile() || info.size > MAX_FILE_CHARS) continue;
      const stamp = `${info.mtimeMs}:${info.size}`;
      if (diskStamp.get(rel) === stamp) continue;
      diskStamp.set(rel, stamp);

      const content = await readFile(absolute, "utf8").catch(() => null);
      if (content === null || content.includes("\0")) continue; // binary, or gone
      if (mirror.get(rel) === content) continue;

      const existing = byPath.get(rel);
      if (existing) {
        changes.push(() => applyText(existing.text, content));
      } else if (byPath.size + changes.length < MAX_FILES) {
        changes.push(() => {
          const id = randomUUID();
          paths.set(id, rel);
          contents.set(id, new Y.Text(content));
        });
      } else {
        continue;
      }
      mirror.set(rel, content);
    }

    for (const rel of [...mirror.keys()]) {
      if (onDisk.has(rel)) continue;
      const existing = byPath.get(rel);
      if (existing) {
        changes.push(() => {
          paths.delete(existing.id);
          contents.delete(existing.id);
        });
      }
      mirror.delete(rel);
      diskStamp.delete(rel);
    }

    for (const folder of dirsOnDisk) {
      if (knownFolders.has(folder)) continue;
      changes.push(() => folders.set(folder, true));
      knownFolders.add(folder);
    }
    for (const folder of [...knownFolders]) {
      if (dirsOnDisk.has(folder)) continue;
      changes.push(() => folders.delete(folder));
      knownFolders.delete(folder);
    }

    if (changes.length > 0) {
      doc.transact(() => {
        for (const change of changes) change();
      }, MIRROR_ORIGIN);
    }
  }

  let pushTimer: NodeJS.Timeout | undefined;
  const onUpdate = (_update: Uint8Array, origin: unknown) => {
    if (origin === MIRROR_ORIGIN) return; // our own disk→doc write
    clearTimeout(pushTimer);
    pushTimer = setTimeout(() => void enqueue(pushToDisk), DEBOUNCE_MS);
  };
  doc.on("update", onUpdate);

  let polling = false;
  const poll = setInterval(() => {
    if (polling) return;
    polling = true;
    void enqueue(pullFromDisk).finally(() => {
      polling = false;
    });
  }, POLL_MS);
  poll.unref();

  return {
    dir,
    stop: async () => {
      stopped = true;
      clearInterval(poll);
      clearTimeout(pushTimer);
      doc.off("update", onUpdate);
      await chain;
      await cleanup();
    },
  };
}

const MIRROR_ORIGIN = Symbol("workspace-mirror");

/** False if any existing part of `rel` under `base` is a symbolic link.
 *  The shell can plant links in this folder, and this process — unlike the
 *  container — would follow them out onto the host (docs/journal/0007).
 *  Check-then-act still races a shell swapping a link in afterwards; closing
 *  that for good means the server never touches this folder at all. */
async function noLinkOnPath(base: string, rel: string): Promise<boolean> {
  let current = base;
  for (const part of rel.split("/")) {
    current = path.join(current, part);
    const info = await lstat(current).catch(() => null);
    if (!info) return true; // nothing further down exists yet
    if (info.isSymbolicLink()) return false;
  }
  return true;
}

/** Replace a Y.Text's content with the smallest single edit that gets there:
 *  keep the common prefix and suffix, swap the middle. Collaborators' cursors
 *  outside the changed region stay put, which a delete-all-and-insert would
 *  never manage. */
function applyText(text: YTypes.Text, next: string) {
  const prev = text.toString();
  if (prev === next) return;
  let start = 0;
  while (start < prev.length && start < next.length && prev[start] === next[start]) start++;
  let prevEnd = prev.length;
  let nextEnd = next.length;
  while (prevEnd > start && nextEnd > start && prev[prevEnd - 1] === next[nextEnd - 1]) {
    prevEnd--;
    nextEnd--;
  }
  if (prevEnd > start) text.delete(start, prevEnd - start);
  if (nextEnd > start) text.insert(start, next.slice(start, nextEnd));
}

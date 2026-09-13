import { useCallback, useMemo, useSyncExternalStore } from "react";
import * as Y from "yjs";

// The whole project is one Y.Doc holding three maps:
//   paths:    file id -> "src/app.py"
//   contents: file id -> a Y.Text with that file's text
//   folders:  "src"   -> true, so an empty folder still exists
// A file is known by its id, never by its path. Renaming changes one string in
// `paths` and the text never moves, so someone typing in a file while you
// rename it loses nothing. The first version keyed files by path and lost
// every character typed during a rename.
// The server writes into these same maps when a shell changes files:
// server/src/workspaceSync.ts.

export type ProjectFs = {
  ydoc: Y.Doc;
  paths: Y.Map<string>;
  contents: Y.Map<Y.Text>;
  folders: Y.Map<boolean>;
};

export function projectFs(ydoc: Y.Doc): ProjectFs {
  return {
    ydoc,
    paths: ydoc.getMap<string>("paths"),
    contents: ydoc.getMap<Y.Text>("contents"),
    folders: ydoc.getMap<boolean>("folders"),
  };
}

export type FileEntry = { id: string; path: string };
/** Something in the tree: a file (by id) or a folder (by path). */
export type EntryRef = { kind: "file"; id: string } | { kind: "folder"; path: string };

export const MAX_FILES = 200;
const MAX_NAME_LENGTH = 100;
const MAX_DEPTH = 8;
const SAFE_NAME = /^[\w.\- ]+$/;
// Names Windows reserves for devices. The server may run on Windows, where
// writing "con.py" doesn't create a file.
const RESERVED_NAME = /^(con|prn|aux|nul|com\d|lpt\d)(\..*)?$/i;

export const joinPath = (dir: string, name: string) => (dir ? `${dir}/${name}` : name);
export const baseName = (path: string) => path.slice(path.lastIndexOf("/") + 1);
export function parentOf(path: string) {
  const slash = path.lastIndexOf("/");
  return slash === -1 ? "" : path.slice(0, slash);
}
/** True for `target` itself and everything inside it. */
export const isWithin = (path: string, target: string) =>
  path === target || path.startsWith(`${target}/`);
/** Where `path` ends up after `from` is renamed to `to`. */
export const movedPath = (path: string, from: string, to: string) =>
  isWithin(path, from) ? to + path.slice(from.length) : path;

/** Files that are fully there, sorted by path. A file needs both its path and
 *  its contents; when a delete and a rename race, one half can briefly be
 *  missing. */
export function listFiles(fs: ProjectFs): FileEntry[] {
  const files: FileEntry[] = [];
  for (const [id, path] of fs.paths.entries()) {
    // Collaborators can write anything into the doc. Skip what we can't show.
    if (typeof path !== "string" || /[\t\n]/.test(path) || !fs.contents.has(id)) continue;
    files.push({ id, path });
  }
  return files.sort((a, b) => a.path.localeCompare(b.path) || a.id.localeCompare(b.id));
}

/** Is `path` used by something other than `ignore`? Case-insensitive, because
 *  "a.py" and "A.py" are the same file on Windows and macOS disks. */
function taken(fs: ProjectFs, path: string, ignore?: EntryRef) {
  const wanted = path.toLowerCase();
  const ignored = (candidate: string, id?: string) =>
    ignore?.kind === "file" ? id === ignore.id : ignore ? isWithin(candidate, ignore.path) : false;

  for (const folder of fs.folders.keys()) {
    if (!ignored(folder) && folder.toLowerCase() === wanted) return true;
  }
  // A folder also exists implicitly while any file sits inside it.
  return listFiles(fs).some(
    (file) => !ignored(file.path, file.id) && isWithin(file.path.toLowerCase(), wanted),
  );
}

/** Why `name` can't be used inside `dir`, or null if it can.
 *  Anyone in the room can write any key into these maps, so this is UX, not
 *  enforcement. The server checks every path again before it writes a file
 *  (server/src/run/routes.ts). */
function nameProblem(fs: ProjectFs, dir: string, name: string, ignore?: EntryRef) {
  if (!name) return "A name is required.";
  if (name.length > MAX_NAME_LENGTH) return `Names are limited to ${MAX_NAME_LENGTH} characters.`;
  if (name === "." || name === "..") return `"${name}" is reserved.`;
  if (name !== name.trim() || name.endsWith(".")) return "Names can't end with a space or a dot.";
  if (!SAFE_NAME.test(name)) return "Use letters, numbers, spaces, dots, dashes or underscores.";
  if (RESERVED_NAME.test(name)) return `"${name}" is a reserved name on Windows.`;
  const path = joinPath(dir, name);
  if (path.split("/").length > MAX_DEPTH) return "That's nested too deep.";
  if (taken(fs, path, ignore)) return `"${name}" already exists here.`;
  return null;
}

/** Creates an empty file and returns its id. Throws with a message that's
 *  fine to show the user. */
export function createFile(fs: ProjectFs, dir: string, name: string): string {
  const problem = nameProblem(fs, dir, name);
  if (problem) throw new Error(problem);
  if (listFiles(fs).length >= MAX_FILES) throw new Error(`A project holds at most ${MAX_FILES} files.`);
  const id = crypto.randomUUID();
  fs.ydoc.transact(() => {
    fs.paths.set(id, joinPath(dir, name));
    fs.contents.set(id, new Y.Text());
  });
  return id;
}

/** Creates an empty folder and returns its path. */
export function createFolder(fs: ProjectFs, dir: string, name: string): string {
  const problem = nameProblem(fs, dir, name);
  if (problem) throw new Error(problem);
  const path = joinPath(dir, name);
  fs.folders.set(path, true);
  return path;
}

/** Renames a file or folder and returns the new path. Only strings change;
 *  file contents stay exactly where they are. */
export function renameEntry(fs: ProjectFs, ref: EntryRef, newName: string): string {
  const from = ref.kind === "file" ? fs.paths.get(ref.id) : ref.path;
  if (from === undefined) throw new Error("That file no longer exists.");
  const dir = parentOf(from);
  const to = joinPath(dir, newName);
  if (to === from) return from;
  const problem = nameProblem(fs, dir, newName, ref);
  if (problem) throw new Error(problem);

  if (ref.kind === "file") {
    fs.paths.set(ref.id, to);
    return to;
  }
  fs.ydoc.transact(() => {
    for (const file of listFiles(fs)) {
      if (isWithin(file.path, from)) fs.paths.set(file.id, movedPath(file.path, from, to));
    }
    for (const folder of [...fs.folders.keys()]) {
      if (!isWithin(folder, from)) continue;
      fs.folders.delete(folder);
      fs.folders.set(movedPath(folder, from, to), true);
    }
  });
  return to;
}

/** Deletes a file, or a folder and everything inside it, for everyone. */
export function deleteEntry(fs: ProjectFs, ref: EntryRef) {
  fs.ydoc.transact(() => {
    const ids =
      ref.kind === "file"
        ? [ref.id]
        : listFiles(fs)
            .filter((file) => isWithin(file.path, ref.path))
            .map((file) => file.id);
    for (const id of ids) {
      fs.paths.delete(id);
      fs.contents.delete(id);
    }
    if (ref.kind === "folder") {
      for (const folder of [...fs.folders.keys()]) {
        if (isWithin(folder, ref.path)) fs.folders.delete(folder);
      }
    }
  });
}

type FolderNode = { kind: "folder"; path: string; name: string; children: TreeNode[] };
type FileNode = { kind: "file"; id: string; path: string; name: string };
export type TreeNode = FolderNode | FileNode;

/** Turns flat paths into a sorted tree: folders first, then by name. */
export function buildTree(files: FileEntry[], folderPaths: string[]): TreeNode[] {
  const root: TreeNode[] = [];
  const folders = new Map<string, FolderNode>();

  const childrenOf = (dir: string) => (dir ? folder(dir).children : root);
  function folder(path: string): FolderNode {
    let node = folders.get(path);
    if (!node) {
      node = { kind: "folder", path, name: baseName(path), children: [] };
      folders.set(path, node);
      childrenOf(parentOf(path)).push(node);
    }
    return node;
  }

  folderPaths.forEach(folder);
  for (const { id, path } of files) {
    childrenOf(parentOf(path)).push({ kind: "file", id, path, name: baseName(path) });
  }

  const sort = (nodes: TreeNode[]) => {
    nodes.sort((a, b) =>
      a.kind === b.kind ? a.name.localeCompare(b.name) : a.kind === "folder" ? -1 : 1,
    );
    for (const node of nodes) if (node.kind === "folder") sort(node.children);
  };
  sort(root);
  return root;
}

export type FileKind = "python" | "javascript" | "typescript" | "json" | "markdown" | "text";
export type Runtime = "python" | "node";

// A Map, not an object literal: a file named "x.constructor" would otherwise
// find Object.prototype.constructor.
const KIND_BY_EXTENSION = new Map<string, FileKind>([
  ["py", "python"],
  ["js", "javascript"],
  ["mjs", "javascript"],
  ["cjs", "javascript"],
  ["jsx", "javascript"],
  ["ts", "typescript"],
  ["tsx", "typescript"],
  ["json", "json"],
  ["md", "markdown"],
]);

export const KIND_LABELS: Record<FileKind, string> = {
  python: "Python",
  javascript: "JavaScript",
  typescript: "TypeScript",
  json: "JSON",
  markdown: "Markdown",
  text: "Plain Text",
};

export function extensionOf(path: string) {
  const name = baseName(path);
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

export const fileKind = (path: string): FileKind =>
  KIND_BY_EXTENSION.get(extensionOf(path)) ?? "text";

/** Which runner can execute this file, if any. Mirrors the server's check. */
export function runtimeFor(path: string): Runtime | null {
  const extension = extensionOf(path);
  if (extension === "py") return "python";
  if (extension === "js" || extension === "mjs" || extension === "cjs") return "node";
  return null;
}

/** The whole project as plain path/content pairs — what both `/run` and the
 *  terminal's `init` message send the server. */
export function snapshotFiles(fs: ProjectFs, files: FileEntry[]): { path: string; content: string }[] {
  return files.map((file) => ({ path: file.path, content: fs.contents.get(file.id)?.toString() ?? "" }));
}

/** Every file in the project, re-rendering when files are added, renamed or
 *  removed. Typing inside a file doesn't trigger it: observe(), not
 *  observeDeep(), only reports changes to the maps themselves. */
export function useFiles(fs: ProjectFs): FileEntry[] {
  const subscribe = useCallback(
    (onChange: () => void) => {
      fs.paths.observe(onChange);
      fs.contents.observe(onChange);
      return () => {
        fs.paths.unobserve(onChange);
        fs.contents.unobserve(onChange);
      };
    },
    [fs],
  );
  // A string compares by value, so it's a stable snapshot without a cache
  // that has to be kept in sync. listFiles() drops paths with tabs or
  // newlines, so the separators can't be forged.
  const snapshot = useSyncExternalStore(subscribe, () =>
    listFiles(fs)
      .map((file) => `${file.id}\t${file.path}`)
      .join("\n"),
  );
  return useMemo(
    () =>
      snapshot
        ? snapshot.split("\n").map((row) => {
            const tab = row.indexOf("\t");
            return { id: row.slice(0, tab), path: row.slice(tab + 1) };
          })
        : [],
    [snapshot],
  );
}

function useSubscribe<T>(map: Y.Map<T>) {
  return useCallback(
    (onChange: () => void) => {
      map.observe(onChange);
      return () => map.unobserve(onChange);
    },
    [map],
  );
}

/** The map's keys, sorted. Re-renders only when the set of keys changes. */
export function useMapKeys<T>(map: Y.Map<T>): string[] {
  const subscribe = useSubscribe(map);
  const joined = useSyncExternalStore(subscribe, () => [...map.keys()].sort().join("\n"));
  return useMemo(() => (joined ? joined.split("\n") : []), [joined]);
}

/** The value under `key`: the same object until that key is replaced or
 *  deleted, so a component can depend on its identity. */
export function useMapValue<T>(map: Y.Map<T>, key: string | null): T | undefined {
  const subscribe = useSubscribe(map);
  return useSyncExternalStore(subscribe, () => (key === null ? undefined : map.get(key)));
}

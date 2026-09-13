import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from "react";
import {
  buildTree,
  isWithin,
  joinPath,
  movedPath,
  parentOf,
  type EntryRef,
  type FileEntry,
  type TreeNode,
} from "./files";
import {
  ChevronRightIcon,
  CollapseAllIcon,
  FileTypeIcon,
  FolderIcon,
  FolderOpenIcon,
  NewFileIcon,
  NewFolderIcon,
} from "./icons";

/** A file or folder being named, before it exists. */
export type Draft = { kind: "file" | "folder"; dir: string };

type MenuItem = { label: string; hint?: string; danger?: boolean; run: () => void } | "separator";
type Menu = { x: number; y: number; target: TreeNode | null };

const indent = (depth: number) => 8 + depth * 12;

/** Files are identified by id and folders by path, so keys survive renames. */
const keyOf = (node: TreeNode) => (node.kind === "file" ? `file:${node.id}` : `folder:${node.path}`);
const refOf = (node: TreeNode): EntryRef =>
  node.kind === "file" ? { kind: "file", id: node.id } : { kind: "folder", path: node.path };

/** Every folder on the way down to `dir`, itself included: "a/b" -> ["a", "a/b"]. */
function ancestors(dir: string): string[] {
  if (!dir) return [];
  const parts = dir.split("/");
  return parts.map((_, i) => parts.slice(0, i + 1).join("/"));
}

export function FileExplorer({
  projectName,
  files,
  folderPaths,
  loaded,
  activeId,
  draft,
  onDraftChange,
  onOpen,
  onCreate,
  onRename,
  onDelete,
}: {
  projectName: string;
  files: FileEntry[];
  folderPaths: string[];
  /** False until the first sync, when an empty tree would be a lie. */
  loaded: boolean;
  activeId: string | null;
  draft: Draft | null;
  onDraftChange: (draft: Draft | null) => void;
  onOpen: (id: string) => void;
  /** Returns a problem to show next to the input, or null on success. */
  onCreate: (draft: Draft, name: string) => string | null;
  /** Returns a problem to show next to the input, or null on success. */
  onRename: (ref: EntryRef, newName: string) => string | null;
  onDelete: (ref: EntryRef) => void;
}) {
  // Which folders are open, what's selected, and what's being renamed are
  // yours alone. They live in React state, not in the shared document.
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
  const [sectionOpen, setSectionOpen] = useState(true);
  const [selected, setSelected] = useState<string | null>(null);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [menu, setMenu] = useState<Menu | null>(null);
  const closeMenu = useCallback(() => setMenu(null), []);

  const tree = useMemo(() => buildTree(files, folderPaths), [files, folderPaths]);
  const nodesByKey = useMemo(() => {
    const nodes = new Map<string, TreeNode>();
    const walk = (list: TreeNode[]) => {
      for (const node of list) {
        nodes.set(keyOf(node), node);
        if (node.kind === "folder") walk(node.children);
      }
    };
    walk(tree);
    return nodes;
  }, [tree]);

  // Folders on the way to a pending draft stay open, so the input is visible.
  const isOpen = (path: string) =>
    expanded.has(path) || (draft !== null && isWithin(draft.dir, path));

  // New entries go next to the selection: into it if it's a folder, beside it
  // if it's a file. A selection a collaborator just deleted falls back to root.
  const selectedNode = selected === null ? undefined : nodesByKey.get(selected);
  const targetDir = !selectedNode
    ? ""
    : selectedNode.kind === "folder"
      ? selectedNode.path
      : parentOf(selectedNode.path);

  function reveal(dir: string) {
    setExpanded((prev) => new Set([...prev, ...ancestors(dir)]));
  }

  function toggle(path: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }

  function startDraft(kind: Draft["kind"], dir = targetDir) {
    setRenaming(null);
    setSectionOpen(true);
    onDraftChange({ kind, dir });
  }

  function confirmDelete(node: TreeNode) {
    const what =
      node.kind === "folder" ? `the folder "${node.name}" and everything in it` : `"${node.name}"`;
    if (window.confirm(`Delete ${what}? It's deleted for everyone in the project.`)) {
      onDelete(refOf(node));
    }
  }

  function onRowClick(node: TreeNode) {
    setSelected(keyOf(node));
    if (node.kind === "folder") toggle(node.path);
    else onOpen(node.id);
  }

  function onRowKeyDown(event: KeyboardEvent, node: TreeNode) {
    const deleteKey = event.key === "Delete" || (event.key === "Backspace" && event.metaKey);
    if (event.key === "F2") {
      event.preventDefault();
      setRenaming(keyOf(node));
    } else if (deleteKey) {
      event.preventDefault();
      confirmDelete(node);
    } else if (node.kind === "folder" && event.key === "ArrowRight" && !isOpen(node.path)) {
      toggle(node.path);
    } else if (node.kind === "folder" && event.key === "ArrowLeft" && isOpen(node.path)) {
      toggle(node.path);
    }
  }

  function openMenu(event: MouseEvent, target: TreeNode | null) {
    event.preventDefault();
    event.stopPropagation();
    if (target) setSelected(keyOf(target));
    setMenu({ x: event.clientX, y: event.clientY, target });
  }

  function menuItems(target: TreeNode | null): MenuItem[] {
    const dir = !target ? "" : target.kind === "folder" ? target.path : parentOf(target.path);
    const create: MenuItem[] = [
      { label: "New File…", run: () => startDraft("file", dir) },
      { label: "New Folder…", run: () => startDraft("folder", dir) },
    ];
    if (!target) return create;
    const edit: MenuItem[] = [
      { label: "Rename…", hint: "F2", run: () => setRenaming(keyOf(target)) },
      { label: "Delete", hint: "Del", danger: true, run: () => confirmDelete(target) },
    ];
    const open: MenuItem[] =
      target.kind === "file" ? [{ label: "Open", run: () => onOpen(target.id) }, "separator"] : [];
    return [...open, ...create, "separator", ...edit];
  }

  function draftInput(depth: number) {
    if (!draft) return null;
    return (
      <NameInput
        key={`${draft.kind}:${draft.dir}`}
        kind={draft.kind}
        depth={depth}
        onSubmit={(name) => {
          const problem = onCreate(draft, name);
          if (problem === null) {
            reveal(draft.dir);
            // A new folder becomes the selection, so the next New File lands
            // inside it. A new file opens in a tab and leaves the folder selected.
            const folder = draft.kind === "folder" ? joinPath(draft.dir, name) : draft.dir;
            setSelected(folder ? `folder:${folder}` : null);
            onDraftChange(null);
          }
          return problem;
        }}
        onCancel={() => onDraftChange(null)}
      />
    );
  }

  function renameInput(node: TreeNode, depth: number) {
    return (
      <NameInput
        kind={node.kind}
        depth={depth}
        initial={node.name}
        onSubmit={(name) => {
          const problem = onRename(refOf(node), name);
          if (problem === null) {
            if (node.kind === "folder") {
              const to = joinPath(parentOf(node.path), name);
              setExpanded((prev) => new Set([...prev].map((path) => movedPath(path, node.path, to))));
              setSelected(`folder:${to}`);
            }
            setRenaming(null);
          }
          return problem;
        }}
        onCancel={() => setRenaming(null)}
      />
    );
  }

  function renderNodes(nodes: TreeNode[], depth: number): ReactNode {
    return nodes.map((node) => {
      const key = keyOf(node);
      const open = node.kind === "folder" && isOpen(node.path);
      const classes = ["tree-row"];
      if (selected === key) classes.push("selected");
      if (node.kind === "file" && node.id === activeId) classes.push("active");

      return (
        <div key={key}>
          {renaming === key ? (
            renameInput(node, depth)
          ) : (
            <button
              type="button"
              className={classes.join(" ")}
              style={{ paddingLeft: indent(depth) }}
              title={node.path}
              aria-expanded={node.kind === "folder" ? open : undefined}
              onClick={() => onRowClick(node)}
              onKeyDown={(event) => onRowKeyDown(event, node)}
              onContextMenu={(event) => openMenu(event, node)}
            >
              {node.kind === "folder" ? (
                <>
                  <ChevronRightIcon size={16} className={open ? "chevron open" : "chevron"} />
                  {open ? (
                    <FolderOpenIcon size={16} className="folder-icon" />
                  ) : (
                    <FolderIcon size={16} className="folder-icon" />
                  )}
                </>
              ) : (
                <>
                  <span className="chevron-spacer" />
                  <FileTypeIcon path={node.path} size={18} />
                </>
              )}
              {/* Filenames come from collaborators: rendered as text, never HTML. */}
              <span className="tree-name">{node.name}</span>
            </button>
          )}
          {node.kind === "folder" && open && (
            <>
              {draft?.dir === node.path && draftInput(depth + 1)}
              {renderNodes(node.children, depth + 1)}
            </>
          )}
        </div>
      );
    });
  }

  return (
    <>
      <div className="sidebar-header">EXPLORER</div>
      <div className="tree-section">
        <button
          type="button"
          className="tree-section-toggle"
          aria-expanded={sectionOpen}
          title={projectName}
          onClick={() => setSectionOpen((open) => !open)}
        >
          <ChevronRightIcon size={16} className={sectionOpen ? "chevron open" : "chevron"} />
          <span className="tree-section-name">{projectName}</span>
        </button>
        <div className="tree-actions">
          <button
            type="button"
            className="icon-btn"
            title="New File (Alt+N)"
            aria-label="New File"
            disabled={!loaded}
            onClick={() => startDraft("file")}
          >
            <NewFileIcon size={22} />
          </button>
          <button
            type="button"
            className="icon-btn"
            title="New Folder (Alt+Shift+N)"
            aria-label="New Folder"
            disabled={!loaded}
            onClick={() => startDraft("folder")}
          >
            <NewFolderIcon size={22} />
          </button>
          <button
            type="button"
            className="icon-btn"
            title="Collapse Folders"
            aria-label="Collapse Folders"
            onClick={() => setExpanded(new Set())}
          >
            <CollapseAllIcon size={22} />
          </button>
        </div>
      </div>

      {sectionOpen && (
        <div
          className="tree"
          onContextMenu={(event) => loaded && openMenu(event, null)}
          onClick={(event) => {
            if (event.target === event.currentTarget) setSelected(null);
          }}
        >
          {!loaded ? (
            <p className="tree-empty">Loading files…</p>
          ) : (
            <>
              {draft?.dir === "" && draftInput(0)}
              {renderNodes(tree, 0)}
              {tree.length === 0 && !draft && (
                <div className="tree-empty">
                  <p>This project has no files yet.</p>
                  <button
                    type="button"
                    className="btn btn-primary"
                    onClick={() => startDraft("file", "")}
                  >
                    New File
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      )}

      {menu && (
        <ContextMenu x={menu.x} y={menu.y} items={menuItems(menu.target)} onClose={closeMenu} />
      )}
    </>
  );
}

/** The inline text box used to name a new entry or rename an existing one. */
function NameInput({
  kind,
  depth,
  initial = "",
  onSubmit,
  onCancel,
}: {
  kind: "file" | "folder";
  depth: number;
  initial?: string;
  /** Returns a problem to show, or null once the name has been applied. */
  onSubmit: (name: string) => string | null;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(initial);
  const [error, setError] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  // Enter, Escape and blur can all end an edit, and a successful Enter
  // unmounts the input, which some browsers report as one more blur.
  const finished = useRef(false);

  useEffect(() => {
    const input = inputRef.current;
    if (!input) return;
    input.focus();
    // Like VS Code: preselect the name but not the extension.
    const dot = initial.lastIndexOf(".");
    input.setSelectionRange(0, kind === "file" && dot > 0 ? dot : initial.length);
  }, [initial, kind]);

  function finish(commit: boolean, keepOpenOnError: boolean) {
    if (finished.current) return;
    const name = value.trim();
    if (!commit || !name || name === initial) {
      finished.current = true;
      onCancel();
      return;
    }
    const problem = onSubmit(name);
    if (problem === null) {
      finished.current = true;
    } else if (keepOpenOnError) {
      setError(problem);
    } else {
      // Clicking away from an invalid name abandons it, as VS Code does.
      finished.current = true;
      onCancel();
    }
  }

  return (
    <div className="tree-input-row" style={{ paddingLeft: indent(depth) }}>
      <span className="chevron-spacer" />
      {kind === "folder" ? (
        <FolderIcon size={16} className="folder-icon" />
      ) : (
        <FileTypeIcon path={value} size={16} />
      )}
      <div className="tree-input-wrap">
        <input
          ref={inputRef}
          className={error ? "tree-input invalid" : "tree-input"}
          value={value}
          aria-label={initial ? `Rename ${initial}` : `New ${kind} name`}
          aria-invalid={error ? true : undefined}
          maxLength={100}
          spellCheck={false}
          autoComplete="off"
          onChange={(event) => {
            setValue(event.target.value);
            setError("");
          }}
          onKeyDown={(event) => {
            if (event.key === "Enter") {
              event.preventDefault();
              finish(true, true);
            } else if (event.key === "Escape") {
              event.preventDefault();
              finish(false, false);
            }
          }}
          onBlur={() => finish(true, false)}
        />
        {error && (
          <div className="tree-input-error" role="alert">
            {error}
          </div>
        )}
      </div>
    </div>
  );
}

function ContextMenu({
  x,
  y,
  items,
  onClose,
}: {
  x: number;
  y: number;
  items: MenuItem[];
  /** Must be referentially stable, or the menu re-focuses on every render. */
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    ref.current?.querySelector("button")?.focus();
    const onPointerDown = (event: PointerEvent) => {
      if (!ref.current?.contains(event.target as Node)) onClose();
    };
    const onKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("blur", onClose);
    window.addEventListener("resize", onClose);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("blur", onClose);
      window.removeEventListener("resize", onClose);
    };
  }, [onClose]);

  function moveFocus(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
    event.preventDefault();
    const buttons = [...(ref.current?.querySelectorAll("button") ?? [])];
    const current = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const step = event.key === "ArrowDown" ? 1 : -1;
    buttons[(current + step + buttons.length) % buttons.length]?.focus();
  }

  // Keep the menu on screen when opened near the right or bottom edge.
  const style = {
    left: Math.max(4, Math.min(x, window.innerWidth - 200)),
    top: Math.max(4, Math.min(y, window.innerHeight - items.length * 28 - 16)),
  };

  return (
    <div className="context-menu" role="menu" ref={ref} style={style} onKeyDown={moveFocus}>
      {items.map((item, i) =>
        item === "separator" ? (
          <hr key={`separator-${i}`} />
        ) : (
          <button
            key={item.label}
            type="button"
            role="menuitem"
            className={item.danger ? "danger" : undefined}
            onClick={() => {
              onClose();
              item.run();
            }}
          >
            <span>{item.label}</span>
            {item.hint && <span className="menu-hint">{item.hint}</span>}
          </button>
        ),
      )}
    </div>
  );
}

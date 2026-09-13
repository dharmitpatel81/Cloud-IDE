import { useLayoutEffect, useRef } from "react";
import { EditorState, type Extension } from "@codemirror/state";
import {
  EditorView,
  crosshairCursor,
  drawSelection,
  dropCursor,
  highlightActiveLine,
  highlightActiveLineGutter,
  highlightSpecialChars,
  keymap,
  lineNumbers,
  rectangularSelection,
} from "@codemirror/view";
import { defaultKeymap, indentWithTab } from "@codemirror/commands";
import { bracketMatching, foldGutter, foldKeymap, indentOnInput } from "@codemirror/language";
import { highlightSelectionMatches, searchKeymap } from "@codemirror/search";
import {
  autocompletion,
  closeBrackets,
  closeBracketsKeymap,
  completionKeymap,
} from "@codemirror/autocomplete";
import { python } from "@codemirror/lang-python";
import { javascript } from "@codemirror/lang-javascript";
import { json } from "@codemirror/lang-json";
import { markdown } from "@codemirror/lang-markdown";
import { vscodeDark } from "@uiw/codemirror-theme-vscode";
import type * as Y from "yjs";
import type { WebsocketProvider } from "y-websocket";
import { yCollab } from "y-codemirror.next";
import { extensionOf } from "./files";

export type Cursor = { line: number; col: number };

// CodeMirror's basicSetup, minus history(). CodeMirror's history records every
// change, including the ones that arrive from collaborators, so its Ctrl+Z
// would undo other people's typing. yCollab brings a Yjs undo manager that
// only undoes your own edits. With both installed, Ctrl+Z falls through to
// CodeMirror's history whenever the Yjs undo stack is empty.
const editorSetup: Extension = [
  lineNumbers(),
  highlightActiveLineGutter(),
  highlightSpecialChars(),
  foldGutter(),
  drawSelection(),
  dropCursor(),
  EditorState.allowMultipleSelections.of(true),
  indentOnInput(),
  bracketMatching(),
  closeBrackets(),
  autocompletion(),
  rectangularSelection(),
  crosshairCursor(),
  highlightActiveLine(),
  highlightSelectionMatches(),
  keymap.of([
    ...closeBracketsKeymap,
    ...defaultKeymap,
    ...searchKeymap,
    ...foldKeymap,
    ...completionKeymap,
    // Tab indents, like every desktop editor. Keyboard users leave the
    // editor with Escape, then Tab.
    indentWithTab,
  ]),
];

function languageFor(extension: string): Extension {
  switch (extension) {
    case "py":
      return python();
    case "js":
    case "mjs":
    case "cjs":
      return javascript();
    case "jsx":
      return javascript({ jsx: true });
    case "ts":
      return javascript({ typescript: true });
    case "tsx":
      return javascript({ jsx: true, typescript: true });
    case "json":
      return json();
    case "md":
      return markdown();
    default:
      return [];
  }
}

const cursorOf = (state: EditorState): Cursor => {
  const head = state.selection.main.head;
  const line = state.doc.lineAt(head);
  return { line: line.number, col: head - line.from + 1 };
};

/** One CodeMirror view bound to one file's Y.Text. */
export function CodeEditor({
  path,
  ytext,
  awareness,
  onCursor,
}: {
  path: string;
  ytext: Y.Text;
  awareness: WebsocketProvider["awareness"];
  /** Must be referentially stable: a new function rebuilds the editor. */
  onCursor: (cursor: Cursor) => void;
}) {
  const hostRef = useRef<HTMLDivElement>(null);
  // Only the extension matters to the editor. Depending on it rather than the
  // path means a collaborator renaming "a.py" to "b.py" doesn't rebuild the
  // editor out from under your cursor.
  const extension = extensionOf(path);

  // A layout effect, so the view exists before the browser paints and there's
  // never a frame of empty editor. It's rebuilt when the file changes.
  useLayoutEffect(() => {
    const parent = hostRef.current;
    if (!parent) return;

    const view = new EditorView({
      parent,
      state: EditorState.create({
        // Read the text and attach the binding in one synchronous step. The
        // binding only forwards *changes* between editor and Y.Text, so the
        // two must start out identical: an edit landing in between would sit
        // in one and never reach the other.
        doc: ytext.toString(),
        extensions: [
          editorSetup,
          vscodeDark,
          languageFor(extension),
          yCollab(ytext, awareness),
          EditorView.updateListener.of((update) => {
            if (update.selectionSet || update.docChanged) onCursor(cursorOf(update.state));
          }),
        ],
      }),
    });
    onCursor(cursorOf(view.state));
    view.focus();

    return () => view.destroy();
  }, [extension, ytext, awareness, onCursor]);

  return <div className="code-editor" ref={hostRef} />;
}

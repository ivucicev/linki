import { useEditor, EditorContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Image from "@tiptap/extension-image";
import Link from "@tiptap/extension-link";
import Underline from "@tiptap/extension-underline";
import { TextStyle } from "@tiptap/extension-text-style";
import { Color } from "@tiptap/extension-color";
import { Table } from "@tiptap/extension-table";
import { TableRow } from "@tiptap/extension-table-row";
import { TableCell } from "@tiptap/extension-table-cell";
import { TableHeader } from "@tiptap/extension-table-header";
import { useEffect, useRef, useState } from "react";
import {
  RiBold, RiItalic, RiUnderline, RiLink, RiImageLine,
  RiListUnordered, RiListOrdered, RiFormatClear, RiTable2,
  RiInsertRowBottom, RiInsertRowTop, RiInsertColumnLeft, RiInsertColumnRight,
  RiDeleteRow, RiDeleteColumn,
} from "react-icons/ri";

// Image with resizable width attribute
const ResizableImage = Image.extend({
  addAttributes() {
    return {
      ...this.parent?.(),
      width: { default: null, renderHTML: (attrs) => attrs.width ? { width: attrs.width, style: `width:${attrs.width}px` } : {} },
    };
  },
});

// TableCell/Header with no border in HTML output (borders only in editor via CSS)
const BorderlessCell = TableCell.extend({
  addAttributes() {
    return { ...this.parent?.(), style: { default: "border:none;padding:6px 8px;vertical-align:top", renderHTML: (attrs) => ({ style: attrs.style }) } };
  },
});
const BorderlessHeader = TableHeader.extend({
  addAttributes() {
    return { ...this.parent?.(), style: { default: "border:none;padding:6px 8px;vertical-align:top", renderHTML: (attrs) => ({ style: attrs.style }) } };
  },
});

interface Props {
  value: string;
  onChange: (html: string) => void;
  placeholder?: string;
  className?: string;
}

export default function RichTextEditor({ value, onChange, placeholder, className }: Props) {
  const initialized = useRef(false);
  const [imgWidth, setImgWidth] = useState("");

  const editor = useEditor({
    extensions: [
      StarterKit,
      Underline,
      TextStyle,
      Color,
      ResizableImage.configure({ inline: true, allowBase64: true }),
      Link.configure({ openOnClick: false, HTMLAttributes: { rel: "noopener noreferrer" } }),
      Table.configure({ resizable: false, HTMLAttributes: { style: "border-collapse:collapse;width:100%" } }),
      TableRow,
      BorderlessCell,
      BorderlessHeader,
    ],
    content: value,
    onUpdate: ({ editor }) => onChange(editor.getHTML()),
    editorProps: {
      attributes: {
        class: "min-h-[120px] outline-none px-3 py-2 text-sm",
        ...(placeholder ? { "data-placeholder": placeholder } : {}),
      },
    },
  });

  useEffect(() => {
    if (!editor) return;
    if (!initialized.current) { initialized.current = true; return; }
    if (editor.getHTML() !== value) {
      editor.commands.setContent(value, { emitUpdate: false });
    }
  }, [value, editor]);

  // Sync imgWidth input when selection changes
  useEffect(() => {
    if (!editor) return;
    const update = () => {
      const attrs = editor.getAttributes("image");
      setImgWidth(attrs.width ? String(attrs.width) : "");
    };
    editor.on("selectionUpdate", update);
    return () => { editor.off("selectionUpdate", update); };
  }, [editor]);

  function applyImgWidth(w: string) {
    const n = parseInt(w, 10);
    if (!n || n < 1) return;
    editor?.chain().focus().updateAttributes("image", { width: n }).run();
  }

  function addLink() {
    const url = window.prompt("URL");
    if (!url) return;
    editor?.chain().focus().setLink({ href: url }).run();
  }

  function uploadImage(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      // Determine natural width, cap at 200px for signatures
      const img = new window.Image();
      img.onload = () => {
        const w = Math.min(img.naturalWidth || 200, 200);
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        editor?.chain().focus().setImage({ src: reader.result as string, width: w } as any).run();
        setImgWidth(String(w));
      };
      img.onerror = () => {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        editor?.chain().focus().setImage({ src: reader.result as string, width: 150 } as any).run();
        setImgWidth("150");
      };
      img.src = reader.result as string;
    };
    reader.readAsDataURL(file);
    e.target.value = "";
  }

  const fileInputRef = useRef<HTMLInputElement>(null);
  const inTable = editor?.isActive("table");
  const inImage = editor?.isActive("image");

  if (!editor) return null;

  return (
    <div className={`border border-base-300/50 rounded-lg bg-base-300/50 overflow-hidden ${className ?? ""}`}>
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-0.5 px-2 py-1.5 border-b border-base-300/50 bg-base-200/60">
        <ToolBtn onClick={() => editor.chain().focus().toggleBold().run()} active={editor.isActive("bold")} title="Bold">
          <RiBold size={13} />
        </ToolBtn>
        <ToolBtn onClick={() => editor.chain().focus().toggleItalic().run()} active={editor.isActive("italic")} title="Italic">
          <RiItalic size={13} />
        </ToolBtn>
        <ToolBtn onClick={() => editor.chain().focus().toggleUnderline().run()} active={editor.isActive("underline")} title="Underline">
          <RiUnderline size={13} />
        </ToolBtn>
        <div className="w-px h-4 bg-base-300/70 mx-1" />
        <ToolBtn onClick={addLink} active={editor.isActive("link")} title="Link">
          <RiLink size={13} />
        </ToolBtn>
        <ToolBtn onClick={() => fileInputRef.current?.click()} title="Upload image">
          <RiImageLine size={13} />
        </ToolBtn>
        {/* Image width input — shown when image is selected */}
        {inImage && (
          <div className="flex items-center gap-1 ml-1">
            <input
              type="number"
              value={imgWidth}
              onChange={(e) => setImgWidth(e.target.value)}
              onBlur={(e) => applyImgWidth(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && applyImgWidth(imgWidth)}
              placeholder="px"
              className="w-14 h-5 px-1.5 text-xs bg-base-300 border border-base-300/70 rounded outline-none focus:border-primary"
            />
            <span className="text-[10px] text-base-content/30">px</span>
          </div>
        )}
        <div className="w-px h-4 bg-base-300/70 mx-1" />
        <ToolBtn onClick={() => editor.chain().focus().toggleBulletList().run()} active={editor.isActive("bulletList")} title="Bullet list">
          <RiListUnordered size={13} />
        </ToolBtn>
        <ToolBtn onClick={() => editor.chain().focus().toggleOrderedList().run()} active={editor.isActive("orderedList")} title="Ordered list">
          <RiListOrdered size={13} />
        </ToolBtn>
        <div className="w-px h-4 bg-base-300/70 mx-1" />
        {/* Table insert / controls */}
        {!inTable ? (
          <ToolBtn
            onClick={() => editor.chain().focus().insertTable({ rows: 2, cols: 2, withHeaderRow: false }).run()}
            title="Insert table (borderless layout)"
          >
            <RiTable2 size={13} />
          </ToolBtn>
        ) : (
          <>
            <ToolBtn onClick={() => editor.chain().focus().addRowBefore().run()} title="Add row above"><RiInsertRowTop size={13} /></ToolBtn>
            <ToolBtn onClick={() => editor.chain().focus().addRowAfter().run()} title="Add row below"><RiInsertRowBottom size={13} /></ToolBtn>
            <ToolBtn onClick={() => editor.chain().focus().addColumnBefore().run()} title="Add column left"><RiInsertColumnLeft size={13} /></ToolBtn>
            <ToolBtn onClick={() => editor.chain().focus().addColumnAfter().run()} title="Add column right"><RiInsertColumnRight size={13} /></ToolBtn>
            <ToolBtn onClick={() => editor.chain().focus().deleteRow().run()} title="Delete row"><RiDeleteRow size={13} /></ToolBtn>
            <ToolBtn onClick={() => editor.chain().focus().deleteColumn().run()} title="Delete column"><RiDeleteColumn size={13} /></ToolBtn>
            <ToolBtn onClick={() => editor.chain().focus().deleteTable().run()} title="Delete table"><RiTable2 size={13} /></ToolBtn>
          </>
        )}
        <div className="w-px h-4 bg-base-300/70 mx-1" />
        <ToolBtn onClick={() => editor.chain().focus().clearNodes().unsetAllMarks().run()} title="Clear formatting">
          <RiFormatClear size={13} />
        </ToolBtn>
        <input ref={fileInputRef} type="file" accept="image/*" className="hidden" onChange={uploadImage} />
      </div>

      {/* Editor area */}
      <EditorContent editor={editor} />

      <style>{`
        .tiptap p { margin: 0 0 4px; }
        .tiptap p:last-child { margin-bottom: 0; }
        .tiptap img { max-width: 100%; height: auto; display: inline-block; vertical-align: middle; }
        .tiptap img[width] { max-width: none; }
        .tiptap a { color: #5aa2ff; text-decoration: underline; }
        .tiptap ul { list-style: disc; padding-left: 1.25rem; }
        .tiptap ol { list-style: decimal; padding-left: 1.25rem; }
        .tiptap table { border-collapse: collapse; width: 100%; }
        .tiptap td, .tiptap th { outline: 1px dashed rgba(255,255,255,0.15); padding: 6px 8px; min-width: 40px; vertical-align: top; }
        .tiptap .selectedCell { background: rgba(90,162,255,0.12); }
        .tiptap [data-placeholder]::before {
          content: attr(data-placeholder);
          color: rgba(255,255,255,0.2);
          pointer-events: none;
          position: absolute;
          top: 8px; left: 12px;
        }
        .tiptap { position: relative; }
      `}</style>
    </div>
  );
}

function ToolBtn({ onClick, active, title, children }: { onClick: () => void; active?: boolean; title?: string; children: React.ReactNode }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      className={`flex items-center justify-center w-6 h-6 rounded transition-colors ${
        active ? "bg-primary/20 text-primary" : "text-base-content/50 hover:text-base-content hover:bg-base-300/60"
      }`}
    >
      {children}
    </button>
  );
}

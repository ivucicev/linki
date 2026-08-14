import { useEditor, EditorContent } from "@tiptap/react";
import StarterKit from "@tiptap/starter-kit";
import Image from "@tiptap/extension-image";
import Link from "@tiptap/extension-link";
import Underline from "@tiptap/extension-underline";
import { TextStyle } from "@tiptap/extension-text-style";
import { Color } from "@tiptap/extension-color";
import { useEffect, useRef } from "react";
import {
  RiBold, RiItalic, RiUnderline, RiLink, RiImageLine,
  RiListUnordered, RiListOrdered, RiFormatClear,
} from "react-icons/ri";

interface Props {
  value: string;
  onChange: (html: string) => void;
  placeholder?: string;
  className?: string;
}

export default function RichTextEditor({ value, onChange, placeholder, className }: Props) {
  const initialized = useRef(false);

  const editor = useEditor({
    extensions: [
      StarterKit,
      Underline,
      TextStyle,
      Color,
      Image.configure({ inline: true, allowBase64: true }),
      Link.configure({ openOnClick: false, HTMLAttributes: { rel: "noopener noreferrer" } }),
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

  // Sync external value changes (e.g. switching accounts)
  useEffect(() => {
    if (!editor) return;
    if (!initialized.current) { initialized.current = true; return; }
    if (editor.getHTML() !== value) {
      editor.commands.setContent(value, { emitUpdate: false });
    }
  }, [value, editor]);

  function addLink() {
    const url = window.prompt("URL");
    if (!url) return;
    editor?.chain().focus().setLink({ href: url }).run();
  }

  function addImage() {
    const url = window.prompt("Image URL (or paste a data: URI)");
    if (!url) return;
    editor?.chain().focus().setImage({ src: url }).run();
  }

  function uploadImage(e: React.ChangeEvent<HTMLInputElement>) {
    const file = e.target.files?.[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = () => {
      const src = reader.result as string;
      editor?.chain().focus().setImage({ src }).run();
    };
    reader.readAsDataURL(file);
    e.target.value = "";
  }

  const fileInputRef = useRef<HTMLInputElement>(null);

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
        <div className="w-px h-4 bg-base-300/70 mx-1" />
        <ToolBtn onClick={() => editor.chain().focus().toggleBulletList().run()} active={editor.isActive("bulletList")} title="Bullet list">
          <RiListUnordered size={13} />
        </ToolBtn>
        <ToolBtn onClick={() => editor.chain().focus().toggleOrderedList().run()} active={editor.isActive("orderedList")} title="Ordered list">
          <RiListOrdered size={13} />
        </ToolBtn>
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
        .tiptap img { max-width: 100%; display: inline-block; }
        .tiptap a { color: #5aa2ff; text-decoration: underline; }
        .tiptap ul { list-style: disc; padding-left: 1.25rem; }
        .tiptap ol { list-style: decimal; padding-left: 1.25rem; }
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

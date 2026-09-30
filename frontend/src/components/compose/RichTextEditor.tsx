import Placeholder from '@tiptap/extension-placeholder';
import TextAlign from '@tiptap/extension-text-align';
import Underline from '@tiptap/extension-underline';
import { EditorContent, useEditor, type Editor } from '@tiptap/react';
import StarterKit from '@tiptap/starter-kit';
import {
  AlignCenter,
  AlignLeft,
  AlignRight,
  Bold,
  Heading2,
  Indent,
  Italic,
  List,
  ListOrdered,
  Outdent,
  Quote,
  Redo2,
  Strikethrough,
  Underline as UnderlineIcon,
  Undo2,
} from 'lucide-react';
import type { ReactNode } from 'react';

function ToolButton({
  label,
  active,
  disabled,
  onClick,
  children,
}: {
  label: string;
  active?: boolean;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      aria-pressed={active}
      disabled={disabled}
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
      className={`inline-flex size-7 items-center justify-center rounded text-muted transition-colors hover:bg-white hover:text-ink disabled:opacity-40 ${
        active ? 'bg-white text-ink shadow-sm' : ''
      }`}
    >
      {children}
    </button>
  );
}

const Divider = () => <span className="mx-1 h-4 w-px bg-line" aria-hidden />;

function Toolbar({ editor }: { editor: Editor }) {
  const chain = () => editor.chain().focus();
  const icon = 'size-4';
  return (
    <div className="flex flex-wrap items-center gap-0.5 rounded-lg bg-[#f1f1f1] px-2 py-1" role="toolbar" aria-label="Formatting">
      <ToolButton label="Undo" disabled={!editor.can().undo()} onClick={() => chain().undo().run()}>
        <Undo2 className={icon} />
      </ToolButton>
      <ToolButton label="Redo" disabled={!editor.can().redo()} onClick={() => chain().redo().run()}>
        <Redo2 className={icon} />
      </ToolButton>
      <Divider />
      <ToolButton label="Heading" active={editor.isActive('heading', { level: 2 })} onClick={() => chain().toggleHeading({ level: 2 }).run()}>
        <Heading2 className={icon} />
      </ToolButton>
      <Divider />
      <ToolButton label="Bold" active={editor.isActive('bold')} onClick={() => chain().toggleBold().run()}>
        <Bold className={icon} />
      </ToolButton>
      <ToolButton label="Italic" active={editor.isActive('italic')} onClick={() => chain().toggleItalic().run()}>
        <Italic className={icon} />
      </ToolButton>
      <ToolButton label="Underline" active={editor.isActive('underline')} onClick={() => chain().toggleUnderline().run()}>
        <UnderlineIcon className={icon} />
      </ToolButton>
      <Divider />
      <ToolButton label="Align left" active={editor.isActive({ textAlign: 'left' })} onClick={() => chain().setTextAlign('left').run()}>
        <AlignLeft className={icon} />
      </ToolButton>
      <ToolButton label="Align center" active={editor.isActive({ textAlign: 'center' })} onClick={() => chain().setTextAlign('center').run()}>
        <AlignCenter className={icon} />
      </ToolButton>
      <ToolButton label="Align right" active={editor.isActive({ textAlign: 'right' })} onClick={() => chain().setTextAlign('right').run()}>
        <AlignRight className={icon} />
      </ToolButton>
      <Divider />
      <ToolButton label="Numbered list" active={editor.isActive('orderedList')} onClick={() => chain().toggleOrderedList().run()}>
        <ListOrdered className={icon} />
      </ToolButton>
      <ToolButton label="Bulleted list" active={editor.isActive('bulletList')} onClick={() => chain().toggleBulletList().run()}>
        <List className={icon} />
      </ToolButton>
      <ToolButton label="Indent" disabled={!editor.can().sinkListItem('listItem')} onClick={() => chain().sinkListItem('listItem').run()}>
        <Indent className={icon} />
      </ToolButton>
      <ToolButton label="Outdent" disabled={!editor.can().liftListItem('listItem')} onClick={() => chain().liftListItem('listItem').run()}>
        <Outdent className={icon} />
      </ToolButton>
      <ToolButton label="Quote" active={editor.isActive('blockquote')} onClick={() => chain().toggleBlockquote().run()}>
        <Quote className={icon} />
      </ToolButton>
      <Divider />
      <ToolButton label="Strikethrough" active={editor.isActive('strike')} onClick={() => chain().toggleStrike().run()}>
        <Strikethrough className={icon} />
      </ToolButton>
    </div>
  );
}

/** Figma composer: grey panel with "Type Your Reply…" placeholder and formatting toolbar. */
export function RichTextEditor({
  onChange,
  invalid,
}: {
  onChange: (html: string, isEmpty: boolean) => void;
  invalid?: boolean;
}) {
  const editor = useEditor({
    extensions: [
      StarterKit.configure({ heading: { levels: [2] }, codeBlock: false, code: false }),
      Underline,
      TextAlign.configure({ types: ['heading', 'paragraph'] }),
      Placeholder.configure({ placeholder: 'Type Your Reply...' }),
    ],
    editorProps: {
      attributes: { class: 'text-sm leading-relaxed text-ink', 'aria-label': 'Email body' },
    },
    onUpdate: ({ editor: e }) => onChange(e.getHTML(), e.isEmpty),
  });

  return (
    <div className={`rounded-xl bg-surface p-4 ring-1 ${invalid ? 'ring-red-300' : 'ring-transparent'}`}>
      {editor && (
        <>
          <Toolbar editor={editor} />
          <EditorContent editor={editor} className="mt-3 [&_.ProseMirror]:min-h-64" />
        </>
      )}
    </div>
  );
}

'use client'

// Lightweight MS-Word-style editor for wiki documents — contentEditable with
// a formatting toolbar (headings, bold/italic/underline/strike, lists, quote,
// code, links, undo/redo, clear formatting).
//
// UNCONTROLLED on purpose: the DOM owns the caret, so we never write incoming
// `value` back into the editor while typing (only when the value is replaced
// externally, e.g. opening a different document). Changes flow OUT through
// onChange on every input event.

import { useEffect, useRef, useState } from 'react'
import {
  Bold, Italic, Underline, Strikethrough, List, ListOrdered, Quote, Code,
  Link2, Undo2, Redo2, Eraser, Heading2, Heading3, Pilcrow, Unlink,
} from 'lucide-react'
import { cn } from '@/lib/utils'
import { Button } from '@/components/ui/button'

interface RichTextEditorProps {
  value: string
  onChange: (html: string) => void
  placeholder?: string
  className?: string
}

type Cmd =
  | { cmd: 'undo' } | { cmd: 'redo' }
  | { cmd: 'bold' } | { cmd: 'italic' } | { cmd: 'underline' } | { cmd: 'strikeThrough' }
  | { cmd: 'insertUnorderedList' } | { cmd: 'insertOrderedList' }
  | { cmd: 'formatBlock'; block: string }
  | { cmd: 'removeFormat' }
  | { cmd: 'code' }

export function RichTextEditor({ value, onChange, placeholder, className }: RichTextEditorProps) {
  const editorRef = useRef<HTMLDivElement>(null)
  const [linkOpen, setLinkOpen] = useState(false)
  const [linkUrl, setLinkUrl] = useState('')

  // Sync EXTERNAL value changes into the DOM only when they actually differ
  // (typing produces onInput updates; writing innerHTML on every keystroke
  // would reset the caret position).
  useEffect(() => {
    const el = editorRef.current
    if (el && el.innerHTML !== value) el.innerHTML = value
  }, [value])

  function exec(action: Cmd) {
    const el = editorRef.current
    if (!el) return
    el.focus()
    if (action.cmd === 'code') {
      document.execCommand('insertHTML', false, `<code>${document.getSelection()?.toString() ?? ''}</code>`)
    } else if (action.cmd === 'formatBlock') {
      document.execCommand('formatBlock', false, action.block)
    } else {
      document.execCommand(action.cmd, false)
    }
    onChange(el.innerHTML)
  }

  function insertLink() {
    const el = editorRef.current
    if (!el) return
    const url = linkUrl.trim()
    if (url) {
      const href = /^https?:\/\//i.test(url) || url.startsWith('/') || url.startsWith('#') ? url : `https://${url}`
      el.focus()
      document.execCommand('createLink', false, href)
      onChange(el.innerHTML)
    }
    setLinkUrl('')
    setLinkOpen(false)
  }

  function stripLinks() {
    const el = editorRef.current
    if (!el) return
    el.focus()
    document.execCommand('unlink', false)
    onChange(el.innerHTML)
  }

  return (
    <div className={cn('rounded-md border bg-background', className)}>
      {/* Toolbar */}
      <div className="flex flex-wrap items-center gap-0.5 border-b bg-muted/40 p-1.5 rounded-t-md">
        <EditorButton label="Undo (Ctrl+Z)" onClick={() => exec({ cmd: 'undo' })}><Undo2 className="h-4 w-4" /></EditorButton>
        <EditorButton label="Redo (Ctrl+Y)" onClick={() => exec({ cmd: 'redo' })}><Redo2 className="h-4 w-4" /></EditorButton>
        <Divider />
        <EditorButton label="Paragraph" onClick={() => exec({ cmd: 'formatBlock', block: 'P' })}><Pilcrow className="h-4 w-4" /></EditorButton>
        <EditorButton label="Heading 2" onClick={() => exec({ cmd: 'formatBlock', block: 'H2' })}><Heading2 className="h-4 w-4" /></EditorButton>
        <EditorButton label="Heading 3" onClick={() => exec({ cmd: 'formatBlock', block: 'H3' })}><Heading3 className="h-4 w-4" /></EditorButton>
        <Divider />
        <EditorButton label="Bold (Ctrl+B)" onClick={() => exec({ cmd: 'bold' })}><Bold className="h-4 w-4" /></EditorButton>
        <EditorButton label="Italic (Ctrl+I)" onClick={() => exec({ cmd: 'italic' })}><Italic className="h-4 w-4" /></EditorButton>
        <EditorButton label="Underline (Ctrl+U)" onClick={() => exec({ cmd: 'underline' })}><Underline className="h-4 w-4" /></EditorButton>
        <EditorButton label="Strikethrough" onClick={() => exec({ cmd: 'strikeThrough' })}><Strikethrough className="h-4 w-4" /></EditorButton>
        <Divider />
        <EditorButton label="Bullet list" onClick={() => exec({ cmd: 'insertUnorderedList' })}><List className="h-4 w-4" /></EditorButton>
        <EditorButton label="Numbered list" onClick={() => exec({ cmd: 'insertOrderedList' })}><ListOrdered className="h-4 w-4" /></EditorButton>
        <EditorButton label="Quote" onClick={() => exec({ cmd: 'formatBlock', block: 'BLOCKQUOTE' })}><Quote className="h-4 w-4" /></EditorButton>
        <EditorButton label="Inline code" onClick={() => exec({ cmd: 'code' })}><Code className="h-4 w-4" /></EditorButton>
        <Divider />
        <EditorButton label="Insert link" onClick={() => setLinkOpen((v) => !v)}><Link2 className="h-4 w-4" /></EditorButton>
        <EditorButton label="Remove link" onClick={stripLinks}><Unlink className="h-4 w-4" /></EditorButton>
        <EditorButton label="Clear formatting" onClick={() => exec({ cmd: 'removeFormat' })}><Eraser className="h-4 w-4" /></EditorButton>
      </div>

      {/* Link popover */}
      {linkOpen && (
        <div className="flex items-center gap-2 border-b bg-muted/20 px-2.5 py-2">
          <Link2 className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <input
            autoFocus
            value={linkUrl}
            onChange={(e) => setLinkUrl(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') { e.preventDefault(); insertLink() }
              if (e.key === 'Escape') { setLinkOpen(false); setLinkUrl('') }
            }}
            placeholder="https://example.com/docs — press Enter"
            className="h-7 w-full max-w-sm rounded-md border bg-background px-2 text-sm outline-none focus:ring-2 focus:ring-ring/40"
          />
          <Button type="button" size="sm" className="h-7" onClick={insertLink}>Apply</Button>
          <Button type="button" size="sm" variant="ghost" className="h-7" onClick={() => { setLinkOpen(false); setLinkUrl('') }}>Cancel</Button>
        </div>
      )}

      {/* Editing surface */}
      <div
        ref={editorRef}
        contentEditable
        suppressContentEditableWarning
        role="textbox"
        aria-multiline="true"
        aria-label="Document content"
        data-placeholder={placeholder}
        onInput={(e) => onChange((e.target as HTMLDivElement).innerHTML)}
        onBlur={(e) => onChange((e.target as HTMLDivElement).innerHTML)}
        className={cn(
          'prose-sm min-h-[16rem] max-h-[28rem] w-full overflow-y-auto rounded-b-md px-3.5 py-3',
          'text-sm leading-relaxed outline-none [&:empty]:before:content-[attr(data-placeholder)]',
          '[&:empty]:before:text-muted-foreground',
          '[&_h2]:mt-3 [&_h2]:mb-1.5 [&_h2]:text-lg [&_h2]:font-semibold',
          '[&_h3]:mt-2.5 [&_h3]:mb-1 [&_h3]:text-base [&_h3]:font-semibold',
          '[&_p]:my-1 [&_blockquote]:border-l-2 [&_blockquote]:border-muted-foreground/40 [&_blockquote]:pl-3 [&_blockquote]:italic [&_blockquote]:text-muted-foreground',
          '[&_ul]:list-disc [&_ul]:pl-5 [&_ol]:list-decimal [&_ol]:pl-5 [&_li]:my-0.5',
          '[&_code]:rounded [&_code]:bg-muted [&_code]:px-1 [&_code]:py-0.5 [&_code]:font-mono [&_code]:text-[0.8em]',
          '[&_a]:text-primary [&_a]:underline [&_a]:underline-offset-2'
        )}
      />
    </div>
  )
}

function EditorButton({ label, onClick, children }: { label: string; onClick: () => void; children: React.ReactNode }) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="icon"
      className="h-7 w-7 text-muted-foreground hover:text-foreground"
      title={label}
      aria-label={label}
      // onMouseDown keeps the text selection alive while clicking the toolbar
      // (a click would otherwise collapse it before execCommand runs).
      onMouseDown={(e) => e.preventDefault()}
      onClick={onClick}
    >
      {children}
    </Button>
  )
}

function Divider() {
  return <div className="mx-1 h-5 w-px bg-border" aria-hidden />
}

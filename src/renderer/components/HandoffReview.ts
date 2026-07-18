export interface HandoffReviewProps {
  /** Number of pending review sections queued for this session (0 → not shown). */
  count: number
  totalChars: number
  /** The session is in fix mode → auto-executes on submit, so warn first (S6/C-14). */
  inFix: boolean
  /** Bracket-paste the pending review material into this session's pty. Never
   *  auto-submitted — the user still presses Enter themselves. */
  onInsert: () => void
  /** Discard the pending review material without inserting. */
  onDismiss?: () => void
}

/** The "Review & insert" affordance for handoff/linear review material (R6-4).
 *  Review text is NEVER auto-submitted: it lands here and is bracket-pasted (no
 *  trailing newline) only when the user clicks Insert. When the target session is
 *  in FIX mode a warning banner is shown FIRST, because a fix-mode engine executes
 *  on submit. Returns null when there is nothing pending. */
export function HandoffReview(p: HandoffReviewProps): HTMLElement | null {
  if (p.count <= 0) return null
  const el = document.createElement('div')
  el.className = 'handoff-review' + (p.inFix ? ' fix' : '')

  if (p.inFix) {
    const warn = document.createElement('div')
    warn.className = 'hr-warn'
    warn.textContent =
      '⚠ This session is in FIX mode — it may act on submitted text. Review the pasted material carefully before pressing Enter.'
    el.appendChild(warn)
  }

  const row = document.createElement('div')
  row.className = 'hr-row'
  const label = document.createElement('span')
  label.className = 'hr-label'
  const chars = p.totalChars
  label.textContent = `Pending review: ${p.count} section${p.count === 1 ? '' : 's'} (${chars} chars) — never auto-submitted`
  row.appendChild(label)

  const insert = document.createElement('button')
  insert.className = 'primary hr-insert'
  insert.textContent = 'Review & insert'
  insert.title = 'Bracket-paste the material into this session (no trailing newline; you press Enter)'
  insert.onclick = () => p.onInsert()
  row.appendChild(insert)

  if (p.onDismiss) {
    const dismiss = document.createElement('button')
    dismiss.className = 'hr-dismiss'
    dismiss.textContent = 'Dismiss'
    dismiss.onclick = () => p.onDismiss!()
    row.appendChild(dismiss)
  }

  el.appendChild(row)
  return el
}

import { SERVICES, type ServiceName, type ServiceStatus } from '@shared/types'

const LABEL: Record<ServiceName, string> = {
  vercel: 'Vercel',
  supabase: 'Supabase',
  github: 'GitHub',
  resend: 'Resend'
}

/** Short status text + dot class per state. */
function statusText(s: ServiceStatus | undefined): string {
  switch (s) {
    case 'online':
      return 'online'
    case 'not-logged-in':
      return 'offline'
    case 'not-installed':
      return 'not installed'
    case 'unknown':
      return '?'
    default:
      return 'checking…'
  }
}

export interface StatusBarProps {
  /** Current per-service status (undefined entry = still probing). */
  status: Partial<Record<ServiceName, ServiceStatus>>
  /** Whether a probe is in flight (shows a subtle "checking" affordance). */
  checking?: boolean
  /** Click an ONLINE/unknown chip → re-check just that service. */
  onRecheck: (service: ServiceName) => void
  /** Click an OFFLINE/not-installed chip → open a login terminal for it. */
  onConnect: (service: ServiceName) => void
}

/** Bottom status bar: a chip per external service showing connectivity. Clicking
 *  an online chip re-checks it; clicking an offline one opens its login terminal. */
export function StatusBar(p: StatusBarProps): HTMLElement {
  const bar = document.createElement('div')
  bar.className = 'statusbar'

  const label = document.createElement('span')
  label.className = 'sb-label'
  label.textContent = 'Services'
  bar.appendChild(label)

  for (const service of SERVICES) {
    const st = p.status[service]
    const chip = document.createElement('span')
    chip.className = 'sb-chip ' + (st ?? 'checking')
    chip.title =
      st === 'online'
        ? `${LABEL[service]} connected — click to re-check`
        : st === undefined
          ? `Checking ${LABEL[service]}…`
          : `${LABEL[service]} ${statusText(st)} — click to connect`

    const dot = document.createElement('span')
    dot.className = 'sb-dot'
    const name = document.createElement('span')
    name.className = 'sb-name'
    name.textContent = LABEL[service]
    const state = document.createElement('span')
    state.className = 'sb-state'
    state.textContent = statusText(st)
    chip.append(dot, name, state)

    chip.onclick = () => {
      if (st === 'online') p.onRecheck(service)
      else p.onConnect(service) // offline / not-installed / unknown → try to connect
    }
    bar.appendChild(chip)
  }

  return bar
}

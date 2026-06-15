// @vitest-environment jsdom
import { describe, it, expect } from 'vitest'
import { showMenu, promptText } from '../../src/renderer/ui'

describe('showMenu', () => {
  it('renders items and fires onClick', () => {
    let clicked = ''
    showMenu(10, 10, [
      { label: 'Rename', onClick: () => { clicked = 'rename' } },
      { label: 'Delete', danger: true, onClick: () => { clicked = 'delete' } }
    ])
    const menu = document.getElementById('app-menu')!
    expect(menu).toBeTruthy()
    const items = menu.querySelectorAll('.ctx-item')
    expect(items.length).toBe(2)
    expect(items[1].classList.contains('danger')).toBe(true)
    ;(items[0] as HTMLElement).click()
    expect(clicked).toBe('rename')
    // menu closes after click
    expect(document.getElementById('app-menu')).toBeNull()
  })
})

describe('promptText', () => {
  it('resolves with the entered value on OK', async () => {
    const p = promptText('Name it', 'placeholder')
    const input = document.querySelector('.prompt-input') as HTMLInputElement
    input.value = 'my session'
    ;(document.querySelector('.modal .foot button.primary') as HTMLButtonElement).click()
    expect(await p).toBe('my session')
  })

  it('resolves null on Cancel', async () => {
    const p = promptText('Name it')
    const buttons = document.querySelectorAll('.modal .foot button')
    ;(buttons[0] as HTMLButtonElement).click() // Cancel
    expect(await p).toBeNull()
  })
})

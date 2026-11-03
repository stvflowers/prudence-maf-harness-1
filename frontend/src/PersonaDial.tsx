import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import type { CSSProperties, KeyboardEvent } from 'react'
import { personas } from './personas'
import type { PersonaId } from './personas'

export function PersonaSymbol({ id }: { id: PersonaId }) {
  if (id === 'default') return <img src="/prudence-icon.svg" alt="" aria-hidden="true" />
  return (
    <svg viewBox="0 0 24 24" aria-hidden="true">
      <path d={personas.find((persona) => persona.id === id)?.symbol} />
    </svg>
  )
}

const choices = [{ id: 'default', name: 'Prudence default' }, ...personas] as const

export function PersonaDial({ value, onChange, prominent = false }: {
  value: PersonaId
  onChange: (value: PersonaId) => void
  prominent?: boolean
}) {
  const menuId = useId()
  const triggerRef = useRef<HTMLButtonElement>(null)
  const menuRef = useRef<HTMLDivElement>(null)
  const [position, setPosition] = useState<{ left: number; top: number } | null>(null)
  const [active, setActive] = useState(0)
  const open = position !== null
  const name = choices.find((choice) => choice.id === value)?.name

  function close(restoreFocus = true) {
    setPosition(null)
    if (restoreFocus) triggerRef.current?.focus()
  }

  function show() {
    const bounds = triggerRef.current?.getBoundingClientRect()
    if (!bounds) return
    const size = 280
    const centerX = prominent ? bounds.x + bounds.width / 2 : bounds.right + size / 2 + 12
    const centerY = prominent ? bounds.y + bounds.height / 2 : bounds.y + size / 2
    setActive(choices.findIndex((choice) => choice.id === value))
    setPosition({
      left: Math.max(8, Math.min(window.innerWidth - size - 8, centerX - size / 2)),
      top: Math.max(8, Math.min(window.innerHeight - size - 8, centerY - size / 2)),
    })
  }

  useLayoutEffect(() => {
    if (open) menuRef.current?.querySelector<HTMLButtonElement>(`[data-index="${active}"]`)?.focus({ preventScroll: true })
  }, [open, active])

  useEffect(() => {
    if (!open) return
    const dismiss = (event: PointerEvent) => {
      if (event.target instanceof Node && !menuRef.current?.contains(event.target) && !triggerRef.current?.contains(event.target)) setPosition(null)
    }
    const reposition = () => setPosition(null)
    document.addEventListener('pointerdown', dismiss)
    window.addEventListener('resize', reposition)
    return () => {
      document.removeEventListener('pointerdown', dismiss)
      window.removeEventListener('resize', reposition)
    }
  }, [open])

  function navigate(event: KeyboardEvent<HTMLDivElement>) {
    event.stopPropagation()
    if (event.key === 'Escape') {
      event.preventDefault()
      close()
    } else if (event.key === 'Tab') {
      close()
    } else if (['ArrowRight', 'ArrowDown', 'ArrowLeft', 'ArrowUp', 'Home', 'End'].includes(event.key)) {
      event.preventDefault()
      const forward = event.key === 'ArrowRight' || event.key === 'ArrowDown'
      setActive(event.key === 'Home' ? 0 : event.key === 'End' ? choices.length - 1 : (active + (forward ? 1 : -1) + choices.length) % choices.length)
    }
  }

  return (
    <>
      <button
        ref={triggerRef}
        type="button"
        className={`persona-trigger ${prominent ? 'persona-prominent' : 'brand-mark'}`}
        aria-label={`Choose persona: ${name}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        title={`Choose persona: ${name}`}
        onClick={() => open ? close() : show()}
        onKeyDown={(event) => {
          if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
            event.preventDefault()
            show()
          }
        }}
      >
        <PersonaSymbol id={value} />
      </button>
      {position && createPortal(
        <div
          id={menuId}
          ref={menuRef}
          className="persona-dial"
          role="menu"
          aria-label="Choose persona"
          style={position}
          onKeyDown={navigate}
          onBlur={(event) => {
            if (event.relatedTarget instanceof Node && !event.currentTarget.contains(event.relatedTarget)) setPosition(null)
          }}
        >
          {choices.map((choice, index) => {
            const angle = (index - 1) * 2 * Math.PI / personas.length - Math.PI / 2
            const style: CSSProperties = {
              left: `calc(50% + ${index === 0 ? 0 : Math.cos(angle) * 100}px)`,
              top: `calc(50% + ${index === 0 ? 0 : Math.sin(angle) * 100}px)`,
            }
            return (
              <button
                key={choice.id}
                type="button"
                role="menuitemradio"
                aria-checked={value === choice.id}
                aria-label={choice.name}
                title={choice.name}
                className={`persona-option${index === 0 ? ' persona-default' : ''}`}
                style={style}
                tabIndex={active === index ? 0 : -1}
                data-index={index}
                onFocus={() => setActive(index)}
                onClick={() => {
                  onChange(choice.id)
                  close()
                }}
              >
                <PersonaSymbol id={choice.id} />
              </button>
            )
          })}
        </div>,
        document.body,
      )}
    </>
  )
}

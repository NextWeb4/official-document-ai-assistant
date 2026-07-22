/*
 * This file is part of the Official Document AI Assistant.
 * (c) 2026 Jose AI (https://www.linhut.cn)
 * Licensed under the MIT License. See the LICENSE file for details.
 */
import * as React from "react"
import { cn } from "@/lib/utils"

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled]):not([type="hidden"])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',')

interface DialogContextValue {
  setContentElement: (node: HTMLDivElement | null) => void
  titleId: string
}

const DialogContext = React.createContext<DialogContextValue | null>(null)

function getFocusableElements(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR))
    .filter(element => element.tabIndex >= 0 && element.getAttribute('aria-hidden') !== 'true')
}

interface DialogProps {
  open?: boolean
  onOpenChange?: (open: boolean) => void
  children: React.ReactNode
}

function Dialog({ open, onOpenChange, children }: DialogProps) {
  const contentRef = React.useRef<HTMLDivElement>(null)
  const previouslyFocusedRef = React.useRef<HTMLElement | null>(null)
  const onOpenChangeRef = React.useRef(onOpenChange)
  const titleId = React.useId()
  const setContentElement = React.useCallback((node: HTMLDivElement | null) => {
    contentRef.current = node
  }, [])
  const contextValue = React.useMemo(
    () => ({ setContentElement, titleId }),
    [setContentElement, titleId],
  )

  React.useEffect(() => {
    onOpenChangeRef.current = onOpenChange
  }, [onOpenChange])

  React.useEffect(() => {
    if (!open) return

    previouslyFocusedRef.current = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null

    const focusFrame = window.requestAnimationFrame(() => {
      const content = contentRef.current
      if (!content) return
      const firstFocusable = getFocusableElements(content)[0]
      ;(firstFocusable ?? content).focus()
    })

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onOpenChangeRef.current?.(false)
        return
      }

      if (event.key !== 'Tab') return
      const content = contentRef.current
      if (!content) return
      const focusable = getFocusableElements(content)
      if (focusable.length === 0) {
        event.preventDefault()
        content.focus()
        return
      }

      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      const active = document.activeElement
      if (event.shiftKey && (active === first || !content.contains(active))) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && (active === last || !content.contains(active))) {
        event.preventDefault()
        first.focus()
      }
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => {
      window.cancelAnimationFrame(focusFrame)
      document.removeEventListener('keydown', handleKeyDown)
      const previous = previouslyFocusedRef.current
      if (previous?.isConnected) previous.focus()
    }
  }, [open])

  if (!open) return null
  return (
    <DialogContext.Provider value={contextValue}>
      <div className="fixed inset-0 z-50 flex items-center justify-center">
        <div
          aria-hidden="true"
          className="fixed inset-0 bg-black/80"
          onClick={() => onOpenChangeRef.current?.(false)}
        />
        <div className="relative z-50">{children}</div>
      </div>
    </DialogContext.Provider>
  )
}

const DialogContent = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, children, role = 'dialog', tabIndex = -1, ...props }, forwardedRef) => {
    const context = React.useContext(DialogContext)
    const setRef = React.useCallback((node: HTMLDivElement | null) => {
      context?.setContentElement(node)
      if (typeof forwardedRef === 'function') forwardedRef(node)
      else if (forwardedRef) forwardedRef.current = node
    }, [context, forwardedRef])

    return (
      <div
        ref={setRef}
        role={role}
        aria-modal="true"
        aria-labelledby={props['aria-label'] ? undefined : (props['aria-labelledby'] ?? context?.titleId)}
        tabIndex={tabIndex}
        className={cn("fixed left-[50%] top-[50%] z-50 grid w-full max-w-lg translate-x-[-50%] translate-y-[-50%] gap-4 border bg-background p-6 shadow-lg sm:rounded-lg", className)}
        {...props}
      >
        {children}
      </div>
    )
  }
)
DialogContent.displayName = "DialogContent"

const DialogHeader = ({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) => (
  <div className={cn("flex flex-col space-y-1.5 text-center sm:text-left", className)} {...props} />
)

const DialogTitle = React.forwardRef<HTMLHeadingElement, React.HTMLAttributes<HTMLHeadingElement>>(
  ({ className, id, ...props }, ref) => {
    const context = React.useContext(DialogContext)
    return <h2 ref={ref} id={id ?? context?.titleId} className={cn("text-lg font-semibold leading-none tracking-tight", className)} {...props} />
  }
)
DialogTitle.displayName = "DialogTitle"

export { Dialog, DialogContent, DialogHeader, DialogTitle }

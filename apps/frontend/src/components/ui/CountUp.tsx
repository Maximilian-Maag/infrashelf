'use client'

import { useEffect, useRef, useState } from 'react'

interface Props {
  value: number
  duration?: number
}

export function CountUp({ value, duration = 800 }: Props) {
  const [display, setDisplay] = useState(0)
  const [target, setTarget] = useState(value)
  const rafRef = useRef<number | null>(null)

  /*
   * A new target counts up from zero again — decided during render, not in the
   * effect (#450).
   *
   * The zero case is why this used to call `setDisplay` in the effect body: a
   * counter of 0 has nothing to animate, so it was set straight away. Resetting
   * here covers it without a second render pass, and the effect below simply has
   * nothing to do.
   */
  if (target !== value) {
    setTarget(value)
    setDisplay(0)
  }

  useEffect(() => {
    if (rafRef.current) cancelAnimationFrame(rafRef.current)
    // Already showing 0, which is the whole of the animation for a zero.
    if (value === 0) return
    const start = performance.now()

    function tick(now: number) {
      const progress = Math.min((now - start) / duration, 1)
      const eased = 1 - Math.pow(1 - progress, 3)
      setDisplay(Math.round(eased * value))
      if (progress < 1) rafRef.current = requestAnimationFrame(tick)
    }

    rafRef.current = requestAnimationFrame(tick)
    return () => { if (rafRef.current) cancelAnimationFrame(rafRef.current) }
  }, [value, duration])

  return <>{display}</>
}

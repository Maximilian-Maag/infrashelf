import '@testing-library/jest-dom'
import { configure } from '@testing-library/react'
import { expect } from 'vitest'
import * as axeMatchers from 'vitest-axe/matchers'

// `toHaveNoViolations`, so the component-level axe checks read the same in every
// test file (issue #102). Registered explicitly rather than via
// `vitest-axe/extend-expect`, whose built entry point is empty in 0.1.0.
expect.extend(axeMatchers)

/*
 * RTL's own wait ceiling, raised for the whole suite (#584).
 *
 * The default is 1 s. That is fine for a single file and not for a run of 138 in
 * parallel: a `findBy*` or `waitFor` that follows a form interaction can exceed a
 * second under that load, and the failure then reads as "the element never
 * rendered" — a claim about the component, made about the machine. Five seconds is
 * still a ceiling: a component that genuinely never renders is reported, just five
 * seconds later. Paired with the per-test budget in `vitest.config.ts`.
 */
configure({ asyncUtilTimeout: 5000 })

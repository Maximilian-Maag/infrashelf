import '@testing-library/jest-dom'
import { expect } from 'vitest'
import { configure } from '@testing-library/react'
import * as axeMatchers from 'vitest-axe/matchers'

// `toHaveNoViolations`, so the component-level axe checks read the same in every
// test file (issue #102). Registered explicitly rather than via
// `vitest-axe/extend-expect`, whose built entry point is empty in 0.1.0.
expect.extend(axeMatchers)

// RTL's own default budget for `waitFor`/`findBy` is 1000ms, which is the other
// half of the #584 flake: under the full parallel run a React state update can
// take longer than a fast machine's second to land, and the query then fails a
// test that is not wrong. 5s — a real hang still fails, just not spuriously.
configure({ asyncUtilTimeout: 5000 })

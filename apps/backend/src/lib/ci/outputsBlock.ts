/**
 * Where a Terraform outputs block begins, in a log line.
 *
 * One definition for two callers, and deliberately its own module rather than an
 * export of `lib/ci`:
 *
 * - `parseTofuOutputs` (lib/ci) uses it to find the block it parses;
 * - `outputsBlocksIn` (lib/webhook/outputs) uses it to cut one element's Loki
 *   stream into one trace per block.
 *
 * The two disagreeing is the failure that looks like "this deployment declared no
 * outputs" — the same confusion #216 was, when GitLab's timestamp prefix stopped
 * the header from matching. And it has to survive a test that mocks `@/lib/ci`
 * wholesale (several do, to stub the CI client): a `lib/ci` export would be
 * replaced by whatever the mock factory listed, leaving the splitter comparing
 * against `undefined`.
 */
export const OUTPUTS_BLOCK_HEADER = /^Outputs:/

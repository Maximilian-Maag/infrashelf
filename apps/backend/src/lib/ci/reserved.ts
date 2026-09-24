import { ELEMENT_SEQUENCE_VAR, STATE_KEY_NAMESPACE_VAR } from './stateKey'

/**
 * The trigger variable carrying the element id.
 *
 * The provisioning trigger names the ORDER; this names which of its elements the
 * run is for, which is the only identity a pipeline has for the row its outputs
 * are recorded against. Teardown has always sent it (`destroyVariables`), and the
 * provisioning and retry paths send it since #111: without it a pipeline cannot
 * label its log stream with `element_id`, which is how the portal reads an
 * element's apply log out of Loki — and under quantity (#104) an order's elements
 * share one order id, so ORDER_ID cannot stand in for it.
 */
export const ELEMENT_ID_VAR = 'INFRA_ID'

/**
 * The CI trigger variables the server decides, and which a catalogue parameter
 * may therefore never be named after (issue #183).
 *
 * Its own module for the reason `lib/ci/stateKey` is: the admin service that
 * validates parameter NAMES and the services that build trigger VARIABLES both
 * need it, and `lib/ci/webhooks` is mocked wholesale in the service tests.
 *
 * This is a security boundary, not a naming convention. `triggerGitLabPipeline`
 * passes `variables['REF']` as the git ref the pipeline runs on, and the
 * orchestrator reads TF_ACTION to choose apply from destroy — so a parameter
 * DEFINITION carrying either name handed the ordering user a decision the server
 * is supposed to own: arbitrary ref execution with the environment's trigger
 * token, or a provisioning order that destroys instead. `validateAndApply-
 * Parameters` drops submitted keys that have no definition, which stops a
 * hand-written POST but says nothing about a definition that exists — and
 * `sync-parameters` creates definitions from a Terraform file, so no one has to
 * type the name for one to appear.
 */
const RESERVED_CI_VARIABLES: ReadonlySet<string> = new Set([
  // Which git ref/workflow the pipeline runs — the trigger layer reads these
  // before it copies anything else into the request (lib/ci/gitlab.ts,
  // lib/ci/index.ts). Whoever sets them chooses the code that runs.
  'REF',
  'BRANCH',
  'WORKFLOW',
  // What the run does and to which Terraform state.
  'TF_ACTION',
  'TF_STATE_NAME',
  STATE_KEY_NAMESPACE_VAR,
  // WHOSE state, which is the same class of decision as which state. GitLab
  // lets a trigger variable override a project CI/CD variable, so a parameter
  // under either of these names replaces the credential the state API
  // authenticates with — and a token the orderer chose reads and writes state
  // the operator never granted. Reserved for the same reason TF_STATE_NAME is.
  'GITLAB_STATE_TOKEN',
  'GITLAB_STATE_USERNAME',
  // Which orchestrator template and step list execute.
  'TEMPLATE',
  'PIPELINE_STACK',
  // Server-generated identity. Overwriting these misattributes a run, and
  // ORDER_ID and ELEMENT_SEQUENCE both feed the state key.
  'ORDER_ID',
  ELEMENT_SEQUENCE_VAR,
  ELEMENT_ID_VAR,
  // Whether the run is a time-boxed trial. Duplicated from lib/services/trial so
  // this module stays free of the db-backed service layer; reserved.test.ts
  // asserts the two agree.
  'TRIAL',
  'TRIAL_DURATION_MINUTES',
])

// SIZE is deliberately NOT here, though the server sets it. It decides neither
// what code runs nor which state it runs against, the trigger tail already
// overrides it for an offering that HAS sizes, and it is an ordinary enough name
// that products offered without sizes use it as a plain parameter. Reserving it
// would take that away to close nothing.

/**
 * Matched case-insensitively, which is stricter than today's exploit needs: the
 * variable map is keyed exactly, so a parameter named `ref` never reaches
 * `variables['REF']`. It is the import path that makes the loose match worth its
 * cost — `sync-parameters` turns Terraform variables into parameters, Terraform
 * variables are lowercase by convention, and a template that grew an upper-casing
 * step anywhere between the portal and the runner would re-open the hole silently.
 * The price is that a lowercase `template` or `ref` in a template's variables.tf
 * is refused a parameter; both name a value the server already supplies.
 */
export const isReservedCiVariable = (name: string): boolean =>
  RESERVED_CI_VARIABLES.has(name.trim().toUpperCase())

/**
 * The customer-supplied half of a trigger variable map, with every server-owned
 * name removed.
 *
 * Used at every point where stored parameters are spread into trigger variables,
 * because rejecting new definitions cannot help the rows that already exist:
 * a deployment may hold a parameter named REF, and every order placed against it
 * persisted that value into `orders.parameters` and `infrastructure_elements
 * .parameters`. Those rows still provision (on approval), retry and destroy.
 */
export const withoutReservedCiVariables = (
  parameters: Record<string, string>,
): Record<string, string> =>
  Object.fromEntries(Object.entries(parameters).filter(([name]) => !isReservedCiVariable(name)))

/**
 * Variables the pipeline supplies to itself. Not things a person chooses, and a
 * parameter definition for one would be a field the run overwrites.
 *
 * Here rather than in `templateImport`, because it was in BOTH that file and
 * `sync-parameters/route.ts` — two copies of one list, and the two import paths
 * that turn a Terraform file into parameter definitions. A name added to one
 * copy is a name the other still offers.
 *
 * Exact-match and lowercase, unlike `RESERVED_CI_VARIABLES` above: these are
 * Terraform variable names as a template declares them, and the case-insensitive
 * set is a security boundary that answers a different question. Both are
 * consulted at the import path, so a name may safely be in one, the other or
 * both — `gitlab_state_token` is in both, because it must neither be offered as
 * a parameter nor accepted as one.
 */
const PIPELINE_SUPPLIED_VARIABLES: ReadonlySet<string> = new Set([
  'ci_api_url',
  'ci_project_id',
  'ci_job_token',
  'vm_state_name',
  // The credentials for the GitLab-managed OpenTofu state API, promoted to
  // TF_VARs by the base pipeline so a template that reads an upstream step's
  // state with `terraform_remote_state` can declare them and nothing else.
  'gitlab_state_token',
  'gitlab_state_username',
])

/** Whether the base pipeline supplies this Terraform variable itself. */
export const isPipelineSuppliedVariable = (name: string): boolean =>
  PIPELINE_SUPPLIED_VARIABLES.has(name.trim())

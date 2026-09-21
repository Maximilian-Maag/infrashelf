workspace "InfraShelf" "Self-service portal for ordering, managing and decommissioning IT infrastructure. Next.js frontend + REST API backend, PostgreSQL." {

    model {
        admin = person "Admin" "Views all orders and infrastructure, orders directly, approves or rejects project manager orders." "Person"
        root = person "Root" "Manages catalog, system config and users via a local account." "Person"
        project_manager = person "Project Manager" "Places orders (Admin approval required), manages own projects and infrastructure." "Person"

        gitlab = softwaresystem "GitLab" "CI provider executing OpenTofu workflows; pushes pipeline events back via webhook. The only provider job traces are fetched from, so the only one OpenTofu outputs are parsed from." "Existing System"
        github = softwaresystem "GitHub" "CI provider: triggers workflow_dispatch runs, browses repos/branches/files. Pushes workflow-run status back via webhook. No job-trace fetch (see gitlab), so orders provisioned here get no parsed OpenTofu outputs." "Existing System"
        bitbucket = softwaresystem "Bitbucket" "CI provider: triggers pipelines, browses repos/branches/files. Pushes pipeline status back via webhook. No job-trace fetch (see gitlab), so orders provisioned here get no parsed OpenTofu outputs." "Existing System"
        oidc_provider = softwaresystem "Microsoft Entra ID" "PLANNED SSO identity provider (OIDC). Not implemented: the half-built callback handler was removed in #139 because no route started the flow, nothing consumed its result, and it returned the session JWT in a query string. Everything below that touches this system is the intended design, not the shipped one." "Existing System"
        ai_translation = softwaresystem "AI Translation Service" "Optional AI provider for product content translation; supports cloud and on-premise models." "Existing System"
        smtp = softwaresystem "Mail Server" "SMTP server for transactional order and deployment notification emails." "Existing System"
        exchange_rate_api = softwaresystem "Exchange Rate API" "Provides current exchange rates for per-locale currency conversion." "Existing System"

        webshop = softwaresystem "InfraShelf" "Self-service portal for ordering, managing and decommissioning IT infrastructure." {

            frontend = container "Frontend" "React UI; server-side rendered with NextAuth.js sessions, communicates with Backend API via REST." "Next.js / React / Tailwind CSS / NextAuth.js" {

                ui_proxy = component "API Proxy" "The browser's ONLY route to the backend (#146). A Next.js route handler that reads the backend JWT from the server-side NextAuth session and attaches it as an Authorization header. The token is never handed to the browser — before #146 it was."
                ui_auth = component "Auth Pages" "Login with local credentials. The backend JWT it receives is kept in the server-side NextAuth session, not in a cookie the browser can read (#146). SSO is planned, not shipped (#139)."
                ui_catalog = component "Catalog" "Filtered product grid with locale currency prices; environment and parameter selection for ordering."
                ui_orders = component "Orders" "Order form with dynamic parameters, project/cost-centre assignment and live status polling."
                ui_approvals = component "Approvals" "Pending order queue for admins with inline approve/reject actions."
                ui_infrastructure = component "Infrastructure" "Infrastructure items grouped by project/environment; shows outputs, retry for a failed deployment, and both immediate and scheduled decommissioning."
                ui_audit = component "Audit Log" "Filterable compliance log with CSV/PDF export."
                ui_admin = component "Administration" "Manages catalog entities, environments, CI sources, users, branding and system config."
                ui_settings = component "Settings" "Profile and password, plus second-factor enrolment (TOTP), passkeys (WebAuthn) and the active-session list."
                ui_cart = component "Cart" "Collects catalogue lines before checkout; checkout needs a project and turns the cart into orders."
                ui_projects = component "Projects" "Projects and their members, which are what scope a project manager's view of orders and infrastructure."
            }

            backend = container "Backend API" "RESTful API; thin route handlers delegate to a typed service layer; Zod-validated inputs; Result<T> error handling; OpenAPI docs at /api/docs." "Next.js / TypeScript / Drizzle ORM / Zod / JWT" {

                api_auth = component "Auth Routes" "Thin HTTP shell: parse credentials or OIDC callback, call auth service, return signed JWT."
                api_catalog = component "Catalog Routes" "Thin HTTP shell: parse language/filter params, call catalog service."
                api_orders = component "Order Routes" "Thin HTTP shell: validate body, call orders or approvals service."
                api_infrastructure = component "Infrastructure Routes" "Thin HTTP shell: call infrastructure service for list and decommission."
                api_admin = component "Admin Routes" "Thin HTTP shells for catalog, environments, CI sources, users and config — each delegates to its service."
                api_webhook = component "CI Webhook Receiver" "Verifies inbound events against each deployment_environments.callback_secret — X-Gitlab-Token by equality for GitLab, X-Hub-Signature-256 / X-Hub-Signature by HMAC for GitHub and Bitbucket (portal-generated, separate from the outbound trigger token stored in webhook_token); calls handlePipelineEvent to transition order/infra state and parse OpenTofu outputs."
                api_audit = component "Audit Routes" "Thin HTTP shell: call audit service for filterable log and CSV/PDF export."
                svc_orders = component "Orders Service" "State machine: pending → provisioning → completed/failed/rejected. Calls CI trigger, writes audit, sends emails."
                svc_approvals = component "Approvals Service" "Approve (triggers CI, creates infra element) and reject (stores note, notifies orderer)."
                svc_infrastructure = component "Infrastructure Service" "Ownership check, status guard, CI destroy trigger, audit write. Also the retry of a failed deployment and a DEFERRED decommission, which stores a time and is acted on later by the sweep rather than torn down now."
                svc_cart = component "Cart Service" "Cart lines and checkout. Caps the elements one checkout may provision, and the count and the insert run in one transaction holding the owner row so two checkouts cannot both pass the cap (#188)."
                svc_projects = component "Projects Service" "Projects and their membership, which is what scopes a project manager to their own orders and infrastructure."
                svc_comments = component "Order Comments Service" "The thread on an order, including internal notes only staff see. Notifies via sendOrderComment."
                svc_twofactor = component "Second Factor & Sessions" "TOTP enrolment and verification with a lockout, single-use recovery codes, WebAuthn passkeys, and the active-session list with per-session revocation."
                svc_integrations = component "Integrations Registry" "External systems beyond CI — foreman, ansible, nexus, pulp, loki, grafana, opa (#111, #110). Stores kind, base URL, credentials and per-environment binding; each is configured but not yet driven by provisioning."
                svc_admin = component "Admin Services" "One service per domain: users, products, categories, sizes, environments, ciSources, parameters, costCenters, exchangeRates, config, branding, pipelineStacks, templateImport and integrations."
                svc_auth = component "Auth Service" "Bcrypt credential verify, JWT issue. Returns Result<T>. The SSO user upsert went with the removed callback (#139)."
                lib_queries = component "Query Helpers" "Shared DB reads used across services: findProductName, findUserEmail, findAdminEmails, findCiSourceForEnv."
                lib_result = component "Result<T> / toResponse" "Ok<T>|Err discriminated union; toResponse() maps Result to NextResponse."
                api_notification = component "Notification" "Eight typed send functions (the eighth, sendOrderComment, arrived with order comments); HTML-escapes all user strings before embedding in email bodies."
                api_ai = component "AI Translation" "Translates product content into 25 languages via the configured AI provider."
                api_exchange = component "Exchange Rates" "Fetches and caches exchange rates; converts amounts between currencies."
                api_ci = component "CI Provider Client" "Unified client for GitLab, GitHub and Bitbucket: trigger pipelines, browse repos, fetch job traces. triggerProductWebhooks() orchestrates webhook execOrder; triggerPipelineStacks() sends stack steps (each with execOrder for parallel groups and optional upstreamRefs for cross-step state passing) as PIPELINE_STACK JSON to the CI orchestrator."
                api_windows = component "Deployment Window Routes" "Root defines when provisioning may run (#330): GET/PUT /api/admin/deployment-windows replaces the window set, POST /api/orders/{id}/deploy-now releases one scheduled order early, and POST /api/internal/deployment-window-sweep releases every order whose window has opened."
                svc_windows = component "Window Policy" "Decides what happens to an approved order: provision now, or wait in `scheduled` until the next window. Pure wall-clock arithmetic over a zone, the window set and the observed holidays; weekends and holidays are excluded. Releases due orders under the same atomic claim root's override races against. Fails OPEN when a configured holiday feed has never been read: with no holiday data it cannot tell a holiday from a working day, so it stops applying windows rather than deploying on Christmas."
                svc_holidays = component "Holiday Feed" "Pulls an ICS or JSON feed on a schedule and caches the dates, so the decision path never makes a network call. Feed rows are replaced wholesale; manual rows — a company shutdown, a holiday worked through — survive a refresh. A failed refresh keeps the last good set."
                api_drift = component "Drift Routes" "Two internal endpoints for the scheduled drift loop (#108), both authenticated with a shared secret in X-Drift-Secret and both 503 when it is unset: GET /api/internal/drift-targets hands out the work list, POST /api/internal/drift-report records what the plans found."
                svc_drift = component "Drift Service" "Builds the work list from active elements and their stack steps, and records each report. Matches a reported state key by composing <base>-<stateSuffix> the same way generate_stack.py does; aggregates an element's states into one reading (drift anywhere wins) and refuses a report older than the one already stored."
                api_docs = component "OpenAPI / Swagger UI" "Swagger UI and OpenAPI 3.0 spec auto-generated from Zod schemas."
            }

            database = container "Database" "Stores all portal data: catalog, orders, infrastructure, users, audit log, config, branding and pipeline stacks." "PostgreSQL 16" "Database"
        }

        # Relationships — system level
        admin -> webshop "Orders IT infrastructure directly, approves orders, monitors all projects"
        root -> webshop "Manages product catalog, system configuration and users"
        project_manager -> webshop "Orders and manages own IT infrastructure"
        webshop -> gitlab "Browses repositories, triggers pipelines, fetches job traces to parse OpenTofu outputs" "JSON/HTTPS"
        gitlab -> webshop "Pushes pipeline status events via webhook" "JSON/HTTPS"
        webshop -> github "Browses repositories, triggers workflow_dispatch runs" "JSON/HTTPS"
        github -> webshop "Pushes workflow-run status events via webhook" "JSON/HTTPS"
        webshop -> bitbucket "Browses repositories, triggers pipelines" "JSON/HTTPS"
        bitbucket -> webshop "Pushes pipeline status events via webhook" "JSON/HTTPS"
        webshop -> oidc_provider "PLANNED (#139): authenticates admins and project leaders" "OIDC/HTTPS"
        webshop -> ai_translation "Translates product content (optional, configurable)" "JSON/HTTPS"
        webshop -> smtp "Sends transactional emails" "SMTP"
        webshop -> exchange_rate_api "Fetches current exchange rates" "JSON/HTTPS"

        # Relationships — container level
        admin -> frontend "Uses web interface" "HTTPS"
        root -> frontend "Manages shop" "HTTPS"
        project_manager -> frontend "Uses web interface" "HTTPS"
        frontend -> backend "All data and actions via REST API" "JSON/HTTPS"
        backend -> database "Reads and writes" "SQL/TCP"
        backend -> gitlab "Triggers pipelines, browses repositories, fetches job traces" "JSON/HTTPS"
        gitlab -> backend "Pushes pipeline status events via webhook" "JSON/HTTPS"
        backend -> github "Triggers workflow_dispatch runs, browses repositories" "JSON/HTTPS"
        github -> backend "Pushes workflow-run status events via webhook" "JSON/HTTPS"
        backend -> bitbucket "Triggers pipelines, browses repositories" "JSON/HTTPS"
        bitbucket -> backend "Pushes pipeline status events via webhook" "JSON/HTTPS"
        backend -> oidc_provider "PLANNED (#139): OIDC Authorization Code Flow" "OIDC/HTTPS"
        backend -> ai_translation "AI translation requests (optional)" "JSON/HTTPS"
        backend -> smtp "Sends transactional emails via Nodemailer" "SMTP"
        backend -> exchange_rate_api "Fetches current exchange rates" "JSON/HTTPS"

        # Relationships — frontend components
        admin -> ui_auth "Logs in with a local account (SSO planned, #139)"
        project_manager -> ui_auth "Logs in with a local account (SSO planned, #139)"
        root -> ui_auth "Logs in with local account"
        ui_auth -> ui_proxy "POST /api/auth/login" "JSON/HTTPS"
        ui_auth -> oidc_provider "PLANNED (#139): OIDC Authorization Code Flow via NextAuth.js. There has never been an SSO provider in the NextAuth config or a button on the login page." "OIDC/HTTPS"

        admin -> ui_catalog "Browses infrastructure products"
        project_manager -> ui_catalog "Browses infrastructure products"
        ui_catalog -> ui_proxy "GET /api/catalog, GET /api/catalog/{id}" "JSON/HTTPS"

        admin -> ui_orders "Orders directly without approval"
        project_manager -> ui_orders "Places order, awaits approval"
        ui_orders -> ui_proxy "POST /api/orders, GET /api/orders, GET /api/orders/{id}" "JSON/HTTPS"

        admin -> ui_approvals "Reviews and decides on pending orders"
        ui_approvals -> ui_proxy "GET /api/approvals, POST /api/approvals/{id}/approve, POST /api/approvals/{id}/reject" "JSON/HTTPS"

        admin -> ui_infrastructure "Views all projects and infrastructure"
        root -> ui_infrastructure "Views all projects and infrastructure"
        project_manager -> ui_infrastructure "Views own projects and infrastructure"
        ui_infrastructure -> ui_proxy "GET /api/infrastructure, POST /api/infrastructure/{id}/decommission" "JSON/HTTPS"

        admin -> ui_audit "Views and exports the audit log"
        root -> ui_audit "Views and exports the audit log"
        ui_audit -> ui_proxy "GET /api/audit, GET /api/audit/export" "JSON/HTTPS"

        root -> ui_admin "Manages catalog, configuration and users"
        ui_admin -> ui_proxy "REST API calls to /api/admin/*" "JSON/HTTPS"

        admin -> ui_settings "Updates profile and password"
        project_manager -> ui_settings "Updates profile and password"
        ui_settings -> ui_proxy "GET /api/users/me, PUT /api/users/me/password, /api/users/me/2fa/*, /api/users/me/webauthn/*, /api/sessions" "JSON/HTTPS"

        admin -> ui_cart "Collects lines, then checks out against a project"
        project_manager -> ui_cart "Collects lines, then checks out against a project"
        ui_cart -> ui_proxy "GET/POST/DELETE /api/cart, POST /api/cart/checkout" "JSON/HTTPS"

        root -> ui_projects "Creates projects and assigns members"
        admin -> ui_projects "Manages projects"
        project_manager -> ui_projects "Sees the projects they belong to"
        ui_projects -> ui_proxy "GET/POST/PUT /api/projects, /api/projects/{id}/members" "JSON/HTTPS"

        # The one hop that actually crosses the container boundary. Drawn once,
        # here, rather than eight times from eight page components — which is the
        # point of #146 and was the thing the old model got wrong.
        ui_proxy -> backend "Server-side fetch with the session's JWT as a Bearer token" "JSON/HTTPS"

        # Relationships — the capabilities added after the model was last revised
        api_orders -> svc_cart "Delegates cart and checkout" "internal"
        svc_cart -> database "Reads and writes" "SQL/TCP"
        svc_projects -> database "Reads and writes" "SQL/TCP"
        svc_comments -> database "Reads and writes" "SQL/TCP"
        svc_comments -> api_notification "Notifies" "internal"
        api_auth -> svc_twofactor "Verifies the second factor, or a passkey, after the password" "internal"
        svc_twofactor -> database "Reads and writes" "SQL/TCP"
        svc_integrations -> database "Reads and writes" "SQL/TCP"

        # Relationships — backend components
        # Route handler → service
        api_auth -> svc_auth "Delegates credential logic" "internal"
        api_orders -> svc_orders "Delegates order creation" "internal"
        api_orders -> svc_approvals "Delegates approve/reject" "internal"
        api_infrastructure -> svc_infrastructure "Delegates list and decommission" "internal"
        api_admin -> svc_admin "Delegates all CRUD operations" "internal"
        api_audit -> lib_queries "Shared reads" "internal"

        # Services → shared libraries
        svc_orders -> api_ci "Triggers provisioning" "internal"
        svc_orders -> api_notification "Notifies" "internal"
        svc_orders -> lib_queries "Shared reads" "internal"
        svc_approvals -> api_ci "Triggers provisioning" "internal"
        svc_approvals -> api_notification "Notifies" "internal"
        svc_approvals -> lib_queries "Shared reads" "internal"
        svc_infrastructure -> api_ci "Triggers teardown" "internal"
        svc_infrastructure -> lib_queries "findCiSourceForEnv" "internal"
        svc_auth -> oidc_provider "PLANNED (#139): validates OIDC ID token. The removed handler decoded it without checking the signature, aud or iss." "OIDC/HTTPS"
        svc_admin -> api_ai "Triggers AI translation for a product" "internal"
        svc_admin -> api_exchange "Refreshes stored exchange rates" "internal"
        svc_admin -> api_ci "Browses repositories, imports variables.tf" "internal"

        # Webhook handler
        gitlab -> api_webhook "Pushes pipeline status events" "JSON/HTTPS"
        github -> api_webhook "Pushes workflow-run status events" "JSON/HTTPS"
        bitbucket -> api_webhook "Pushes pipeline status events" "JSON/HTTPS"
        api_webhook -> database "Writes" "SQL/TCP"
        api_webhook -> api_ci "Fetches job trace to parse OpenTofu outputs on success" "internal"
        api_webhook -> api_notification "Triggers completion or failure notification" "internal"
        api_webhook -> lib_queries "Shared reads" "internal"

        # Deployment windows (#330) — an approved order may wait for the clock
        api_windows -> svc_holidays "Feed config, preview, manual dates, refresh" "internal"
        svc_holidays -> database "Caches the resolved dates and the feed's health" "SQL/TCP"
        svc_windows -> svc_holidays "Asks whether there is holiday data to trust" "internal"
        api_windows -> svc_windows "Delegates the window set, the release and the override" "internal"
        svc_windows -> database "Reads windows, holidays and the zone; claims due orders" "SQL/TCP"
        svc_windows -> svc_orders "Provisions an order once its window opens" "internal"
        svc_approvals -> svc_windows "Asks whether a window has to open first" "internal"

        # Scheduled drift loop (#108) — inverted: CI asks, the portal answers and records
        gitlab -> api_drift "Scheduled: asks for the work list, reports the plans" "JSON/HTTPS"
        api_drift -> svc_drift "Delegates the work list and the report" "internal"
        svc_drift -> database "Reads elements and stacks, writes refresh state" "SQL/TCP"

        # External I/O
        api_notification -> smtp "Dispatches emails via Nodemailer" "SMTP"
        api_ai -> ai_translation "Calls configured AI provider API" "JSON/HTTPS"
        api_exchange -> exchange_rate_api "Fetches current rates" "JSON/HTTPS"
        api_exchange -> database "Stores and reads cached rates" "SQL/TCP"
        api_ci -> gitlab "GitLab v4 API; the only provider job traces are fetched from" "JSON/HTTPS"
        api_ci -> github "GitHub REST API; no job-trace fetch, so no parsed OpenTofu outputs" "JSON/HTTPS"
        api_ci -> bitbucket "Bitbucket 2.0 API; no job-trace fetch, so no parsed OpenTofu outputs" "JSON/HTTPS"

        # DB access (all services and helpers)
        svc_auth -> database "Reads and writes" "SQL/TCP"
        svc_orders -> database "Reads and writes" "SQL/TCP"
        svc_approvals -> database "Reads and writes" "SQL/TCP"
        svc_infrastructure -> database "Reads and writes" "SQL/TCP"
        svc_admin -> database "CRUD for all catalog and configuration entities" "SQL/TCP"
        lib_queries -> database "Shared read queries" "SQL/TCP"

        # Deployment — Docker Host
        deploymentEnvironment "Docker Host" {
            deploymentNode "Docker Host" "Single server for local development and initial deployment" "Docker Engine" {
                deploymentNode "nginx" "HTTPS termination and reverse proxy. Routes /api/* to the backend EXCEPT four prefixes that belong to the frontend: /api/proxy, /api/auth, /api/login-challenge and /api/ping; everything else to the frontend. /api/proxy is the important one and must sit ABOVE the general /api/ block — it is the browser's only path to the backend since #146, and a general /api/ rule swallows it, which breaks every dashboard action. The /api/auth/callback exact match went with the SSO flow (#139) and has to come back with it." "Docker Container / Nginx" {
                }
                deploymentNode "frontend" "Next.js frontend server" "Docker Container / Node.js" {
                    containerInstance frontend
                }
                deploymentNode "backend" "Next.js API server" "Docker Container / Node.js" {
                    containerInstance backend
                }
                deploymentNode "postgres" "Database" "Docker Container" {
                    containerInstance database
                }
            }
            deploymentNode "Entra ID (external)" "" "SaaS" {
                softwareSystemInstance oidc_provider
            }
            deploymentNode "GitLab (external)" "" "On-Premise / SaaS" {
                softwareSystemInstance gitlab
            }
            deploymentNode "GitHub (external)" "" "SaaS" {
                softwareSystemInstance github
            }
            deploymentNode "Bitbucket (external)" "" "SaaS" {
                softwareSystemInstance bitbucket
            }
            deploymentNode "Mail Server (external)" "" "On-Premise / SaaS" {
                softwareSystemInstance smtp
            }
            deploymentNode "Exchange Rate API (external)" "" "SaaS" {
                softwareSystemInstance exchange_rate_api
            }
        }

        # Deployment — Kubernetes
        deploymentEnvironment "Kubernetes" {
            deploymentNode "Kubernetes Cluster" "Production cluster" "Kubernetes" {
                deploymentNode "infrashelf" "Application namespace" "Kubernetes Namespace" {
                    deploymentNode "Ingress + cert-manager" "HTTPS termination via Let's Encrypt or internal CA. Routes /api/* to the backend service EXCEPT four prefixes that belong to the frontend: /api/proxy, /api/auth, /api/login-challenge and /api/ping; everything else to the frontend service. /api/proxy is the browser's only path to the backend since #146 and must be matched before the general /api/ rule. The /api/auth/callback exact match went with the SSO flow (#139) and has to come back with it." "Nginx Ingress / cert-manager" {
                    }
                    deploymentNode "frontend Deployment" "Next.js frontend pods, horizontally scalable." "Kubernetes Deployment" {
                        containerInstance frontend
                    }
                    deploymentNode "backend Deployment" "Next.js API pods, horizontally scalable. Stateless — all state in PostgreSQL." "Kubernetes Deployment" {
                        containerInstance backend
                    }
                    # Only in this view: the Docker-host deployment has no equivalent
                    # and expects an external scheduler to call the endpoint instead.
                    deploymentNode "decommission-sweep CronJob" "Calls POST /api/internal/decommission-sweep on a schedule, authenticated with X-Sweep-Secret. Without it a scheduled decommission is only ever a stored timestamp and nothing is ever torn down." "Kubernetes CronJob" {
                    }

                    # Only where an environment opts into windows (#330). Its
                    # interval is the delay between a window opening and the
                    # orders in it deploying, so it runs every couple of minutes
                    # rather than every fifteen.
                    deploymentNode "deployment-window-sweep CronJob" "Calls POST /api/internal/deployment-window-sweep on a schedule, authenticated with X-Sweep-Secret. Without it an order that reached 'scheduled' waits indefinitely." "Kubernetes CronJob" {
                    }

                    deploymentNode "postgres StatefulSet" "PostgreSQL with persistent volume" "Kubernetes StatefulSet" {
                        containerInstance database
                    }
                }
            }
            deploymentNode "Entra ID (external)" "" "SaaS" {
                softwareSystemInstance oidc_provider
            }
            deploymentNode "GitLab (external)" "" "On-Premise / SaaS" {
                softwareSystemInstance gitlab
            }
            deploymentNode "GitHub (external)" "" "SaaS" {
                softwareSystemInstance github
            }
            deploymentNode "Bitbucket (external)" "" "SaaS" {
                softwareSystemInstance bitbucket
            }
            deploymentNode "Mail Server (external)" "" "On-Premise / SaaS" {
                softwareSystemInstance smtp
            }
            deploymentNode "Exchange Rate API (external)" "" "SaaS" {
                softwareSystemInstance exchange_rate_api
            }
        }
    }

    views {
        systemcontext webshop "SystemContext" {
            include *
            autoLayout
            description "System context: InfraShelf and all external systems"
        }

        container webshop "Container" {
            include *
            autoLayout
            description "Container diagram: Next.js frontend, Next.js backend API and PostgreSQL database"
        }

        component frontend "Component_Frontend" {
            include *
            autoLayout
            description "Component diagram: Next.js frontend application"
        }

        component backend "Component_Backend" {
            include *
            autoLayout
            description "Component diagram: Next.js backend API"
        }

        deployment webshop "Docker Host" "Deployment_DockerHost" {
            include *
            autoLayout
            description "Deployment on a Docker host with Nginx for HTTPS"
        }

        deployment webshop "Kubernetes" "Deployment_Kubernetes" {
            include *
            autoLayout
            description "Deployment on Kubernetes with Ingress and cert-manager"
        }

        styles {
            element "Person" {
                color #ffffff
                background #08427b
                fontSize 22
                shape Person
            }
            element "Software System" {
                background #1168bd
                color #ffffff
            }
            element "Existing System" {
                background #999999
                color #ffffff
            }
            element "Container" {
                background #438dd5
                color #ffffff
            }
            element "Database" {
                shape Cylinder
            }
            element "Component" {
                background #85bbf0
                color #000000
            }
        }
    }
}

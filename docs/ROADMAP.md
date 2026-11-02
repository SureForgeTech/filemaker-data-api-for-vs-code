# FileMaker web experiences and integration workspace

Plan prepared November 2, 2026. Proposed delivery sequence; dates and effort estimates follow implementation discovery. This document describes intended capabilities, not features already available or a promise of compatibility.

## Vision

Help FileMaker developers extend their existing solutions with intake portals, business websites, simple commerce and reliable integrations. VS Code is an additional workspace for developing the web experience, testing its API contracts and delivering its automation. FileMaker remains the home of the existing solution, data and business processes.

Suggested product introduction:

> Extend your FileMaker solution with web portals, websites and integrations built in VS Code.

The primary audience is FileMaker developers and consultancies delivering experiences for their businesses or clients. The first complete experience is a branded event registration portal whose submissions enter an existing FileMaker workflow. The same foundation should support service intake, applications, appointment requests, product catalogs and developer business websites.

## Starting point and direction

At main revision `491eb797de747bfbb208bc773869e386bda97ec7`, the extension has query and script tools, saved queries, request-to-code export, schema snapshots and comparisons, type/client generation, batch operations and optional AI tools. The source also includes FM Web project metadata, a layout designer and a Next.js runtime template. The Marketplace package does not include the complete runtime template; a source-checkout preview is not a shipped portal product.

Assess and reuse that work before adding another renderer, client, project format or job engine. Focus the designer on responsive web pages and forms. Invest in API tooling when it directly improves building, testing or operating those experiences. Keep record editing and schema browsing as useful developer tools; broad desktop-client feature parity is outside this plan.

## Shared foundation

- One versioned project definition connects page/form definitions, explicit FileMaker field mappings, API operations, environment references and tests. Keep credentials, live submissions and personal data out of version control.
- Separate presentation from a server-side API adapter. Browser code receives only deliberately exposed content and operations. A public website must not depend on a running VS Code window or the local development bridge.
- Default to narrowly scoped public operations and a dedicated, least-privilege FileMaker account. Resolve targets, layouts, fields and permitted scripts from trusted server configuration; do not accept arbitrary upstream requests from a browser.
- Validate on the server as well as the client. Apply request size limits, abuse protection, safe error responses and redacted diagnostics. Define what happens when submission outcome is uncertain; do not blindly retry writes or scripts.
- Use standard web technology and readable generated code. Establish managed versus user-owned files and preserve user edits during regeneration.
- Reuse FileMaker scripts intentionally for existing business logic. Test script results and API-compatible behavior rather than assuming interactive-client behavior carries over.
- AI remains optional. The complete build/test/publish workflow must work without it. Any disclosure of schema or data to an AI provider requires explicit control and accurate explanation.

## Ease of use is a product requirement

The extension must make FileMaker web development easier to understand and complete. Adding capability is not sufficient if it adds navigation, setup choices or concepts that the user must learn before achieving a useful result.

The manifest at the starting revision declares 77 commands and 54 configuration properties. These are declaration counts, not a measurement of simultaneously visible controls or proof that every command is unnecessary. Audit actual entry points, visibility conditions, overlapping actions and user journeys before changing them.

- Organize the primary experience around a small set of tasks: connect a solution, build a portal or website, preview/test, and publish/manage. Validate these labels with representative FileMaker developers before making them permanent.
- Provide one obvious starting point with a recommended next action. Use a short, resumable guided flow for the first portal. Do not require users to understand the runtime generator, metadata synchronization, bridge server or environment JSON before seeing a working preview.
- Prefer contextual actions and sensible defaults. Reveal advanced API, schema, diagnostics and automation tools when relevant; preserve their direct command access for experienced users.
- Consolidate genuinely overlapping entry points. Do not silently break existing command identifiers, shortcuts, saved projects or automation. Distinguish hiding a command from removing its underlying capability.
- Add user-facing controls only when they support a clear task. Every new flow must explain where it lives and what existing flow it reuses or simplifies; a separate menu or top-level command is not the default.
- Keep implementation terms in diagnostics and advanced views unless needed for a meaningful decision. Make connection status, active environment, validation failures and the next corrective action understandable in FileMaker developer language.
- Test with representative developers using realistic tasks. Observe completion, wrong turns, requests for help and recovery from errors. Establish baselines before setting numerical targets; reducing command count alone is not success.

Each phase must demonstrate that its main workflow is understandable without a tour of the extension. The initial UX inventory and proposed primary journey are the first bounded task; implementation of that journey and the intake vertical slice follow as separate reviewable tasks. This is a focused assessment, not an open-ended redesign prerequisite.

## Backward compatibility

Preserve existing workflows by default. Ease-of-use improvements should be additive or compatible refinements: a guided entry point can call existing commands, clearer labels can retain command identifiers, and new project capabilities can coexist with older projects.

- Preserve command identifiers, shortcuts, settings and defaults, stored connections, saved queries, project definitions, generated-code ownership and supported integration behavior unless a justified change explicitly covers them.
- Treat moving or hiding a frequently used action as a discoverability change even if its command still works. Provide a clear path from the previous location and verify the existing journey.
- Prefer aliases, compatibility readers, opt-in new behavior and staged deprecation over removal. Version persisted formats; provide tested migration and recovery without silently overwriting user changes.
- A proposed breaking change must identify the concrete user benefit or security/correctness need, affected users and artifacts, why compatible alternatives are insufficient, and the migration, communication, validation and recovery approach. Present that decision explicitly for owner approval before implementation; this requirement records the owner's instruction to avoid unjustified breakage.
- Do not treat a lower command count, visual consistency or an internal architectural preference as sufficient reason for breakage. A genuine urgent security issue follows the repository's security process rather than preserving unsafe behavior indefinitely.

Every implementation slice includes compatibility acceptance criteria and relevant regression checks. This roadmap does not itself authorize any breaking change.

## Phase 1 — Develop, test and publish intake portals

### Product outcome

A FileMaker developer selects an intake layout, maps its fields to a responsive form, previews it against synthetic data and publishes a branded registration portal that creates the intended FileMaker record.

### Capabilities, in delivery order

1. Establish a reusable intake definition and a complete local vertical slice: a small event registration form, explicit field allowlist, server-side submission adapter, synthetic FileMaker fixture and end-to-end tests. Reuse the existing FM Web foundation where appropriate. No public deployment in this first slice.
2. Add developer-facing configuration: layout/field mapping, labels, required fields, supported field types, basic branding and accessible responsive preview. Keep exact FileMaker names intact. Preview and production must use the same validation and mapping logic.
3. Connect API tooling to the project: parameterized saved requests, named development/staging environments, response assertions and sanitized fixtures. Store reproducible request definitions in Git; resolve secrets separately. Add script parameter/result assertions where a script is explicitly configured.
4. Add a guided deployment path for one supported server runtime, environment/secret configuration and a tested packaged-extension experience. Public deployments require verified access controls, abuse controls and submission failure handling. Publish the compatibility matrix based on actual recorded server tests.
5. Expand to service inquiries, applications and appointment requests. Add conditional questions, multi-step forms, acknowledgment emails and an explicit approved post-submission script as separately tested increments. Define partial-success handling so an email/script failure does not silently recreate an accepted registration.

### Exit criteria

- A second developer can clone an example, supply their own development credentials and reproduce its contract tests and preview.
- A Marketplace-installed extension can create and guide deployment of the supported portal without requiring this repository checkout.
- A branded event registration works on mobile and keyboard-only navigation, creates only permitted fields and displays an accurate success/failure state.
- Tests cover tampered fields/targets, invalid input, unavailable FileMaker, repeated submissions and ambiguous write outcomes. A recorded supported real-server test confirms the integration; mocks are reported separately.
- The deployed portal continues working with VS Code closed. Secrets are absent from browser assets, project files and diagnostics.
- Representative FileMaker developers can find the starting point and complete the supported create/preview/test/publish journey; record observed friction and verify improvements rather than claiming usability from automated tests alone.

Customer accounts, sensitive-document uploads, payments and complex reservation/capacity logic are deferred until their specific access and consistency requirements are designed.

## Phase 2 — Build connected websites, integrations and simple commerce

### Product outcome

A developer publishes a business, event or portfolio website with selected content managed in FileMaker, or a small catalog that accepts an order through hosted checkout and records its verified status in FileMaker.

### Capabilities

- Add reusable pages and components for services, portfolios, events and products, with detail pages, navigation, responsive media, search/filtering and basic SEO.
- Introduce an explicit public content contract: approved fields, draft versus published state, preview and cache refresh. Never infer that a readable FileMaker field is intended for public publication.
- Extend existing type/client generation into one well-supported TypeScript integration starter with configuration, tests, pagination, error handling and readable mapping code.
- Add mapping previews for FileMaker-to-JSON contracts, conversions and missing values. Compare project dependencies against staging metadata and report relevant schema drift before deployment.
- Deliver complete examples: developer business site with inquiry intake, event site with registration, customer lookup integration and a small storefront.
- Add catalog/cart and hosted payment checkout. Keep payment secrets server-side; verify payment notifications and reconcile uncertain or repeated events before changing order state. Prices and order totals must be resolved and checked server-side.

### Exit criteria

- A developer can publish a real business website and update intentionally exposed content through FileMaker.
- One external integration can be built and tested without reconstructing authentication, pagination and response handling.
- A sandbox checkout produces one correct order and payment state despite duplicate, delayed or out-of-order notifications. An unverified browser success redirect cannot mark an order paid.
- Integration contract tests detect a breaking mapped-field change before deployment, and regeneration preserves user-owned code.

Complex tax, subscriptions, fulfillment, inventory reservations, multi-vendor marketplaces and a broad proprietary connector catalog require separate scope. Choose payment, email and deployment providers through a small requirements-based evaluation; this roadmap selects none and authorizes no spend.

## Phase 3 — Operate automations and customer self-service

### Product outcome

A consultancy can deploy a reusable customer portal and its integrations, run unattended jobs outside the editor and diagnose failures without exposing customer data.

### Capabilities

- Extract a shared execution library/headless runner so saved contracts and jobs run in local tests, CI and the chosen server runtime. Integrate with external schedulers for exports, reconciliation and notifications.
- Add checkpoints, bounded retries, duplicate protection, cancellation semantics and explicit uncertain-outcome recovery. Do not promise transactionality across FileMaker and external systems.
- Provide redacted run reports with durations, counts, correlation identifiers and actionable failures. Add development/production separation, deployment history and rollback guidance that accounts for data changes.
- Introduce customer authentication and enforce per-customer authorization server-side for every operation. Add status views, selected profile changes and document exchange as separately scoped features with negative authorization tests.
- Package reusable portal templates and versioned upgrades for consultancies. Add provider integrations where repeated real projects demonstrate demand.

### Exit criteria

- An automation runs while VS Code is closed, recovers from a tested interruption and produces enough evidence to diagnose failure.
- One customer cannot read or modify another customer's records, including by changing identifiers or calling endpoints directly.
- A second client portal can reuse the foundation without copying credentials, customer data or client-specific assumptions.
- Operators can identify a failed deployment or automation and follow a documented recovery path.

## Execution rules and first milestone

Ship small, reviewable slices. Each implementation task declares scope, acceptance criteria, meaningful tests and its delivery route. Follow repository validation, independent exact-head review and protected merge requirements. Do not describe preview-only or mock-only features as production ready.

The first task is a bounded UX and reuse assessment: inventory the actual user-facing entry points, identify overlap, propose the primary first-portal journey and map it to existing designer/runtime/bridge code and packaged-extension constraints. Do not remove commands or rewrite the UI during this assessment.

The first implementation milestone is the Phase 1 local event-registration vertical slice, not all of Phase 1. Produce the concrete contract and file scope, then implement the smallest path from a versioned intake definition to a rendered form to one validated submission against a synthetic adapter, reached through the proposed simple journey. Demonstrate it and test rejection paths before broadening the builder or selecting deployment infrastructure.

Progress measures are completed developer workflows: time to first working portal, reproducibility on another developer machine, successful submission and recovery behavior, integration test usefulness and reuse on a second project. Establish measured baselines before publishing numerical targets.

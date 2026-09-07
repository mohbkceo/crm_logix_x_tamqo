# Graph Report - C:\Users\MrCOMPUTER\Desktop\ProjectsGithub\crm_partnership  (2026-09-07)

## Corpus Check
- Corpus is ~39,404 words - fits in a single context window. You may not need a graph.

## Summary
- 437 nodes · 1325 edges · 18 communities (15 shown, 3 thin omitted)
- Extraction: 99% EXTRACTED · 1% INFERRED · 0% AMBIGUOUS · INFERRED: 17 edges (avg confidence: 0.69)
- Token cost: 0 input · 0 output

## Community Hubs (Navigation)
- Core Domain and Data
- React UI Utilities
- API Authentication Authorization
- Workspace Tooling
- Server Dependencies
- Order Domain Models
- Analytics and Expenses
- Client Dependencies
- Architecture Documentation
- Delivery Provider Client
- Local Development Runtime
- Courier Reliability Concepts
- Browser Smoke Tests
- React Error Boundary

## God Nodes (most connected - your core abstractions)
1. `assert()` - 51 edges
2. `can()` - 32 edges
3. `useApi()` - 27 edges
4. `money()` - 22 edges
5. `Order` - 22 edges
6. `P` - 21 edges
7. `human()` - 18 edges
8. `Shipment` - 18 edges
9. `audit()` - 18 edges
10. `transaction()` - 18 edges

## Surprising Connections (you probably didn't know these)
- `Tamqo × Logix Workspace Document` --semantically_similar_to--> `Tamqo × Logix Workspace`  [INFERRED] [semantically similar]
  client/index.html → README.md
- `requirePermission()` --calls--> `can()`  [EXTRACTED]
  server/src/authorization.js → shared/permissions.js
- `requireBusinesses()` --calls--> `hasBusinessAccess()`  [EXTRACTED]
  server/src/authorization.js → shared/permissions.js
- `requireOwnOrAll()` --calls--> `can()`  [EXTRACTED]
  server/src/authorization.js → shared/permissions.js
- `analyticsScope()` --calls--> `can()`  [EXTRACTED]
  server/src/authorization.js → shared/permissions.js

## Import Cycles
- None detected.

## Hyperedges (group relationships)
- **MERN Application Stack** — readme_react_frontend, readme_express_api, readme_mongodb_datastore [EXTRACTED 1.00]
- **Reliable Courier Creation Flow** — readme_automatic_courier_creation, readme_shipment_reservation, readme_uncertain_external_outcome, readme_shipment_reconciliation, readme_procolis_adapter [EXTRACTED 1.00]

## Communities (18 total, 3 thin omitted)

### Community 0 - "Core Domain and Data"
Cohesion: 0.09
Nodes (51): requirePermission(), calculateFinancials(), canProviderTransition(), canTransition(), normalizePhone(), AppError, assert(), bootstrap() (+43 more)

### Community 1 - "React UI Utilities"
Cohesion: 0.15
Nodes (57): Can(), Guard(), UserContext, useUser(), api(), ConfigContext, date(), dateInput() (+49 more)

### Community 2 - "API Authentication Authorization"
Cohesion: 0.07
Nodes (43): app, dist, realizedExpression, authenticated(), identityInput, limit, options, requireAuth() (+35 more)

### Community 3 - "Workspace Tooling"
Cohesion: 0.05
Nodes (37): concurrently, eslint, @eslint/js, eslint-plugin-react-hooks, globals, mongodb-memory-server, devDependencies, concurrently (+29 more)

### Community 4 - "Server Dependencies"
Cohesion: 0.06
Nodes (35): axios, bcryptjs, cookie-parser, cors, dotenv, express, express-rate-limit, helmet (+27 more)

### Community 5 - "Order Domain Models"
Cohesion: 0.09
Nodes (26): BUSINESS, BUSINESS_TYPES, DELIVERY_TYPES, PAYMENT_METHODS, STATUSES, TERMINAL, TRANSITIONS, amount (+18 more)

### Community 6 - "Analytics and Expenses"
Cohesion: 0.17
Nodes (28): round(), dateKey(), dayStart(), reportingRange(), Expense, ExpenseCategory, dataFor(), filters() (+20 more)

### Community 7 - "Client Dependencies"
Cohesion: 0.07
Nodes (28): dependencies, lucide-react, react, react-dom, react-router-dom, recharts, devDependencies, tailwindcss (+20 more)

### Community 8 - "Architecture Documentation"
Cohesion: 0.09
Nodes (27): Main JSX Entrypoint, React Root Mount, Tamqo × Logix Workspace Document, Atomic Order Numbering, Authentication and Session Security, Backend-authoritative Calculations, Business-scoped Revenue, Central Reporting Definitions (+19 more)

### Community 10 - "Local Development Runtime"
Cohesion: 0.25
Nodes (5): dbPath, env, mongoPort, processes, uri

### Community 11 - "Courier Reliability Concepts"
Cohesion: 0.40
Nodes (6): Automatic Courier Creation, Verified Delivery Status Mapping, ABEX / Procolis Adapter, Shipment Reconciliation, Shipment Attempt Reservation, Uncertain External Outcome

## Knowledge Gaps
- **109 isolated node(s):** `name`, `version`, `private`, `type`, `dev` (+104 more)
  These have ≤1 connection - possible missing edges or undocumented components.
- **3 thin communities (<3 nodes) omitted from report** — run `graphify query` to explore isolated nodes.

## Suggested Questions
_Questions this graph is uniquely positioned to answer:_

- **Why does `P` connect `React UI Utilities` to `Core Domain and Data`, `API Authentication Authorization`, `Order Domain Models`, `Analytics and Expenses`?**
  _High betweenness centrality (0.089) - this node is a cross-community bridge._
- **Why does `can()` connect `React UI Utilities` to `Core Domain and Data`, `API Authentication Authorization`, `Order Domain Models`, `Analytics and Expenses`?**
  _High betweenness centrality (0.060) - this node is a cross-community bridge._
- **Why does `assert()` connect `Core Domain and Data` to `Delivery Provider Client`, `API Authentication Authorization`, `Order Domain Models`, `Analytics and Expenses`?**
  _High betweenness centrality (0.038) - this node is a cross-community bridge._
- **What connects `name`, `version`, `private` to the rest of the system?**
  _109 weakly-connected nodes found - possible documentation gaps or missing edges._
- **Should `Core Domain and Data` be split into smaller, more focused modules?**
  _Cohesion score 0.09315310020570085 - nodes in this community are weakly interconnected._
- **Should `React UI Utilities` be split into smaller, more focused modules?**
  _Cohesion score 0.1483375959079284 - nodes in this community are weakly interconnected._
- **Should `API Authentication Authorization` be split into smaller, more focused modules?**
  _Cohesion score 0.0707070707070707 - nodes in this community are weakly interconnected._
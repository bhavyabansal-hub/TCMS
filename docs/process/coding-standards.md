# TCMS Coding Standards (mandatory)

Owner-defined. Every agent follows these. This file keeps the owner's original wording;
the concrete rules and the Definition of Done live **only** in [`agent.md`](../../agent.md)
(§1 standards, §2 domain conventions, §2a routes/performance/logs/schema, §3 Definition of
Done, §4 task workflow and commits, §6 environment).

## 1. Owner's standards (verbatim)

- Follow consistent naming conventions for files, variables, and functions.
- Every function/class name should define its purpose clearly.
- Keep functions and components small and focused on a single responsibility.
- Every feature should be decoupled and modular, promoting reusability and maintainability.
- Use DRY (Don't Repeat Yourself) principles to avoid code duplication.
- All DB queries must be raw SQL queries.
- Use standard helper response objects for API responses to maintain consistency.
- Use Controller → Validation → Service → Repository pattern to organize the flow of data and business logic consistently.
- The controller only handles the incoming request, invokes the appropriate validation and service methods, and returns the response.
- The service layer contains the core business logic and orchestrates calls to the repository layer.
- The repository layer is responsible for direct data access, such as database queries, and must not contain business logic.
- Validation is performed before reaching the service layer to ensure data integrity and prevent unnecessary processing.
- Errors and exceptions are handled gracefully at the appropriate layer, with meaningful messages returned to the client.
- Each controller function has its own dedicated validation and service methods.
- Every page has a proper route, and every route has matching permissions.
- The `docs/` folder is updated with every new requirement and change; proper logs are maintained.
- Use basic and best LLD principles to keep the application stable and fast.
- Use proper caching, load management and the singleton pattern.

## 2. Concrete rules and Definition of Done

See [`agent.md`](../../agent.md) — the single source. Do not repeat its rules here.

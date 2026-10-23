# REQ-<NNN> Low-Level Design

Authors: developer-backend, developer-frontend · BRD version: <n>

## 1. Traceability
| BRD item | Backend parts | Frontend parts | Test ids |
|---|---|---|---|

## 2. Backend (per API action)
| Action | Method + URL | Validator | Service function | Repository function(s) | Permission | Errors |
|---|---|---|---|---|---|---|

### SQL (repository)
```sql
-- parameterized shape of each query; timestamps use UTC_TIMESTAMP(3)
```

### Schema / migration
- New migration: `prisma/migrations/<timestamp>_<name>/` — tables, columns (type, length, collation), indexes
- Backward compatible? yes/no — why

### Caching
| Cache key | Data | TTL | Invalidated by |
|---|---|---|---|

### Logging, activity log, notifications
- Log events: …
- logActivity entries: …
- Notifications: …

### Concurrency
- Which actions can two users do at once, and how it is guarded (transaction, guarded UPDATE, 409)

## 3. Frontend (per page)
| URL | File | Gate (permission) | Sidebar | Components (new / reused) | Data calls + query key | States |
|---|---|---|---|---|---|---|

## 4. Risks and rollback
- …

## 5. Open questions
- …

# Reflex — One-Page Trade-off Log

| Trade-off | Why accepted | Future improvement |
|---|---|---|
| JSON file instead of a database | Very simple prototype persistence; easy to inspect/reset during a demo. | Move to production database with indexes, backups, migrations and concurrency control. |
| Simple demo authentication | Keeps the sprint focused on the delivery workflow. | Add password hashing, sessions/JWT, authorization and secret management. |
| No real-time notifications | Avoids extra infrastructure while proving the core workflow. | Add WebSockets/SSE or a notification service. |
| Single-process backend | Easy to run and explain. | Add monitoring, shared persistence and scalable deployment. |
| Basic rider assignment | Enough to demonstrate dispatcher ownership of assignment. | Add rider availability, workload balancing and assignment history. |

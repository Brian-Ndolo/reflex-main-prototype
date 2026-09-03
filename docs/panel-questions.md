# Reflex — Likely Panel Questions

### Why did you avoid a database?
“For this prototype I used a JSON file as the persistence layer. It keeps the data transparent and easy to reset while the API keeps storage replaceable.”

### Is JSON production-ready?
“No. It is a deliberate prototype trade-off. Production would require shared persistent storage, concurrency control, backups and stronger security.”

### Why use an API if the data is only a file?
“It separates the frontend from storage, so the UI can later use a real database without redesigning the workflow.”

### What if two dispatchers assign the same job?
“The prototype does not fully solve concurrent assignment. In production I would enforce atomic assignment at the persistence layer and record assignment history.”

### What if the rider loses internet?
“That is not implemented in this prototype. I would investigate offline-first synchronization and conflict resolution before production.”

### Why these statuses?
“They represent the core operational journey: created, assigned, collected and completed.”

### What is the biggest weakness?
“Prototype-grade persistence and authentication. Both are deliberately simplified and documented.”

### How would you scale?
“Move to production persistence, add secure authentication and authorization, indexes and monitoring, then scale based on measured load.”

### What would you build next?
“Secure authentication, real-time notifications, rider availability, assignment history, audit logs and production persistence.”

### If you do not know:
“I don't know the exact answer yet, but I would identify the requirement, research the viable options, test them and use the evidence to choose.”

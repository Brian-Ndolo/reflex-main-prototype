# Reflex Architecture

**Frontend:** HTML/CSS/JavaScript role-based interface.

**Backend:** Node.js + Express REST API.

**Prototype persistence:** `backend/data/db.json`.

Flow:
**Retailer UI → Express API → JSON data store → Dispatcher/Rider UI**

The API creates a storage boundary so the frontend can later remain unchanged if JSON is replaced by a database.

Data:
- User: id, name, role, email, password (demo-only)
- Delivery: id, retailerId, customerName, customerPhone, address, item, riderId, status, timestamps

Status rule:
**Open → Assigned → Picked Up → Delivered**

The API rejects backwards status movement and prevents reassignment of delivered jobs.

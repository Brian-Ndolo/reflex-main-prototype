# Reflex — Submission-Ready Prototype

## Purpose
Reflex is a lightweight delivery-management prototype for small retailers. The core flow is:

**Retailer creates delivery → Dispatcher assigns rider → Rider updates status → Delivery reaches Delivered**

Core statuses: **Open → Assigned → Picked Up → Delivered**

## Storage choice
There is deliberately **no database server** in this version. The backend uses:

`backend/data/db.json`

The Express API reads and writes this JSON file. The frontend never accesses the file directly.

## Run
1. Install Node.js.
2. Open this folder in a terminal.
3. Run `npm install`
4. Run `npm start`
5. Open `http://localhost:3000`

Demo password: `123456`

Accounts:
- Retailer: retailer@reflex.test
- Dispatcher: dispatcher@reflex.test
- Rider: rider@reflex.test

## Submission documents
- `Reflex_Executive_Presentation.pptx`
- `docs/architecture.md`
- `docs/trade-off-log.md`
- `docs/demo-script.md`
- `docs/timing-log.md`
- `docs/panel-questions.md`
- `docs/submission-checklist.md`

## Important
The JSON file is a deliberate prototype trade-off. It is not presented as production-grade persistence. A production version would need proper authentication, authorization, concurrent-write handling, backups, auditing, monitoring and scalable persistent storage.


## Simple delivery workflow
1. The business owner creates a delivery.
2. The order appears as **Open**.
3. Riders see open deliveries and tap **Accept delivery**.
4. The rider taps **Package picked up**.
5. The rider taps **Start delivery**.
6. After handing over the package, the rider taps **Mark delivered**.
7. The business owner's dashboard updates automatically and shows the current status and delivery history.

The interface uses a simple burgundy, white and black theme and keeps the business-owner dashboard intentionally small and easy to understand.

# To-Do List Web Application

A simple to-do list app built with **Node.js + Express** and a plain **HTML/CSS/JavaScript** frontend.
Tasks are stored in an **Amazon DynamoDB** table (default name `todo-tasks`), so they survive restarts and
redeployments, and every container behind the load balancer sees the same list.

---

## 1. Project structure

```
to-do application/
├── server.js           # Express server + REST API
├── package.json        # Project info and dependencies
├── seed-tasks.json     # Example tasks, in DynamoDB batch-write format
├── AWS-SETUP.md        # AWS CLI runbook: create the ECS/DynamoDB resources for the pipeline
├── Dockerfile          # Container image definition
├── .dockerignore
├── .gitignore
├── README.md           # This file
└── public/             # Frontend served as static files
    ├── index.html      # Page structure
    ├── style.css       # Styling (brand colours, hover effects, states)
    ├── script.js       # Fetch calls + rendering + filters + cursor effects
    └── images/
        └── logo.png    # Aviz Academy logo (shown in the sticky header)
```

---

## 2. How to run the application

The app reads these environment variables:

| Variable | Default | Purpose |
|---|---|---|
| `PORT` | `3000` | HTTP port |
| `TABLE_NAME` | `todo-tasks` | DynamoDB table (partition key `id`, type String) |
| `AWS_REGION` | — | Region of the table |
| `DYNAMODB_ENDPOINT` | — | Optional, e.g. `http://localhost:8000` for DynamoDB Local |

AWS credentials come from the usual places: `~/.aws`, environment variables, or the ECS task role.

### Create the table (once)

```bash
aws dynamodb create-table --table-name todo-tasks \
  --attribute-definitions AttributeName=id,AttributeType=S \
  --key-schema AttributeName=id,KeyType=HASH \
  --billing-mode PAY_PER_REQUEST
```

Optionally load the example tasks:

```bash
aws dynamodb batch-write-item --request-items file://seed-tasks.json
```

### Option A — Run with Node.js

Requirements: Node.js 18 or newer.

```bash
npm install
AWS_REGION=ap-south-1 npm start
```

Then open <http://localhost:3000> in a browser.

### Option B — Run with Docker

```bash
docker build -t todo-app .
docker run -p 3000:3000 -e AWS_REGION=ap-south-1 -v ~/.aws:/home/node/.aws:ro todo-app
```

Open <http://localhost:3000>.

### Option C — Fully local with DynamoDB Local (no AWS account needed)

```bash
docker run -d -p 8000:8000 --name dynamodb-local amazon/dynamodb-local
export AWS_REGION=us-east-1 AWS_ACCESS_KEY_ID=local AWS_SECRET_ACCESS_KEY=local
aws dynamodb create-table --endpoint-url http://localhost:8000 --table-name todo-tasks \
  --attribute-definitions AttributeName=id,AttributeType=S \
  --key-schema AttributeName=id,KeyType=HASH --billing-mode PAY_PER_REQUEST
aws dynamodb batch-write-item --endpoint-url http://localhost:8000 --request-items file://seed-tasks.json
DYNAMODB_ENDPOINT=http://localhost:8000 npm start
```

---

## 3. Features

| Requirement | How it works |
|---|---|
| Create / edit / delete tasks | Form at the top of the page; **Edit** loads a task into the form, **Delete** removes it |
| Task fields | Title (required), Description (optional), Due date (required), Status |
| Default status | Every new task is saved as `pending` |
| Checkbox completes a task | Clicking the checkbox calls `PATCH /api/tasks/:id/toggle` |
| Completed tasks look different | Green background, strike-through title, faded, and sorted below pending tasks |
| Bring a task back to pending | Un-tick the same checkbox — the toggle works both ways |
| Filters | **All / Pending / Completed** buttons above the list, each with a live count |
| Overdue highlight | See below |

### Look and feel

- The **Aviz Academy logo** and the subtitle *"Aviz Academy &ndash; Batch 10 Docker Demo"* sit in a
  sticky header, so they stay visible while you scroll.
- Colours are taken from the logo: navy blue, orange and sky blue.
- Hover effects that respond to the pointer:
  - a soft halo follows the mouse around the page;
  - cards and task rows show a spotlight that tracks the cursor, and lift slightly;
  - the **Add task** button has a light sweep, and Edit/Delete fade in on the row you point at;
  - the logo, checkboxes and filter buttons all react on hover.
- Task rows fade in one after another, and a newly added or edited task pulses once.
- Everything is plain CSS and vanilla JavaScript &mdash; no frameworks or build step.
- Animations are switched off automatically for users who set *reduce motion* in their OS.

### Overdue and due-soon highlighting

The app uses a **3-day window**:

- **Red** — the due date has already passed and the task is still pending (badge: *Overdue by N days*).
- **Amber** — the task is due today or within the next **3 days** (badge: *Due today* / *Due in N days*).
- **Blue** — pending, more than 3 days away.
- **Green** — completed (no overdue highlight, since it is already done).

The window is set by the `OVERDUE_DAYS` constant near the top of `server.js`.

---

## 4. Task format

Each task is one item in the DynamoDB table and looks like this:

```json
{
  "id": "6f1c2b7e-3a43-4c55-9f0e-1d2b3c4d5e6f",
  "title": "Submit project report",
  "description": "Final version of the batch 10 project report",
  "dueDate": "2026-08-30",
  "status": "pending",
  "createdAt": "2026-08-25T09:00:00.000Z"
}
```

`id` is a UUID generated when the task is created. `status` is either `"pending"` or `"completed"`.
`dueDate` uses the `YYYY-MM-DD` format.

API responses add three calculated fields that are **not** stored in the table:
`daysLeft`, `isOverdue`, `isDueSoon`.

The page loads every task with one `GET /api/tasks` call and then filters in the browser,
so the counts on the filter buttons always show the totals. The `?status=` query below is
still available for API users.

---

## 5. API endpoints

Base URL: `http://localhost:3000`

| Method | Endpoint | Purpose |
|---|---|---|
| `GET` | `/health` | Health check for the load balancer (does not call DynamoDB) |
| `GET` | `/api/tasks` | List all tasks |
| `GET` | `/api/tasks?status=pending` | List pending tasks only |
| `GET` | `/api/tasks?status=completed` | List completed tasks only |
| `GET` | `/api/tasks/:id` | Get one task |
| `POST` | `/api/tasks` | Create a task (always starts as `pending`) |
| `PUT` | `/api/tasks/:id` | Update title / description / dueDate / status |
| `PATCH` | `/api/tasks/:id/toggle` | Complete a task, or move it back to pending |
| `DELETE` | `/api/tasks/:id` | Delete a task |

### Examples

**Create a task**

```bash
curl -X POST http://localhost:3000/api/tasks \
  -H "Content-Type: application/json" \
  -d '{"title":"Buy groceries","description":"Milk and rice","dueDate":"2026-09-10"}'
```

**Update a task**

```bash
curl -X PUT http://localhost:3000/api/tasks/1 \
  -H "Content-Type: application/json" \
  -d '{"title":"Submit final report","dueDate":"2026-09-15"}'
```

**Complete a task (or send it back to pending)**

```bash
curl -X PATCH http://localhost:3000/api/tasks/1/toggle
```

**Delete a task**

```bash
curl -X DELETE http://localhost:3000/api/tasks/1
```

### Error responses

| Status | When |
|---|---|
| `400` | Missing title, missing/invalid due date, or an invalid status value |
| `404` | No task exists with the given id |
| `500` | DynamoDB could not be reached (check region, credentials, table name) |

// Simple To-Do list API + static frontend.
// Storage: an Amazon DynamoDB table (one item per task, partition key "id").

const express = require('express');
const path = require('path');
const crypto = require('crypto');
const { DynamoDBClient } = require('@aws-sdk/client-dynamodb');
const {
  DynamoDBDocumentClient,
  ScanCommand,
  GetCommand,
  PutCommand,
  DeleteCommand
} = require('@aws-sdk/lib-dynamodb');

const app = express();
const PORT = process.env.PORT || 3000;
const TABLE_NAME = process.env.TABLE_NAME || 'todo-tasks';

// Region and credentials come from the environment (on ECS: AWS_REGION and
// the task role). Set DYNAMODB_ENDPOINT=http://localhost:8000 to use
// DynamoDB Local instead of AWS.
const db = DynamoDBDocumentClient.from(
  new DynamoDBClient(process.env.DYNAMODB_ENDPOINT ? { endpoint: process.env.DYNAMODB_ENDPOINT } : {}),
  { marshallOptions: { removeUndefinedValues: true } }
);

// "Due soon / overdue" window, in days.
const OVERDUE_DAYS = 3;

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

/* ---------------------------------------------------------------
   Reading / writing the DynamoDB table
   --------------------------------------------------------------- */

// Whole table. Scan returns at most 1 MB per call, so follow the pages.
async function readTasks() {
  const tasks = [];
  let startKey;
  do {
    const page = await db.send(new ScanCommand({ TableName: TABLE_NAME, ExclusiveStartKey: startKey }));
    tasks.push(...page.Items);
    startKey = page.LastEvaluatedKey;
  } while (startKey);
  return tasks;
}

async function readTask(id) {
  const { Item } = await db.send(new GetCommand({ TableName: TABLE_NAME, Key: { id } }));
  return Item;
}

async function writeTask(task) {
  await db.send(new PutCommand({ TableName: TABLE_NAME, Item: task }));
}

// Returns the deleted task, or undefined if there was none.
async function deleteTask(id) {
  const { Attributes } = await db.send(
    new DeleteCommand({ TableName: TABLE_NAME, Key: { id }, ReturnValues: 'ALL_OLD' })
  );
  return Attributes;
}

/* ---------------------------------------------------------------
   Helpers
   --------------------------------------------------------------- */

// Whole days from today until the due date. Negative = already past.
function daysUntil(dueDate) {
  if (!dueDate) return null;
  const due = new Date(dueDate + 'T00:00:00');
  if (isNaN(due.getTime())) return null;

  const today = new Date();
  today.setHours(0, 0, 0, 0);

  return Math.round((due - today) / (1000 * 60 * 60 * 24));
}

// Adds the fields the UI needs but that we do not store in the table.
function decorate(task) {
  const days = daysUntil(task.dueDate);
  const open = task.status !== 'completed';

  return {
    ...task,
    daysLeft: days,
    // Past the due date and still not done.
    isOverdue: open && days !== null && days < 0,
    // Due within the next OVERDUE_DAYS days.
    isDueSoon: open && days !== null && days >= 0 && days <= OVERDUE_DAYS
  };
}

function isValidDate(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(value) && !isNaN(new Date(value).getTime());
}

// Express 4 does not catch rejected promises -- pass them to the error handler.
const asyncRoute = (handler) => (req, res, next) => handler(req, res).catch(next);

/* ---------------------------------------------------------------
   API routes
   --------------------------------------------------------------- */

// GET /health -> load balancer / container health check (does not touch DynamoDB)
app.get('/health', (req, res) => {
  res.json({ status: 'ok' });
});

// GET /api/tasks              -> all tasks
// GET /api/tasks?status=pending | completed
app.get('/api/tasks', asyncRoute(async (req, res) => {
  let tasks = await readTasks();

  const status = req.query.status;
  if (status === 'pending' || status === 'completed') {
    tasks = tasks.filter((t) => t.status === status);
  }

  res.json(tasks.map(decorate));
}));

// GET /api/tasks/:id -> one task
app.get('/api/tasks/:id', asyncRoute(async (req, res) => {
  const task = await readTask(req.params.id);
  if (!task) return res.status(404).json({ error: 'Task not found' });
  res.json(decorate(task));
}));

// POST /api/tasks -> create a task (always starts as "pending")
app.post('/api/tasks', asyncRoute(async (req, res) => {
  const { title, description, dueDate } = req.body || {};

  if (!title || !String(title).trim()) {
    return res.status(400).json({ error: 'Title is required' });
  }
  if (!dueDate || !isValidDate(dueDate)) {
    return res.status(400).json({ error: 'Due date is required (YYYY-MM-DD)' });
  }

  const task = {
    id: crypto.randomUUID(),
    title: String(title).trim(),
    description: description ? String(description).trim() : '',
    dueDate: dueDate,
    status: 'pending',
    createdAt: new Date().toISOString()
  };

  await writeTask(task);

  res.status(201).json(decorate(task));
}));

// PUT /api/tasks/:id -> edit a task (title / description / dueDate / status)
app.put('/api/tasks/:id', asyncRoute(async (req, res) => {
  const task = await readTask(req.params.id);
  if (!task) return res.status(404).json({ error: 'Task not found' });

  const { title, description, dueDate, status } = req.body || {};

  if (title !== undefined) {
    if (!String(title).trim()) {
      return res.status(400).json({ error: 'Title cannot be empty' });
    }
    task.title = String(title).trim();
  }

  if (description !== undefined) {
    task.description = description ? String(description).trim() : '';
  }

  if (dueDate !== undefined) {
    if (!isValidDate(dueDate)) {
      return res.status(400).json({ error: 'Due date must be YYYY-MM-DD' });
    }
    task.dueDate = dueDate;
  }

  if (status !== undefined) {
    if (status !== 'pending' && status !== 'completed') {
      return res.status(400).json({ error: 'Status must be "pending" or "completed"' });
    }
    task.status = status;
  }

  await writeTask(task);
  res.json(decorate(task));
}));

// PATCH /api/tasks/:id/toggle -> flip pending <-> completed (the checkbox)
app.patch('/api/tasks/:id/toggle', asyncRoute(async (req, res) => {
  const task = await readTask(req.params.id);
  if (!task) return res.status(404).json({ error: 'Task not found' });

  task.status = task.status === 'completed' ? 'pending' : 'completed';

  await writeTask(task);
  res.json(decorate(task));
}));

// DELETE /api/tasks/:id -> remove a task
app.delete('/api/tasks/:id', asyncRoute(async (req, res) => {
  const removed = await deleteTask(req.params.id);
  if (!removed) return res.status(404).json({ error: 'Task not found' });

  res.json({ message: 'Task deleted', task: removed });
}));

// Anything that threw above (e.g. DynamoDB unreachable or access denied).
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Storage error' });
});

/* ---------------------------------------------------------------
   Start
   --------------------------------------------------------------- */

app.listen(PORT, () => {
  console.log(`To-Do app running at http://localhost:${PORT} (DynamoDB table: ${TABLE_NAME})`);
});

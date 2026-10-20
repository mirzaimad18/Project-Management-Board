const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { promisify } = require('node:util');
const express = require('express');
const cors = require('cors');
const sqlite3 = require('sqlite3').verbose();
const WebSocket = require('ws');

const app = express();
const port = Number(process.env.PORT) || 5002;
const server = http.createServer(app);
const webSocketServer = new WebSocket.Server({ server });
const databasePath =
  process.env.DATABASE_PATH || path.join(__dirname, 'project_management.db');
const db = new sqlite3.Database(databasePath);
const taskStatuses = ['To Do', 'In Progress', 'Done'];
const scrypt = promisify(crypto.scrypt);
const sessionLifetimeMs = 30 * 24 * 60 * 60 * 1000;

app.use(cors());
app.use(express.json());

function run(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.run(sql, params, function (error) {
      if (error) {
        reject(error);
        return;
      }

      resolve({ id: this.lastID, changes: this.changes });
    });
  });
}

function get(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.get(sql, params, (error, row) => {
      if (error) {
        reject(error);
        return;
      }

      resolve(row);
    });
  });
}

function all(sql, params = []) {
  return new Promise((resolve, reject) => {
    db.all(sql, params, (error, rows) => {
      if (error) {
        reject(error);
        return;
      }

      resolve(rows);
    });
  });
}

function isPositiveInteger(value) {
  return Number.isInteger(value) && value > 0;
}

function getPositiveId(value) {
  const id = Number(value);
  return isPositiveInteger(id) ? id : null;
}

function getTrimmedString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

function sendNotFound(res, message) {
  return res.status(404).json({ error: message });
}

function hashToken(token) {
  return crypto.createHash('sha256').update(token).digest('hex');
}

async function hashPassword(password) {
  const salt = crypto.randomBytes(16);
  const derivedKey = await scrypt(password, salt, 64);
  return `${salt.toString('hex')}:${derivedKey.toString('hex')}`;
}

async function verifyPassword(password, storedHash) {
  const [saltHex, keyHex] = storedHash.split(':');
  if (!saltHex || !keyHex) return false;

  const expected = Buffer.from(keyHex, 'hex');
  const actual = await scrypt(password, Buffer.from(saltHex, 'hex'), expected.length);
  return expected.length === actual.length && crypto.timingSafeEqual(expected, actual);
}

async function createSession(userId) {
  const token = crypto.randomBytes(32).toString('hex');
  const expiresAt = new Date(Date.now() + sessionLifetimeMs).toISOString();
  await run(
    'INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)',
    [hashToken(token), userId, expiresAt]
  );
  return token;
}

async function requireAuthentication(req, res, next) {
  const authorization = req.get('authorization') || '';
  const match = /^Bearer ([a-f0-9]{64})$/i.exec(authorization);
  if (!match) return res.status(401).json({ error: 'Sign in to continue.' });

  try {
    const session = await get(
      `SELECT users.id, users.name, users.email, sessions.token_hash
       FROM sessions
       JOIN users ON users.id = sessions.user_id
       WHERE sessions.token_hash = ? AND sessions.expires_at > ?`,
      [hashToken(match[1]), new Date().toISOString()]
    );
    if (!session) return res.status(401).json({ error: 'Session is invalid or expired.' });

    req.user = { id: session.id, name: session.name, email: session.email };
    req.sessionTokenHash = session.token_hash;
    next();
  } catch (error) {
    next(error);
  }
}

async function isProjectMember(projectId, userId) {
  return Boolean(
    await get(
      'SELECT 1 FROM project_members WHERE project_id = ? AND user_id = ?',
      [projectId, userId]
    )
  );
}

async function addNotification(userId, projectId, message, type) {
  const result = await run(
    `INSERT INTO notifications (user_id, project_id, message, type)
     VALUES (?, ?, ?, ?)`,
    [userId, projectId, message, type]
  );
  const notification = await get(
    `SELECT id, user_id, project_id, message, type, is_read, created_at
     FROM notifications WHERE id = ?`,
    [result.id]
  );
  for (const client of webSocketServer.clients) {
    if (
      client.readyState === WebSocket.OPEN &&
      client.userId === userId
    ) {
      client.send(JSON.stringify({ type: 'notification', notification }));
    }
  }
  return notification;
}

function broadcastProjectUpdate(projectId, event, data = {}, actorUserId) {
  const payload = JSON.stringify({ type: 'project-update', event, projectId, actorUserId, ...data });
  for (const client of webSocketServer.clients) {
    if (client.readyState === WebSocket.OPEN && client.projectId === projectId) {
      client.send(payload);
    }
  }
}

async function initializeDatabase() {
  await new Promise((resolve, reject) => {
    db.exec('PRAGMA foreign_keys = ON;', (error) => {
      if (error) reject(error);
      else resolve();
    });
  });

  await new Promise((resolve, reject) => {
    db.exec(
      `CREATE TABLE IF NOT EXISTS users (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        email TEXT NOT NULL UNIQUE,
        password_hash TEXT,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS projects (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
      );

      CREATE TABLE IF NOT EXISTS tasks (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        project_id INTEGER NOT NULL,
        title TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        assigned_to INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'To Do'
          CHECK (status IN ('To Do', 'In Progress', 'Done')),
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
        FOREIGN KEY (assigned_to) REFERENCES users(id)
      );

      CREATE TABLE IF NOT EXISTS comments (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        task_id INTEGER NOT NULL,
        user_id INTEGER NOT NULL,
        content TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (task_id) REFERENCES tasks(id) ON DELETE CASCADE,
        FOREIGN KEY (user_id) REFERENCES users(id)
      );

      CREATE TABLE IF NOT EXISTS sessions (
        token_hash TEXT PRIMARY KEY,
        user_id INTEGER NOT NULL,
        expires_at TEXT NOT NULL,
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS project_members (
        project_id INTEGER NOT NULL,
        user_id INTEGER NOT NULL,
        role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('owner', 'member')),
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (project_id, user_id),
        FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
      );

      CREATE TABLE IF NOT EXISTS notifications (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        project_id INTEGER,
        message TEXT NOT NULL,
        type TEXT NOT NULL,
        is_read INTEGER NOT NULL DEFAULT 0 CHECK (is_read IN (0, 1)),
        created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE,
        FOREIGN KEY (project_id) REFERENCES projects(id) ON DELETE CASCADE
      );`,
      (error) => {
        if (error) reject(error);
        else resolve();
      }
    );
  });

  const userColumns = await all('PRAGMA table_info(users)');
  if (!userColumns.some((column) => column.name === 'password_hash')) {
    await run('ALTER TABLE users ADD COLUMN password_hash TEXT');
  }

  const projectCount = await get('SELECT COUNT(*) AS count FROM projects');
  if (projectCount.count > 0) return;

  await run('BEGIN TRANSACTION');
  try {
    await run(
      'INSERT OR IGNORE INTO users (name, email) VALUES (?, ?)',
      ['Alex Morgan', 'alex@example.com']
    );
    await run(
      'INSERT OR IGNORE INTO users (name, email) VALUES (?, ?)',
      ['Jamie Lee', 'jamie@example.com']
    );

    const alex = await get('SELECT id FROM users WHERE email = ?', ['alex@example.com']);
    const jamie = await get('SELECT id FROM users WHERE email = ?', ['jamie@example.com']);

    const project = await run(
      'INSERT INTO projects (name, description) VALUES (?, ?)',
      ['Website Redesign', 'Plan and deliver the company website redesign.']
    );
    const wireframes = await run(
      `INSERT INTO tasks (project_id, title, description, assigned_to, status)
       VALUES (?, ?, ?, ?, ?)`,
      [project.id, 'Design Wireframes', 'Create wireframes for the key pages.', alex.id, 'In Progress']
    );
    const api = await run(
      `INSERT INTO tasks (project_id, title, description, assigned_to, status)
       VALUES (?, ?, ?, ?, ?)`,
      [project.id, 'Setup API', 'Set up the API required by the redesigned site.', jamie.id, 'To Do']
    );

    await run(
      'INSERT INTO comments (task_id, user_id, content) VALUES (?, ?, ?)',
      [wireframes.id, alex.id, 'I will share the first wireframe draft soon.']
    );
    await run(
      'INSERT INTO comments (task_id, user_id, content) VALUES (?, ?, ?)',
      [api.id, jamie.id, 'I am reviewing the API requirements.']
    );
    await run('COMMIT');
  } catch (error) {
    await run('ROLLBACK');
    throw error;
  }
}

app.post('/api/auth/register', async (req, res) => {
  const name = getTrimmedString(req.body?.name);
  const email = getTrimmedString(req.body?.email).toLowerCase();
  const password = req.body?.password;
  if (!name || name.length > 80 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'Enter a name and valid email address.' });
  }
  if (typeof password !== 'string' || password.length < 8 || password.length > 128) {
    return res.status(400).json({ error: 'Password must be between 8 and 128 characters.' });
  }

  const existingUser = await get(
    'SELECT id, password_hash FROM users WHERE email = ?',
    [email]
  );
  if (existingUser?.password_hash) {
    return res.status(409).json({ error: 'An account with that email already exists.' });
  }

  const passwordHash = await hashPassword(password);
  let userId;
  if (existingUser) {
    await run(
      'UPDATE users SET name = ?, password_hash = ? WHERE id = ?',
      [name, passwordHash, existingUser.id]
    );
    userId = existingUser.id;
  } else {
    const result = await run(
      'INSERT INTO users (name, email, password_hash) VALUES (?, ?, ?)',
      [name, email, passwordHash]
    );
    userId = result.id;
  }
  const projects = await all(
    `SELECT projects.id FROM projects
     WHERE NOT EXISTS (
       SELECT 1 FROM project_members WHERE project_members.project_id = projects.id
     )`
  );
  for (const project of projects) {
    await run(
      `INSERT OR IGNORE INTO project_members (project_id, user_id, role)
       VALUES (?, ?, 'owner')`,
      [project.id, userId]
    );
  }

  const token = await createSession(userId);
  const user = { id: userId, name, email };
  res.status(201).json({ token, user });
});

app.post('/api/auth/login', async (req, res) => {
  const email = getTrimmedString(req.body?.email).toLowerCase();
  const password = req.body?.password;
  if (!email || typeof password !== 'string') {
    return res.status(400).json({ error: 'Email and password are required.' });
  }

  const user = await get(
    'SELECT id, name, email, password_hash FROM users WHERE email = ?',
    [email]
  );
  if (!user?.password_hash || !(await verifyPassword(password, user.password_hash))) {
    return res.status(401).json({ error: 'Email or password is incorrect.' });
  }

  const token = await createSession(user.id);
  res.json({ token, user: { id: user.id, name: user.name, email: user.email } });
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'index.html'));
});

webSocketServer.on('connection', (socket) => {
  const authenticationTimeout = setTimeout(() => socket.close(4401, 'Authentication required'), 5000);

  socket.on('message', async (message) => {
    let payload;
    try {
      payload = JSON.parse(message.toString());
    } catch {
      socket.close(4400, 'Invalid message');
      return;
    }

    try {
      if (!socket.userId) {
        if (payload.type !== 'authenticate' || typeof payload.token !== 'string') {
          socket.close(4401, 'Authentication required');
          return;
        }
        const session = await get(
          `SELECT users.id FROM sessions
           JOIN users ON users.id = sessions.user_id
           WHERE sessions.token_hash = ? AND sessions.expires_at > ?`,
          [hashToken(payload.token), new Date().toISOString()]
        );
        if (!session) {
          socket.close(4401, 'Invalid session');
          return;
        }
        socket.userId = session.id;
        clearTimeout(authenticationTimeout);
        socket.send(JSON.stringify({ type: 'authenticated' }));
        if (getPositiveId(payload.projectId)) {
          const projectId = getPositiveId(payload.projectId);
          if (await isProjectMember(projectId, socket.userId)) socket.projectId = projectId;
        }
        return;
      }

      if (payload.type === 'subscribe') {
        const projectId = getPositiveId(payload.projectId);
        if (projectId && await isProjectMember(projectId, socket.userId)) {
          socket.projectId = projectId;
          socket.send(JSON.stringify({ type: 'subscribed', projectId }));
        }
      }
    } catch (error) {
      console.error('WebSocket message failed:', error);
      socket.close(1011, 'Internal error');
    }
  });

  socket.on('close', () => clearTimeout(authenticationTimeout));
  socket.on('error', (error) => console.error('WebSocket error:', error));
});

app.use('/api', requireAuthentication);

app.get('/api/auth/me', (req, res) => res.json({ user: req.user }));

app.post('/api/auth/logout', async (req, res) => {
  await run('DELETE FROM sessions WHERE token_hash = ?', [req.sessionTokenHash]);
  for (const client of webSocketServer.clients) {
    if (client.userId === req.user.id) client.close(4401, 'Session ended');
  }
  res.json({ success: true });
});

app.get('/api/projects', async (req, res) => {
  const projects = await all(
    `SELECT projects.id, projects.name, projects.description, projects.created_at,
            project_members.role
     FROM projects
     JOIN project_members ON project_members.project_id = projects.id
     WHERE project_members.user_id = ?
     ORDER BY projects.id`,
    [req.user.id]
  );
  res.json(projects);
});

app.post('/api/projects', async (req, res) => {
  const name = getTrimmedString(req.body?.name);
  const description = getTrimmedString(req.body?.description);
  if (!name) return res.status(400).json({ error: 'Project name is required.' });

  const result = await run(
    'INSERT INTO projects (name, description) VALUES (?, ?)',
    [name, description]
  );
  await run(
    `INSERT INTO project_members (project_id, user_id, role)
     VALUES (?, ?, 'owner')`,
    [result.id, req.user.id]
  );
  const project = await get(
    'SELECT id, name, description, created_at, ? AS role FROM projects WHERE id = ?',
    ['owner', result.id]
  );
  broadcastProjectUpdate(result.id, 'project-created', {}, req.user.id);
  res.status(201).json(project);
});

app.get('/api/projects/:id/members', async (req, res) => {
  const projectId = getPositiveId(req.params.id);
  if (!projectId) return res.status(400).json({ error: 'Project ID must be a positive integer.' });
  if (!(await isProjectMember(projectId, req.user.id))) {
    return sendNotFound(res, 'Project not found.');
  }

  const members = await all(
    `SELECT users.id, users.name, users.email, project_members.role
     FROM project_members
     JOIN users ON users.id = project_members.user_id
     WHERE project_members.project_id = ? AND users.password_hash IS NOT NULL
     ORDER BY users.name`,
    [projectId]
  );
  res.json(members);
});

app.post('/api/projects/:id/members', async (req, res) => {
  const projectId = getPositiveId(req.params.id);
  const email = getTrimmedString(req.body?.email).toLowerCase();
  if (!projectId || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    return res.status(400).json({ error: 'Project ID and a valid member email are required.' });
  }
  if (!(await isProjectMember(projectId, req.user.id))) {
    return sendNotFound(res, 'Project not found.');
  }

  const user = await get(
    'SELECT id, name, email FROM users WHERE email = ? AND password_hash IS NOT NULL',
    [email]
  );
  if (!user) return sendNotFound(res, 'No registered account exists for that email yet.');
  if (await isProjectMember(projectId, user.id)) {
    return res.status(409).json({ error: 'That user is already a project member.' });
  }

  await run(
    `INSERT INTO project_members (project_id, user_id, role)
     VALUES (?, ?, 'member')`,
    [projectId, user.id]
  );
  const project = await get('SELECT name FROM projects WHERE id = ?', [projectId]);
  await addNotification(
    user.id,
    projectId,
    `${req.user.name} added you to ${project.name}.`,
    'project-invite'
  );
  broadcastProjectUpdate(projectId, 'member-added', {}, req.user.id);
  res.status(201).json({ ...user, role: 'member' });
});

app.get('/api/projects/:id/tasks', async (req, res) => {
  const projectId = getPositiveId(req.params.id);
  if (!projectId) return res.status(400).json({ error: 'Project ID must be a positive integer.' });
  if (!(await isProjectMember(projectId, req.user.id))) {
    return sendNotFound(res, 'Project not found.');
  }

  const tasks = await all(
    `SELECT tasks.id, tasks.project_id, tasks.title, tasks.description,
            tasks.assigned_to, users.name AS assignee_name, tasks.status, tasks.created_at
     FROM tasks
     JOIN users ON users.id = tasks.assigned_to
     WHERE tasks.project_id = ?
     ORDER BY tasks.id`,
    [projectId]
  );
  const comments = await all(
    `SELECT comments.id, comments.task_id, comments.user_id,
            users.name AS user_name, comments.content, comments.created_at
     FROM comments
     JOIN users ON users.id = comments.user_id
     JOIN tasks ON tasks.id = comments.task_id
     WHERE tasks.project_id = ?
     ORDER BY comments.id`,
    [projectId]
  );
  const commentsByTask = new Map();
  for (const comment of comments) {
    const taskComments = commentsByTask.get(comment.task_id) || [];
    taskComments.push(comment);
    commentsByTask.set(comment.task_id, taskComments);
  }

  res.json(tasks.map((task) => ({
    ...task,
    comments: commentsByTask.get(task.id) || [],
  })));
});

app.get('/api/projects/:id/users', async (req, res) => {
  const projectId = getPositiveId(req.params.id);
  if (!projectId) return res.status(400).json({ error: 'Project ID must be a positive integer.' });
  if (!(await isProjectMember(projectId, req.user.id))) {
    return sendNotFound(res, 'Project not found.');
  }

  const users = await all(
    `SELECT users.id, users.name, users.email
     FROM project_members
     JOIN users ON users.id = project_members.user_id
     WHERE project_members.project_id = ? AND users.password_hash IS NOT NULL
     ORDER BY users.name`,
    [projectId]
  );
  res.json(users);
});

app.post('/api/tasks', async (req, res) => {
  const projectId = getPositiveId(req.body?.projectId ?? req.body?.project_id);
  const assignedTo = getPositiveId(req.body?.assignedTo ?? req.body?.assigned_to);
  const title = getTrimmedString(req.body?.title);
  const description = getTrimmedString(req.body?.description);
  const status = req.body?.status === undefined ? 'To Do' : req.body.status;
  if (!projectId || !assignedTo || !title) {
    return res.status(400).json({ error: 'A positive projectId, title, and assignedTo user ID are required.' });
  }
  if (typeof status !== 'string' || !taskStatuses.includes(status)) {
    return res.status(400).json({ error: `Status must be one of: ${taskStatuses.join(', ')}.` });
  }
  if (!(await isProjectMember(projectId, req.user.id))) {
    return sendNotFound(res, 'Project not found.');
  }
  if (!(await isProjectMember(projectId, assignedTo))) {
    return res.status(400).json({ error: 'Assignee must be a registered project member.' });
  }

  const result = await run(
    `INSERT INTO tasks (project_id, title, description, assigned_to, status)
     VALUES (?, ?, ?, ?, ?)`,
    [projectId, title, description, assignedTo, status]
  );
  const task = await get(
    `SELECT tasks.id, tasks.project_id, tasks.title, tasks.description,
            tasks.assigned_to, users.name AS assignee_name, tasks.status, tasks.created_at
     FROM tasks JOIN users ON users.id = tasks.assigned_to WHERE tasks.id = ?`,
    [result.id]
  );
  if (assignedTo !== req.user.id) {
    const project = await get('SELECT name FROM projects WHERE id = ?', [projectId]);
    await addNotification(assignedTo, projectId, `${req.user.name} assigned you "${title}" in ${project.name}.`, 'task-assigned');
  }
  broadcastProjectUpdate(projectId, 'task-created', {}, req.user.id);
  res.status(201).json({ ...task, comments: [] });
});

app.patch('/api/tasks/:id', async (req, res) => {
  const taskId = getPositiveId(req.params.id);
  const status = req.body?.status;
  if (!taskId) return res.status(400).json({ error: 'Task ID must be a positive integer.' });
  if (typeof status !== 'string' || !taskStatuses.includes(status)) {
    return res.status(400).json({ error: `Status must be one of: ${taskStatuses.join(', ')}.` });
  }

  const task = await get('SELECT id, project_id, title, assigned_to FROM tasks WHERE id = ?', [taskId]);
  if (!task) return sendNotFound(res, 'Task not found.');
  if (!(await isProjectMember(task.project_id, req.user.id))) {
    return sendNotFound(res, 'Task not found.');
  }
  await run('UPDATE tasks SET status = ? WHERE id = ?', [status, taskId]);
  const updatedTask = await get(
    `SELECT tasks.id, tasks.project_id, tasks.title, tasks.description,
            tasks.assigned_to, users.name AS assignee_name, tasks.status, tasks.created_at
     FROM tasks JOIN users ON users.id = tasks.assigned_to WHERE tasks.id = ?`,
    [taskId]
  );
  if (task.assigned_to !== req.user.id) {
    await addNotification(task.assigned_to, task.project_id, `${req.user.name} moved "${task.title}" to ${status}.`, 'task-status');
  }
  broadcastProjectUpdate(task.project_id, 'task-updated', {}, req.user.id);
  res.json(updatedTask);
});

app.post('/api/tasks/:id/comments', async (req, res) => {
  const taskId = getPositiveId(req.params.id);
  const content = getTrimmedString(req.body?.content);
  if (!taskId || !content) {
    return res.status(400).json({ error: 'A positive task ID and comment content are required.' });
  }

  const task = await get('SELECT id, project_id, title FROM tasks WHERE id = ?', [taskId]);
  if (!task) return sendNotFound(res, 'Task not found.');
  if (!(await isProjectMember(task.project_id, req.user.id))) {
    return sendNotFound(res, 'Task not found.');
  }

  const result = await run(
    'INSERT INTO comments (task_id, user_id, content) VALUES (?, ?, ?)',
    [taskId, req.user.id, content]
  );
  const comment = await get(
    `SELECT comments.id, comments.task_id, comments.user_id,
            users.name AS user_name, comments.content, comments.created_at
     FROM comments JOIN users ON users.id = comments.user_id WHERE comments.id = ?`,
    [result.id]
  );
  const members = await all(
    'SELECT user_id FROM project_members WHERE project_id = ? AND user_id != ?',
    [task.project_id, req.user.id]
  );
  for (const member of members) {
    await addNotification(member.user_id, task.project_id, `${req.user.name} commented on "${task.title}".`, 'task-comment');
  }
  broadcastProjectUpdate(task.project_id, 'comment-added', { taskId }, req.user.id);
  res.status(201).json(comment);
});

app.get('/api/notifications', async (req, res) => {
  const notifications = await all(
    `SELECT id, project_id, message, type, is_read, created_at
     FROM notifications WHERE user_id = ? ORDER BY id DESC LIMIT 50`,
    [req.user.id]
  );
  res.json(notifications);
});

app.patch('/api/notifications/read-all', async (req, res) => {
  await run('UPDATE notifications SET is_read = 1 WHERE user_id = ?', [req.user.id]);
  res.json({ success: true });
});

app.patch('/api/notifications/:id/read', async (req, res) => {
  const notificationId = getPositiveId(req.params.id);
  if (!notificationId) return res.status(400).json({ error: 'Notification ID must be a positive integer.' });
  const result = await run(
    'UPDATE notifications SET is_read = 1 WHERE id = ? AND user_id = ?',
    [notificationId, req.user.id]
  );
  if (result.changes === 0) return sendNotFound(res, 'Notification not found.');
  res.json({ success: true });
});

app.use((error, req, res, next) => {
  console.error(error);
  if (res.headersSent) return next(error);

  if (error instanceof SyntaxError && error.status === 400 && 'body' in error) {
    return res.status(400).json({ error: 'Request body must contain valid JSON.' });
  }

  if (error.code === 'SQLITE_CONSTRAINT_UNIQUE') {
    return res.status(409).json({ error: 'A record with that value already exists.' });
  }

  res.status(500).json({ error: 'An unexpected server error occurred.' });
});

initializeDatabase()
  .then(() => {
    server.listen(port, () => {
      console.log(`Project management API and WebSocket server listening on port ${port}`);
    });
  })
  .catch((error) => {
    console.error('Failed to initialize the database:', error);
    db.close(() => {
      process.exitCode = 1;
    });
  });

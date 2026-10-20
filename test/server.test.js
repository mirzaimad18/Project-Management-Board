const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const { once } = require('node:events');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { test } = require('node:test');
const sqlite3 = require('sqlite3');
const WebSocket = require('ws');

const root = path.resolve(__dirname, '..');

async function getAvailablePort() {
  const probe = net.createServer();
  probe.listen(0, '127.0.0.1');
  await once(probe, 'listening');
  const { port } = probe.address();
  await new Promise((resolve, reject) => probe.close((error) => error ? reject(error) : resolve()));
  return port;
}

async function waitForServer(baseUrl, child) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Server exited with code ${child.exitCode}.`);
    try {
      const response = await fetch(`${baseUrl}/api/projects`);
      if (response.status === 401) return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 150));
    }
  }
  throw new Error('Server did not start in time.');
}

async function request(baseUrl, endpoint, { token, ...options } = {}) {
  const response = await fetch(`${baseUrl}/api${endpoint}`, {
    ...options,
    headers: {
      ...(options.body ? { 'Content-Type': 'application/json' } : {}),
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...options.headers,
    },
  });
  const body = await response.json();
  return { response, body };
}

async function register(baseUrl, name, email) {
  const { response, body } = await request(baseUrl, '/auth/register', {
    method: 'POST',
    body: JSON.stringify({ name, email, password: 'long-test-password' }),
  });
  assert.equal(response.status, 201);
  return body;
}

function waitForSocketMessage(socket, type) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      socket.off('message', onMessage);
      reject(new Error(`Timed out waiting for WebSocket ${type} message.`));
    }, 5000);
    function onMessage(data) {
      const message = JSON.parse(data.toString());
      if (message.type !== type) return;
      clearTimeout(timeout);
      socket.off('message', onMessage);
      resolve(message);
    }
    socket.on('message', onMessage);
  });
}

test('authenticated collaborative project API and WebSocket updates work', { timeout: 60000 }, async () => {
  const port = await getAvailablePort();
  const databasePath = path.join(os.tmpdir(), `project-board-test-${process.pid}-${Date.now()}.sqlite`);
  const baseUrl = `http://127.0.0.1:${port}`;
  const child = spawn(process.execPath, ['server.js'], {
    cwd: root,
    env: { ...process.env, DATABASE_PATH: databasePath, PORT: String(port) },
    stdio: 'ignore',
  });
  let aliceSocket;
  let bobSocket;

  try {
    await waitForServer(baseUrl, child);

    const homepage = await fetch(baseUrl);
    assert.equal(homepage.status, 200);
    assert.match(await homepage.text(), /Create your account/);

    const unauthenticated = await request(baseUrl, '/projects');
    assert.equal(unauthenticated.response.status, 401);

    const alice = await register(baseUrl, 'Alice Example', 'alice@example.test');
    const seeded = await request(baseUrl, '/projects', { token: alice.token });
    assert.equal(seeded.response.status, 200);
    assert.equal(seeded.body.length, 1);
    assert.equal(seeded.body[0].name, 'Website Redesign');

    const seededTasks = await request(
      baseUrl,
      `/projects/${seeded.body[0].id}/tasks`,
      { token: alice.token }
    );
    assert.deepEqual(seededTasks.body.map((task) => task.title), ['Design Wireframes', 'Setup API']);
    assert.ok(seededTasks.body.every((task) => task.comments.length > 0));

    const bob = await register(baseUrl, 'Bob Example', 'bob@example.test');
    const alex = await register(baseUrl, 'Alex Example', 'alex@example.com');
    const sampleMember = await request(
      baseUrl,
      `/projects/${seeded.body[0].id}/members`,
      {
        token: alice.token,
        method: 'POST',
        body: JSON.stringify({ email: alex.user.email }),
      }
    );
    assert.equal(sampleMember.response.status, 201);

    const aliceProject = await request(baseUrl, '/projects', {
      token: alice.token,
      method: 'POST',
      body: JSON.stringify({ name: 'Shared Project', description: 'Team integration test' }),
    });
    assert.equal(aliceProject.response.status, 201);

    const beforeInvite = await request(baseUrl, '/projects', { token: bob.token });
    assert.deepEqual(beforeInvite.body, []);
    const blocked = await request(
      baseUrl,
      `/projects/${aliceProject.body.id}/tasks`,
      { token: bob.token }
    );
    assert.equal(blocked.response.status, 404);

    const invite = await request(
      baseUrl,
      `/projects/${aliceProject.body.id}/members`,
      {
        token: alice.token,
        method: 'POST',
        body: JSON.stringify({ email: bob.user.email }),
      }
    );
    assert.equal(invite.response.status, 201);
    const bobProjects = await request(baseUrl, '/projects', { token: bob.token });
    assert.equal(bobProjects.body[0].name, 'Shared Project');

    const projectUsers = await request(
      baseUrl,
      `/projects/${aliceProject.body.id}/users`,
      { token: alice.token }
    );
    assert.equal(projectUsers.body.length, 2);

    bobSocket = new WebSocket(`ws://127.0.0.1:${port}`);
    await once(bobSocket, 'open');
    const bobAuthenticated = waitForSocketMessage(bobSocket, 'authenticated');
    bobSocket.send(JSON.stringify({
      type: 'authenticate',
      token: bob.token,
      projectId: aliceProject.body.id,
    }));
    await bobAuthenticated;
    const assignmentNotification = waitForSocketMessage(bobSocket, 'notification');

    const createdTask = await request(baseUrl, '/tasks', {
      token: alice.token,
      method: 'POST',
      body: JSON.stringify({
        projectId: aliceProject.body.id,
        title: 'Review the release plan',
        assignedTo: bob.user.id,
      }),
    });
    assert.equal(createdTask.response.status, 201);
    assert.equal(createdTask.body.assignee_name, 'Bob Example');
    assert.equal((await assignmentNotification).notification.type, 'task-assigned');

    const invalidAssignment = await request(baseUrl, '/tasks', {
      token: alice.token,
      method: 'POST',
      body: JSON.stringify({
        projectId: aliceProject.body.id,
        title: 'Invalid assignment',
        assignedTo: seededTasks.body[0].assigned_to,
      }),
    });
    assert.equal(invalidAssignment.response.status, 400);

    aliceSocket = new WebSocket(`ws://127.0.0.1:${port}`);
    await once(aliceSocket, 'open');
    const authenticatedMessage = waitForSocketMessage(aliceSocket, 'authenticated');
    aliceSocket.send(JSON.stringify({
      type: 'authenticate',
      token: alice.token,
      projectId: aliceProject.body.id,
    }));
    await authenticatedMessage;
    const projectUpdate = waitForSocketMessage(aliceSocket, 'project-update');

    const statusUpdate = await request(baseUrl, `/tasks/${createdTask.body.id}`, {
      token: bob.token,
      method: 'PATCH',
      body: JSON.stringify({ status: 'In Progress' }),
    });
    assert.equal(statusUpdate.response.status, 200);
    assert.equal(statusUpdate.body.status, 'In Progress');
    assert.equal((await projectUpdate).event, 'task-updated');

    const invalidStatus = await request(baseUrl, `/tasks/${createdTask.body.id}`, {
      token: alice.token,
      method: 'PATCH',
      body: JSON.stringify({ status: 'Blocked' }),
    });
    assert.equal(invalidStatus.response.status, 400);

    const liveCommentNotification = waitForSocketMessage(aliceSocket, 'notification');
    const comment = await request(baseUrl, `/tasks/${createdTask.body.id}/comments`, {
      token: bob.token,
      method: 'POST',
      body: JSON.stringify({ content: 'I will take care of this.' }),
    });
    assert.equal(comment.response.status, 201);
    assert.equal(comment.body.user_name, 'Bob Example');
    assert.equal((await liveCommentNotification).notification.type, 'task-comment');

    const aliceNotifications = await request(baseUrl, '/notifications', { token: alice.token });
    assert.ok(aliceNotifications.body.some((item) => item.type === 'task-comment'));
    const bobNotifications = await request(baseUrl, '/notifications', { token: bob.token });
    assert.ok(bobNotifications.body.some((item) => item.type === 'task-assigned'));

    const wrongPassword = await request(baseUrl, '/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email: 'alice@example.test', password: 'wrong-password' }),
    });
    assert.equal(wrongPassword.response.status, 401);
    const login = await request(baseUrl, '/auth/login', {
      method: 'POST',
      body: JSON.stringify({ email: 'ALICE@example.test', password: 'long-test-password' }),
    });
    assert.equal(login.response.status, 200);
    const socketClosed = once(aliceSocket, 'close');
    const logout = await request(baseUrl, '/auth/logout', {
      token: alice.token,
      method: 'POST',
    });
    assert.equal(logout.response.status, 200);
    assert.equal((await socketClosed)[0], 4401);
    const loggedOutRequest = await request(baseUrl, '/projects', { token: alice.token });
    assert.equal(loggedOutRequest.response.status, 401);
  } finally {
    if (aliceSocket) aliceSocket.close();
    if (bobSocket) bobSocket.close();
    child.kill();
    await new Promise((resolve) => {
      if (child.exitCode !== null) return resolve();
      const timeout = setTimeout(resolve, 3000);
      child.once('exit', () => {
        clearTimeout(timeout);
        resolve();
      });
    });
    for (const suffix of ['', '-wal', '-shm']) {
      const file = `${databasePath}${suffix}`;
      if (fs.existsSync(file)) fs.unlinkSync(file);
    }
  }
});

test('an existing pre-authentication SQLite database migrates without losing data', { timeout: 30000 }, async () => {
  const port = await getAvailablePort();
  const databasePath = path.join(os.tmpdir(), `project-board-migration-${process.pid}-${Date.now()}.sqlite`);
  const baseUrl = `http://127.0.0.1:${port}`;
  const legacyDb = new sqlite3.Database(databasePath);
  await new Promise((resolve, reject) => {
    legacyDb.exec(
      `CREATE TABLE users (
         id INTEGER PRIMARY KEY AUTOINCREMENT,
         name TEXT NOT NULL,
         email TEXT NOT NULL UNIQUE,
         created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
       );
       CREATE TABLE projects (
         id INTEGER PRIMARY KEY AUTOINCREMENT,
         name TEXT NOT NULL,
         description TEXT NOT NULL DEFAULT '',
         created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
       );
       CREATE TABLE tasks (
         id INTEGER PRIMARY KEY AUTOINCREMENT,
         project_id INTEGER NOT NULL,
         title TEXT NOT NULL,
         description TEXT NOT NULL DEFAULT '',
         assigned_to INTEGER NOT NULL,
         status TEXT NOT NULL DEFAULT 'To Do',
         created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
       );
       CREATE TABLE comments (
         id INTEGER PRIMARY KEY AUTOINCREMENT,
         task_id INTEGER NOT NULL,
         user_id INTEGER NOT NULL,
         content TEXT NOT NULL,
         created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
       );
       INSERT INTO users (name, email) VALUES ('Old Assignee', 'old@example.test');
       INSERT INTO projects (name, description) VALUES ('Existing Board', 'Keep this board');
       INSERT INTO tasks (project_id, title, assigned_to, status)
         VALUES (1, 'Existing Task', 1, 'In Progress');
       INSERT INTO comments (task_id, user_id, content)
         VALUES (1, 1, 'Existing Comment');`,
      async (error) => {
        if (error) {
          legacyDb.close();
          reject(error);
          return;
        }
        legacyDb.close((closeError) => closeError ? reject(closeError) : resolve());
      }
    );
  });

  const child = spawn(process.execPath, ['server.js'], {
    cwd: root,
    env: { ...process.env, DATABASE_PATH: databasePath, PORT: String(port) },
    stdio: 'ignore',
  });
  try {
    await waitForServer(baseUrl, child);
    const user = await register(baseUrl, 'Migrated Account', 'migrated@example.test');
    const projects = await request(baseUrl, '/projects', { token: user.token });
    assert.equal(projects.body.length, 1);
    assert.equal(projects.body[0].name, 'Existing Board');
    const tasks = await request(baseUrl, '/projects/1/tasks', { token: user.token });
    assert.equal(tasks.body.length, 1);
    assert.equal(tasks.body[0].title, 'Existing Task');
    assert.equal(tasks.body[0].comments[0].content, 'Existing Comment');
  } finally {
    child.kill();
    await new Promise((resolve) => {
      if (child.exitCode !== null) return resolve();
      const timeout = setTimeout(resolve, 3000);
      child.once('exit', () => {
        clearTimeout(timeout);
        resolve();
      });
    });
    for (const suffix of ['', '-wal', '-shm']) {
      const file = `${databasePath}${suffix}`;
      if (fs.existsSync(file)) fs.unlinkSync(file);
    }
  }
});

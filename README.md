# Project Management Board

A small Trello-style project board built with Express, SQLite, and a standalone HTML/CSS/JavaScript frontend. It supports account registration and login, private project membership, task assignment and status changes, task comments, notifications, and live updates over WebSockets.

## Run locally

Use Node.js 20.17 or newer.

```sh
npm install
npm start
```

Open [http://localhost:5002](http://localhost:5002), create an account, and sign in. The SQLite database is created as `project_management.db` beside `server.js`; the sample Website Redesign board, tasks, and comments are seeded on first run. The first registered account is added to projects that existed before membership was enabled.

To stop the server, press Ctrl+C. Keep the database file to preserve accounts and project data.

## Collaboration

Create an account for each teammate. On a project board, select **Team** and add an existing teammate by their registered email. Team members can then be assigned tasks and can comment on cards. The two seeded sample users can activate their placeholder accounts by registering with `alex@example.com` or `jamie@example.com`. New assignments, comments, and task status changes create notifications; project changes are broadcast to connected members in real time.

Passwords are stored as scrypt hashes. API sessions use random bearer tokens; only token hashes are persisted. Every project and task endpoint requires a valid signed-in session and checks project membership.

## API

All API routes are under `/api`. Authenticated routes require `Authorization: Bearer <token>`.

| Method | Path | Purpose |
| --- | --- | --- |
| `POST` | `/api/auth/register` | Create an account and sign in |
| `POST` | `/api/auth/login` | Sign in |
| `GET` | `/api/auth/me` | Read the current account |
| `POST` | `/api/auth/logout` | Revoke the current session |
| `GET`, `POST` | `/api/projects` | List the current user's projects; create a project |
| `GET`, `POST` | `/api/projects/:id/members` | List members; add an existing account by email |
| `GET` | `/api/projects/:id/users` | List eligible task assignees |
| `GET` | `/api/projects/:id/tasks` | List project tasks and comments |
| `POST` | `/api/tasks` | Create a task |
| `PATCH` | `/api/tasks/:id` | Change a task status |
| `POST` | `/api/tasks/:id/comments` | Add a comment as the signed-in user |
| `GET` | `/api/notifications` | List recent notifications |
| `PATCH` | `/api/notifications/:id/read` | Mark one notification read |
| `PATCH` | `/api/notifications/read-all` | Mark all notifications read |

Task statuses are `To Do`, `In Progress`, and `Done`. The WebSocket endpoint uses the same server address. Send an `authenticate` message containing the bearer token and optional project ID; subsequent project updates are sent to authenticated project members.

## Tests

```sh
npm test
```

The integration test starts an isolated server and database and exercises account/session handling, project privacy and membership, seeded data, task assignment and status updates, comments, notifications, and WebSocket broadcasts.

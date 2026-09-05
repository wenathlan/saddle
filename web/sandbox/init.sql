-- init.sql — e2ugh v7 schema (worklog task v7-BACK).
--
-- the pure sql mirror of the embedded migrations in web/db.js: the same
-- six tables and the same indexes, for operators that prefer the
-- sqlite3 cli or tools that import raw sql (drizzle, goose, flyway).
-- node users get this schema automatically: web/db.js executes it at
-- boot through node:sqlite.

create table if not exists users (
  id text primary key,
  username text not null unique,
  passwordhash text not null,
  salt text not null,
  role text not null default 'user',
  createdat text not null,
  lastlogin text
);

create unique index if not exists users_username on users(username);

create table if not exists sessions (
  tokenhash text primary key,
  userid text not null,
  createdat text not null,
  expiresat text not null,
  ip text,
  useragent text
);

create index if not exists sessions_expiresat on sessions(expiresat);

create table if not exists nodes (
  id text primary key,
  url text not null,
  rolename text,
  region text,
  lastheartbeat text,
  status text,
  registeredat text not null,
  meta text
);

create table if not exists sandboxes (
  id text primary key,
  userid text,
  model text,
  vcpus integer,
  ramgb integer,
  gpu text,
  state text,
  createdat text,
  expiresat text
);

create index if not exists sandboxes_userid on sandboxes(userid);

create table if not exists events (
  id integer primary key autoincrement,
  topic text,
  payload text,
  nodeid text,
  createdat text not null
);

create index if not exists events_createdat on events(createdat);

create table if not exists audit (
  id integer primary key autoincrement,
  userid text,
  action text,
  detail text,
  ip text,
  createdat text not null
);

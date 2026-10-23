-- Aibotq.dev v2 features: rollback, quotas, SAML SSO, monorepo, and team membership.

CREATE TABLE IF NOT EXISTS plans (
  id                  TEXT PRIMARY KEY,
  name                TEXT NOT NULL,
  price_monthly       INTEGER NOT NULL,
  builds_per_month    INTEGER NOT NULL,
  max_projects        INTEGER NOT NULL,
  max_custom_domains  INTEGER NOT NULL,
  seats               INTEGER NOT NULL,
  concurrent_builds   INTEGER NOT NULL
);

INSERT OR IGNORE INTO plans (id, name, price_monthly, builds_per_month, max_projects, max_custom_domains, seats, concurrent_builds) VALUES
  ('hobby', 'Hobby', 0, 100, 5, 1, 1, 1),
  ('pro', 'Pro', 2000, 1000, 20, 10, 3, 3),
  ('team', 'Team', 8000, -1, -1, -1, 20, 10);

CREATE TABLE IF NOT EXISTS user_subscriptions (
  user_id             TEXT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  plan_id             TEXT NOT NULL REFERENCES plans(id) DEFAULT 'hobby',
  cycle_start         INTEGER NOT NULL,
  status              TEXT NOT NULL DEFAULT 'active',
  builds_used         INTEGER NOT NULL DEFAULT 0,
  updated_at          INTEGER NOT NULL
);

ALTER TABLE deployments ADD COLUMN is_rollback INTEGER NOT NULL DEFAULT 0;
ALTER TABLE deployments ADD COLUMN rollback_from_id TEXT;
ALTER TABLE deployments ADD COLUMN app_id TEXT;

CREATE TABLE IF NOT EXISTS project_apps (
  id            TEXT PRIMARY KEY,
  project_id    TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  name          TEXT NOT NULL,
  root_dir      TEXT NOT NULL,
  framework     TEXT NOT NULL DEFAULT 'other',
  build_command TEXT,
  output_dir    TEXT,
  created_at    INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_project_apps_project ON project_apps(project_id);

CREATE TABLE IF NOT EXISTS saml_configs (
  id                TEXT PRIMARY KEY,
  team_id           TEXT NOT NULL,
  entity_id         TEXT NOT NULL,
  sso_url           TEXT NOT NULL,
  cert_enc          TEXT NOT NULL,
  idp_metadata_enc  TEXT,
  role_mapping_json TEXT,
  created_at        INTEGER NOT NULL,
  updated_at        INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_saml_configs_team ON saml_configs(team_id);

CREATE TABLE IF NOT EXISTS project_members (
  project_id        TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  user_id           TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role              TEXT NOT NULL CHECK (role IN ('owner','member','viewer')),
  created_at        INTEGER NOT NULL,
  PRIMARY KEY (project_id, user_id)
);
CREATE INDEX IF NOT EXISTS idx_project_members_user ON project_members(user_id);

ALTER TABLE users ADD COLUMN saml_id TEXT;
ALTER TABLE users ADD COLUMN plan_id TEXT DEFAULT 'hobby';
ALTER TABLE users ADD COLUMN role TEXT DEFAULT 'member';

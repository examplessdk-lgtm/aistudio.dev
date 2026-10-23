export interface Env {
  ASSETS: Fetcher;
  DB: D1Database;
  UPLOADS?: R2Bucket;

  APP_URL?: string;
  TEMPLATES?: Record<string, string> | string;
  DEPLOY_WEBHOOK_URL?: string;

  // Secrets (wrangler secret put ...)
  SESSION_SECRET?: string;
  GITHUB_CLIENT_ID?: string;
  GITHUB_CLIENT_SECRET?: string;
  GITHUB_WEBHOOK_SECRET?: string;
  DEPLOY_WEBHOOK_SECRET?: string;
  GITLAB_CLIENT_ID?: string;
  GITLAB_CLIENT_SECRET?: string;
  BITBUCKET_CLIENT_ID?: string;
  BITBUCKET_CLIENT_SECRET?: string;
  BITBUCKET_WEBHOOK_SECRET?: string;
  SAML_ENTITY_ID?: string;
  SAML_IDP_SSO_URL?: string;
  SAML_CERT?: string;
}

export type Provider = 'github' | 'gitlab' | 'bitbucket';
export const PROVIDERS: Provider[] = ['github', 'gitlab', 'bitbucket'];

export interface User {
  id: string;
  login: string;
  name: string | null;
  avatar: string | null;
  github_id: string | null;
  gitlab_id: string | null;
  bitbucket_id: string | null;
  saml_id?: string | null;
  plan_id?: string;
  role?: string;
}

export interface Ctx {
  req: Request;
  env: Env;
  ctx: ExecutionContext;
  url: URL;
}

export interface RepoInfo {
  provider: Provider;
  full_name: string;
  name: string;
  private: boolean;
  default_branch: string;
  description: string | null;
  updated_at: string | null;
  language: string | null;
  html_url: string;
}

export interface Plan {
  id: string;
  name: string;
  price_monthly: number;
  builds_per_month: number;
  max_projects: number;
  max_custom_domains: number;
  seats: number;
  concurrent_builds: number;
}

export interface ProjectApp {
  id: string;
  project_id: string;
  name: string;
  root_dir: string;
  framework: string;
  build_command: string | null;
  output_dir: string | null;
  created_at: number;
}

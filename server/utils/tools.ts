// Chat tools. Public tools are safe/read-only. Admin tools require a verified ADMIN_CHAT_TOKEN (server-side compare)
// and every write tool returns a signed *pending action* that only runs after the user clicks Confirm in /chat.
import { projectDeploy, projectList, projectRollback } from '../lib/projects'
import { checkDeployQuota } from '../lib/billing'
import { clientIp, decrypt, encrypt, hmacHex, rateLimit, timingSafeEqual } from '../lib/lib'
import { dockerEnabled, dockerSandbox } from './docker-sandbox'
import { runClairic } from './clairic'

export type ToolCtx = {
  env: any,
  req: Request,
  admin: boolean,
  files: { name: string, text: string }[],
  images?: { name: string, dataUrl: string }[],
  lastUserMessage?: string,
  user?: { id?: string, login: string, name: string | null } | null
}

// Sandbox provider: Docker Cloud Sandboxes first, Cloudflare Sandbox as fallback.
const cfSbx = (c: ToolCtx) => {
  if (!c.env.SANDBOX) throw new Error('Sandbox is not configured on this server.');
  return c.env.SANDBOX.getByName(c.user ? 'gh-' + c.user.login.toLowerCase() : 'owner');
}
const sbx = (c: ToolCtx) => {
  if (!c.user && !c.admin) throw new Error('Sign in with GitHub to use the sandbox.');
  const key = c.user ? 'gh-' + c.user.login.toLowerCase() : 'owner';
  const d = dockerEnabled(c.env) ? dockerSandbox(c.env, key, c.admin) : null;
  const run = async (name: 'exec' | 'write' | 'read', dArgs: any[], cfArgs: any[]) => {
    if (d) {
      try { return await (d as any)[name](...dArgs); }
      catch (e: any) {
        if (!c.env.SANDBOX) throw e;
        const r = await (cfSbx(c) as any)[name](...cfArgs);
        return { ...r, provider: 'cloudflare', fallbackReason: String(e?.message || e).slice(0, 200) };
      }
    }
    return { ...(await (cfSbx(c) as any)[name](...cfArgs)), provider: 'cloudflare' };
  };
  return {
    exec: (argv: string[], o: { timeoutSec?: number, internet?: boolean }) => run('exec', [argv, o], [argv, o]),
    write: (p: string, content: string, internet: boolean) => run('write', [p, content], [p, content, internet]),
    read: (p: string, internet: boolean) => run('read', [p], [p, internet]),
  };
};

const tsec = (a: any, c: ToolCtx) => Math.min(Number(a.timeout_sec) || 30, c.admin ? 120 : 30);
export type Tool = {
  name: string,
  description: string,
  schema: any,
  admin?: boolean,
  auth?: boolean,
  write?: boolean,
  run: (a: any, c: ToolCtx) => Promise<any>
};

const REPO = (env: any) => env.ADMIN_REPO || 'thanabartbb/aibotq-site';
const MAX = 20000;

function privateHost(h: string) {
  h = h.toLowerCase().replace(/^\[|\]$/g, '');
  if (h === 'localhost' || h.endsWith('.localhost') || h.endsWith('.local') || h.endsWith('.internal') || (!h.includes('.') && !h.includes(':'))) return true;
  const m = h.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (m) {
    const [a, b] = [+m[1]!, +m[2]!];
    return a === 10 || a === 127 || a === 0 || a >= 224 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127);
  }
  if (h.includes(':')) return h === '::1' || h === '::' || /^(fc|fd|fe80|::ffff)/.test(h);
  return false;
}

function htmlToText(s: string) {
  return s.replace(/<(script|style|noscript|svg)[\s\S]*?<\/\1>/gi, ' ').replace(/<br\s*\/?>|<\/(p|div|h\d|li|tr)>/gi, '\n').replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
    .replace(/[ \t]+/g, ' ').replace(/\n\s*\n+/g, '\n\n').trim();
}

async function gh(env: any, path: string, init: RequestInit = {}) {
  if (!env.GITHUB_ADMIN_TOKEN) throw new Error('GITHUB_ADMIN_TOKEN secret is not set on the server, so repo tools are unavailable.');
  const r = await fetch(`https://api.github.com${path}`, {
    ...init,
    headers: {
      authorization: `Bearer ${env.GITHUB_ADMIN_TOKEN}`,
      accept: 'application/vnd.github+json',
      'user-agent': 'aibotq-chat',
      'x-github-api-version': '2022-11-28',
      ...(init.body ? { 'content-type': 'application/json' } : {}),
    },
  });
  const j: any = r.status === 204 ? {} : await r.json().catch(() => ({}));
  if (!r.ok) throw new Error(`GitHub ${r.status}: ${j?.message || 'error'}`);
  return j;
}

const unb64 = (s: string) => new TextDecoder().decode(Uint8Array.from(atob(s.replace(/\n/g, '')), c => c.charCodeAt(0)));

// Helper to resolve project and check membership
async function resolveProjectWithAccess(c: ToolCtx, projectIdent: string) {
  if (!c.env.DB) throw new Error('Project database not available.');
  if (!c.user && !c.admin) throw new Error('Refusal: You must sign in to view or manage projects.');

  const ident = String(projectIdent).trim().toLowerCase();
  const p = await c.env.DB.prepare(
    `SELECT * FROM projects WHERE lower(id) = ? OR lower(name) = ? LIMIT 1`
  ).bind(ident, ident).first<any>();

  if (!p) throw new Error(`Project "${projectIdent}" was not found.`);

  // Site admin / owner bypass
  if (c.admin) return p;

  const uid = c.user?.id;
  const isOwner = p.user_id === uid || p.user_id === c.user?.login;
  if (isOwner) return p;

  // Member check in project_members
  if (uid) {
    const mem = await c.env.DB.prepare(
      `SELECT role FROM project_members WHERE project_id = ? AND user_id = ?`
    ).bind(p.id, uid).first<any>();
    if (mem) return p;
  }

  throw new Error(`Refusal: You are not a member or owner of project "${p.name}". Permission denied.`);
}

export const TOOLS: Tool[] = [
  {
    name: 'current_time',
    description: 'Get the current date and time. Use whenever the user asks about today, now, dates, or time in some timezone.',
    schema: { type: 'object', properties: { timezone: { type: 'string', description: 'IANA timezone, e.g. Asia/Bangkok. Default UTC.' } } },
    async run(a) {
      const tz = a?.timezone || 'UTC';
      const d = new Date();
      try {
        return { iso_utc: d.toISOString(), timezone: tz, local: d.toLocaleString('en-GB', { timeZone: tz, dateStyle: 'full', timeStyle: 'long' }) };
      } catch {
        return { error: `Unknown timezone ${tz}`, iso_utc: d.toISOString() };
      }
    },
  },
  {
    name: 'web_fetch',
    description: 'Fetch a public web page or file by URL and return its readable text (truncated to ~20k chars). Use when the user gives a URL or asks about the content of a specific website/docs page.',
    schema: { type: 'object', properties: { url: { type: 'string', description: 'Absolute http(s) URL' } }, required: ['url'] },
    async run(a) {
      let u: URL;
      try { u = new URL(a.url); } catch { return { error: 'Invalid URL' }; }
      for (let i = 0; i < 4; i++) {
        if (!/^https?:$/.test(u.protocol) || privateHost(u.hostname) || (u.port && !['80', '443'].includes(u.port))) {
          return { error: 'URL not allowed (private/local address or non-http)' };
        }
        const r = await fetch(u.toString(), { redirect: 'manual', headers: { 'user-agent': 'Mozilla/5.0 (compatible; aibotq-chat/1.0)', accept: 'text/html,text/plain,application/json,*/*' } });
        if (r.status >= 300 && r.status < 400 && r.headers.get('location')) { u = new URL(r.headers.get('location')!, u); continue; }
        const ct = r.headers.get('content-type') || '';
        if (!/text|json|xml|javascript/.test(ct)) return { url: u.toString(), status: r.status, error: `Unsupported content-type ${ct}` };
        const reader = r.body!.getReader();
        const chunks: Uint8Array[] = [];
        let n = 0;
        while (n < 1_500_000) { const { done, value } = await reader.read(); if (done) break; chunks.push(value); n += value.length; }
        reader.cancel().catch(() => {});
        const raw = new TextDecoder().decode(Uint8Array.from(chunks.flatMap(c => [...c])));
        const text = /html/.test(ct) ? htmlToText(raw) : raw;
        const title = raw.match(/<title[^>]*>([^<]*)/i)?.[1]?.trim();
        return { url: u.toString(), status: r.status, title, text: text.slice(0, MAX), truncated: text.length > MAX };
      }
      return { error: 'Too many redirects' };
    },
  },
  {
    name: 'read_uploaded_file',
    description: 'Read the text of a file the user attached in this chat (text, code, markdown, JSON, CSV or PDF). Call with no name to list attached files.',
    schema: { type: 'object', properties: { name: { type: 'string', description: 'File name as attached' } } },
    async run(a, c) {
      if (!c.files.length) return { error: 'No files are attached in this chat.' };
      const f = a?.name ? c.files.find(x => x.name === a.name) : (c.files.length === 1 ? c.files[0] : null);
      if (!f) return { files: c.files.map(x => ({ name: x.name, chars: x.text.length })) };
      return { name: f.name, text: f.text.slice(0, 60000), truncated: f.text.length > 60000 };
    },
  },
  {
    name: 'list_projects',
    description: "List the signed-in user's aibotq.dev projects with their latest deployment status and URL.",
    schema: { type: 'object', properties: {} },
    run: async (_a, c) => projects(c),
  },
  {
    name: 'deploy_status',
    description: 'Get the latest deployment status of one of the signed-in user\'s projects, by project name or id. Bot reads real live build status from D1.',
    schema: { type: 'object', properties: { project: { type: 'string', description: 'Project name or ID' } }, required: ['project'] },
    async run(a, c) {
      try {
        const p = await resolveProjectWithAccess(c, a.project);
        const d = await c.env.DB.prepare(
          'SELECT * FROM deployments WHERE project_id = ? ORDER BY created_at DESC LIMIT 1'
        ).bind(p.id).first<any>();

        return {
          project_id: p.id,
          name: p.name,
          framework: p.framework,
          live_url: p.url,
          status: p.status,
          latest_deployment: d ? {
            id: d.id,
            status: d.status,
            step: d.step,
            url: d.url,
            commit_sha: d.commit_sha ? d.commit_sha.slice(0, 7) : null,
            environment: d.environment,
            is_rollback: !!d.is_rollback,
            created_at: d.created_at,
            log_preview: d.log ? d.log.slice(-1500) : null,
          } : null,
        };
      } catch (e: any) {
        return { error: e.message };
      }
    },
  },

  // ---------- BOT-AWARE DEPLOYMENT & LOG TOOLS ----------
  {
    name: 'deploy_project',
    auth: true,
    description: 'Deploy an existing project to the edge. Requires the user to be a project member or owner. Obeys plan quotas and platform rate limits (10 deploys/10 min).',
    schema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Project name or ID to deploy' },
      },
      required: ['project'],
    },
    async run(a, c) {
      try {
        const p = await resolveProjectWithAccess(c, a.project);
        const ownerId = p.user_id;

        // 1. Quota Check BEFORE dispatch
        await checkDeployQuota(c.env, ownerId);

        // 2. Rate Limits
        await rateLimit(c.env, `deploy:${ownerId}`, 10, 600);
        await rateLimit(c.env, `deploy-ip:${clientIp(c.req)}`, 30, 600);

        // 3. Delegate to projectDeploy endpoint logic
        const dummyReq = new Request(`${c.req.url}/api/projects/${p.id}/deploy`, {
          method: 'POST',
          headers: c.req.headers,
        });
        const res = await projectDeploy({
          req: dummyReq,
          env: c.env,
          ctx: {} as any,
          url: new URL(dummyReq.url),
        }, p.id);

        const j: any = await res.json();
        if (!res.ok) return { error: j.error || `Deploy failed with HTTP ${res.status}` };
        return {
          success: true,
          project: p.name,
          deployment_id: j.data?.deployment?.id,
          status: j.data?.deployment?.status || 'queued',
          step: j.data?.deployment?.step || 'queued',
          environment: j.data?.deployment?.environment || 'production',
          note: 'Deployment successfully queued. Live build status is actively updating.',
        };
      } catch (e: any) {
        return { error: e.message, code: e.code || 'deploy_error' };
      }
    },
  },
  {
    name: 'list_deployments',
    auth: true,
    description: 'List recent deployments for a project with status, step, duration, commit SHA, and rollback badges.',
    schema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Project name or ID' },
        limit: { type: 'number', description: 'Number of deployments to retrieve (default 10, max 30)' },
      },
      required: ['project'],
    },
    async run(a, c) {
      try {
        const p = await resolveProjectWithAccess(c, a.project);
        const limit = Math.min(Math.max(Number(a.limit) || 10, 1), 30);
        const { results } = await c.env.DB.prepare(
          `SELECT id, step, status, commit_sha, url, environment, ref, is_rollback, rollback_from_id, created_at
           FROM deployments WHERE project_id = ? ORDER BY created_at DESC LIMIT ?`
        ).bind(p.id, limit).all<any>();

        return {
          project: p.name,
          live_url: p.url,
          count: results.length,
          deployments: results.map(d => ({
            id: d.id,
            status: d.status,
            step: d.step,
            url: d.url,
            environment: d.environment,
            commit_sha: d.commit_sha ? d.commit_sha.slice(0, 7) : null,
            is_rollback: !!d.is_rollback,
            rollback_from_id: d.rollback_from_id || null,
            created_at: new Date(d.created_at).toISOString(),
          })),
        };
      } catch (e: any) {
        return { error: e.message };
      }
    },
  },
  {
    name: 'get_build_log',
    auth: true,
    description: 'Retrieve real live build log and failure diagnosis for a deployment. Pinpoints failing step, actual error lines, and proposes a fix.',
    schema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Project name or ID (optional if deployment_id is provided)' },
        deployment_id: { type: 'string', description: 'Deployment ID (optional, defaults to latest deployment)' },
      },
    },
    async run(a, c) {
      try {
        if (!c.env.DB) throw new Error('Database not available.');
        let deployment: any = null;
        let project: any = null;

        if (a.deployment_id) {
          deployment = await c.env.DB.prepare('SELECT * FROM deployments WHERE id = ?').bind(a.deployment_id).first<any>();
          if (!deployment) throw new Error(`Deployment ${a.deployment_id} was not found.`);
          project = await resolveProjectWithAccess(c, deployment.project_id);
        } else if (a.project) {
          project = await resolveProjectWithAccess(c, a.project);
          deployment = await c.env.DB.prepare('SELECT * FROM deployments WHERE project_id = ? ORDER BY created_at DESC LIMIT 1').bind(project.id).first<any>();
          if (!deployment) throw new Error(`No deployments found for project "${project.name}".`);
        } else {
          throw new Error('Please specify a project or deployment_id.');
        }

        const log = deployment.log || '';
        // Extract error lines (lines containing error, fail, fatal, exception, npm ERR!)
        const lines = log.split('\n');
        const errorLines = lines.filter((l: string) => /error|fail|exception|fatal|npm ERR!|cannot find module|command not found/i.test(l)).slice(-10);

        let diagnosis = 'Build completed normally.';
        if (deployment.status === 'failed') {
          if (/cannot find module|not found/i.test(log)) {
            diagnosis = 'A required package or build dependency is missing in package.json or the build container.';
          } else if (/syntaxerror/i.test(log)) {
            diagnosis = 'A syntax error prevented code compilation or bundling.';
          } else if (/timeout/i.test(log)) {
            diagnosis = 'The build pipeline exceeded the 20-minute execution timeout.';
          } else if (/quota/i.test(log)) {
            diagnosis = 'Deployment halted due to account build quota or limit restrictions.';
          } else {
            diagnosis = `Build failed at step "${deployment.step}". Check the pinpointed error lines below.`;
          }
        }

        return {
          project: project.name,
          deployment_id: deployment.id,
          status: deployment.status,
          step: deployment.step,
          environment: deployment.environment,
          commit_sha: deployment.commit_sha ? deployment.commit_sha.slice(0, 7) : null,
          is_rollback: !!deployment.is_rollback,
          failing_step: deployment.status === 'failed' ? deployment.step : null,
          diagnosis,
          error_lines: errorLines,
          log_tail: log.slice(-4000),
        };
      } catch (e: any) {
        return { error: e.message };
      }
    },
  },
  {
    name: 'rollback_deployment',
    auth: true,
    description: 'Roll back a project live URL to any previous "ready" deployment from the last 7 days with zero rebuild time.',
    schema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Project name or ID' },
        deployment_id: { type: 'string', description: 'The ready deployment ID to restore' },
      },
      required: ['project', 'deployment_id'],
    },
    async run(a, c) {
      try {
        const p = await resolveProjectWithAccess(c, a.project);
        const dummyReq = new Request(`${c.req.url}/api/projects/${p.id}/deployments/${a.deployment_id}/rollback`, {
          method: 'POST',
          headers: c.req.headers,
        });

        const res = await projectRollback({
          req: dummyReq,
          env: c.env,
          ctx: {} as any,
          url: new URL(dummyReq.url),
        }, p.id, a.deployment_id);

        const j: any = await res.json();
        if (!res.ok) return { error: j.error || `Rollback failed with HTTP ${res.status}` };
        return {
          success: true,
          project: p.name,
          new_deployment_id: j.data?.deployment?.id,
          restored_from: a.deployment_id,
          live_url: j.data?.live_url,
          message: j.data?.message || 'Rollback completed with zero rebuild time.',
        };
      } catch (e: any) {
        return { error: e.message };
      }
    },
  },
  {
    name: 'set_env_var',
    auth: true,
    description: 'Write-only: securely encrypt (AES-GCM) and store an environment variable for a project in D1. The value is NEVER echoed back in chat responses or logs.',
    schema: {
      type: 'object',
      properties: {
        project: { type: 'string', description: 'Project name or ID' },
        key: { type: 'string', description: 'Environment variable name (e.g. API_KEY, DATABASE_URL)' },
        value: { type: 'string', description: 'Secret value to store (write-only)' },
      },
      required: ['project', 'key', 'value'],
    },
    async run(a, c) {
      try {
        const p = await resolveProjectWithAccess(c, a.project);
        const key = String(a.key).trim();
        if (!/^[A-Za-z_][A-Za-z0-9_]{0,63}$/.test(key)) {
          throw new Error(`Invalid environment variable key name: "${key}". Must use alphanumeric letters and underscores.`);
        }
        const val = typeof a.value === 'string' ? a.value : String(a.value ?? '');
        if (val.length > 4096) throw new Error('Environment variable value is too long (max 4096 chars).');

        let envVars: Record<string, string> = {};
        if (p.env_enc) {
          try {
            envVars = JSON.parse(await decrypt(c.env, p.env_enc));
          } catch {}
        }
        envVars[key] = val;
        const newEnc = await encrypt(c.env, JSON.stringify(envVars));

        await c.env.DB.prepare('UPDATE projects SET env_enc = ? WHERE id = ?').bind(newEnc, p.id).run();

        // Write-only: Never echo value back!
        return {
          project: p.name,
          key,
          saved: true,
          write_only: true,
          note: `Variable "${key}" encrypted with AES-GCM and stored. Secret values remain write-only and are never echoed back in chat.`,
        };
      } catch (e: any) {
        return { error: e.message };
      }
    },
  },

  // ---------- CLAIRIC & CODE SANDBOX TOOLS ----------
  {
    name: 'extract_data',
    auth: true,
    description: "Extract typed values (text, number, date, time, datetime, duration, list, estimate, forecast) from text and/or up to 4 images with Cloudflare Clairic. Returns value, confidence, p_null and p10/p90 per field; values marked uncertain must be presented as uncertain.",
    schema: {
      type: 'object',
      properties: {
        state: { type: 'string', description: "Text to read. Omit to use the user's message and attached text." },
        image_urls: { type: 'array', items: { type: 'string' }, maxItems: 4, description: 'https URLs of PNG/JPEG/WebP images' },
        fields: { type: 'object', description: 'Map of field name -> schema definition', additionalProperties: true },
      },
      required: ['fields'],
    },
    async run(a, c) {
      const who = c.user ? 'gh-' + c.user.login.toLowerCase() : 'owner';
      if (c.env.DB) await rateLimit(c.env, `clairic:${who}`, c.admin ? 120 : 20, 3600);
      const state = a.state ? String(a.state) : [c.lastUserMessage || '', ...c.files.map(f => `--- ${f.name} ---\n${f.text}`)].filter(Boolean).join('\n\n');
      const images = [...(c.images || []).map(i => i.dataUrl), ...((Array.isArray(a.image_urls) ? a.image_urls : []).map(String))].slice(0, 4);
      return runClairic(c.env, { state, images, fields: a.fields });
    },
  },
  {
    name: 'run_code',
    auth: true,
    description: 'Run a Python or JavaScript (Node 24) snippet in your private Linux sandbox and return stdout/stderr/exitCode. Files persist in /workspace for ~10 min of idle time.',
    schema: { type: 'object', properties: { language: { type: 'string', enum: ['python', 'js'] }, code: { type: 'string' }, timeout_sec: { type: 'number' } }, required: ['language', 'code'] },
    run: async (a, c) => {
      const s = sbx(c), f = a.language === 'python' ? '/workspace/.run.py' : '/workspace/.run.mjs';
      await s.write(f, String(a.code), c.admin);
      return s.exec([a.language === 'python' ? 'python3' : 'node', f], { timeoutSec: tsec(a, c), internet: c.admin });
    },
  },
  {
    name: 'run_command',
    auth: true,
    description: 'Run a shell command (bash -lc) in your private Linux sandbox (cwd /workspace). Internet access only for the site owner.',
    schema: { type: 'object', properties: { command: { type: 'string' }, timeout_sec: { type: 'number' } }, required: ['command'] },
    run: async (a, c) => sbx(c).exec(['bash', '-lc', String(a.command)], { timeoutSec: tsec(a, c), internet: c.admin }),
  },
  {
    name: 'write_file',
    auth: true,
    description: 'Write a text file in your sandbox (path under /workspace).',
    schema: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] },
    run: async (a, c) => {
      const p = String(a.path).startsWith('/') ? String(a.path) : '/workspace/' + a.path;
      if (!c.admin && !p.startsWith('/workspace/')) throw new Error('Path must be under /workspace');
      return sbx(c).write(p, String(a.content).slice(0, 500000), c.admin);
    },
  },
  {
    name: 'read_file',
    auth: true,
    description: 'Read a text file from your sandbox.',
    schema: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
    run: async (a, c) => {
      const p = String(a.path).startsWith('/') ? String(a.path) : '/workspace/' + a.path;
      if (!c.admin && !p.startsWith('/workspace/')) throw new Error('Path must be under /workspace');
      return sbx(c).read(p, c.admin);
    },
  },

  // ---------- OWNER / ADMIN TOOLS ----------
  {
    name: 'list_repo_files',
    admin: true,
    description: 'Owner only. List files of the aibotq.dev website source repo.',
    schema: { type: 'object', properties: { prefix: { type: 'string' }, ref: { type: 'string', description: 'branch, default main' } } },
    async run(a, c) {
      const t = await gh(c.env, `/repos/${REPO(c.env)}/git/trees/${encodeURIComponent(a?.ref || 'main')}?recursive=1`);
      const files = t.tree.filter((x: any) => x.type === 'blob' && (!a?.prefix || x.path.startsWith(a.prefix))).map((x: any) => x.path);
      return { count: files.length, files: files.slice(0, 400) };
    },
  },
  {
    name: 'read_repo_file',
    admin: true,
    description: 'Owner only. Read one file from the website source repo.',
    schema: { type: 'object', properties: { path: { type: 'string' }, ref: { type: 'string' } }, required: ['path'] },
    async run(a, c) {
      const f = await gh(c.env, `/repos/${REPO(c.env)}/contents/${a.path.split('/').map(encodeURIComponent).join('/')}?ref=${encodeURIComponent(a.ref || 'main')}`);
      const text = unb64(f.content || '');
      return { path: a.path, text: text.slice(0, 60000), truncated: text.length > 60000 };
    },
  },
  {
    name: 'propose_change',
    admin: true,
    write: true,
    description: 'Owner only. Propose a code change: creates a new branch, commits the files, and opens a pull request. Requires owner confirmation.',
    schema: {
      type: 'object',
      properties: {
        title: { type: 'string' },
        description: { type: 'string' },
        branch: { type: 'string' },
        files: { type: 'array', items: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } }, required: ['path', 'content'] } },
      },
      required: ['title', 'branch', 'files'],
    },
    async run(a, c) {
      const R = REPO(c.env);
      const branch = String(a.branch).replace(/[^\w./-]/g, '-');
      if (branch === 'main') return { error: 'Cannot commit to main' };
      const base = await gh(c.env, `/repos/${R}/git/ref/heads/main`);
      const baseSha = base.object.sha;
      const commit = await gh(c.env, `/repos/${R}/git/commits/${baseSha}`);
      const tree = await gh(c.env, `/repos/${R}/git/trees`, { method: 'POST', body: JSON.stringify({ base_tree: commit.tree.sha, tree: a.files.map((f: any) => ({ path: f.path, mode: '100644', type: 'blob', content: f.content })) }) });
      const nc = await gh(c.env, `/repos/${R}/git/commits`, { method: 'POST', body: JSON.stringify({ message: a.title, tree: tree.sha, parents: [baseSha] }) });
      await gh(c.env, `/repos/${R}/git/refs`, { method: 'POST', body: JSON.stringify({ ref: `refs/heads/${branch}`, sha: nc.sha }) });
      const pr = await gh(c.env, `/repos/${R}/pulls`, { method: 'POST', body: JSON.stringify({ title: a.title, head: branch, base: 'main', body: (a.description || '') + '\n\nProposed via aibotq.dev admin chat.' }) });
      return { pr_url: pr.html_url, number: pr.number, branch };
    },
  },
  {
    name: 'trigger_deploy',
    admin: true,
    write: true,
    description: 'Owner only. Run the GitHub Actions deploy.yml workflow to build and deploy website from a branch. Requires owner confirmation.',
    schema: { type: 'object', properties: { ref: { type: 'string' } } },
    async run(a, c) {
      const ref = a?.ref || 'main';
      await gh(c.env, `/repos/${REPO(c.env)}/actions/workflows/deploy.yml/dispatches`, { method: 'POST', body: JSON.stringify({ ref }) });
      return { started: true, ref, runs: `https://github.com/${REPO(c.env)}/actions/workflows/deploy.yml` };
    },
  },
];

async function projects(c: ToolCtx) {
  if (!c.env.DB) return { error: 'Project database not available.' };
  try {
    const r = await projectList({ req: c.req, env: c.env, ctx: {} as any, url: new URL(c.req.url) } as any);
    const j: any = await r.json();
    return r.ok ? { projects: j.data?.projects ?? j.projects ?? [] } : { error: 'Sign in required: the user must sign in on aibotq.dev to see their projects.' };
  } catch (e: any) {
    return { error: e?.status === 401 || /sign|auth/i.test(e?.message || '') ? 'Sign in required: the user must sign in on aibotq.dev to see their projects.' : 'Could not load projects: ' + e?.message };
  }
}

export async function isAdmin(env: any, token?: string) {
  if (!env.ADMIN_CHAT_TOKEN || !token) return false;
  return timingSafeEqual(await hmacHex(env.ADMIN_CHAT_TOKEN, token), await hmacHex(env.ADMIN_CHAT_TOKEN, env.ADMIN_CHAT_TOKEN));
}

export const toolsFor = (admin: boolean, signedIn = false) => TOOLS.filter(t => (admin || !t.admin) && (signedIn || admin || !t.auth));

export async function signAction(env: any, tool: string, args: any) {
  const payload = JSON.stringify({ tool, args, exp: Date.now() + 30 * 60_000 });
  return { payload, sig: await hmacHex(env.ADMIN_CHAT_TOKEN, payload) };
}

export async function verifyAction(env: any, payload: string, sig: string) {
  if (!env.ADMIN_CHAT_TOKEN || !timingSafeEqual(await hmacHex(env.ADMIN_CHAT_TOKEN, payload), sig || '')) return null;
  const p = JSON.parse(payload);
  return p.exp > Date.now() ? (p as { tool: string, args: any }) : null;
}

export function systemPrompt(admin: boolean, files: { name: string }[], web_search: boolean, user?: { login: string, name: string | null } | null) {
  const list = toolsFor(admin, !!user).map(t => `- ${t.name}: ${t.description}`).join('\n');
  return `You are the aibotq.dev assistant. You help developers and teams ship AI agents on Cloudflare Workers + SSR, with D1, R2, external build pipelines, and custom domains.

LANGUAGE & TONE:
- Reply in the user's language (e.g., Thai if the user asks in Thai, English if in English).
- Be concise, accurate, and direct.

REAL-TIME BUILD AWARENESS:
- You are directly connected to the live deployment pipeline and D1 database.
- When the user asks "สถานะ build ล่าสุดคืออะไร", "ทำไม build ล้มเหลว", or "deploy my project", ALWAYS call the appropriate tool (deploy_status, list_deployments, get_build_log, deploy_project, rollback_deployment). Never guess or hallucinate statuses.
- When diagnosing a failed build, call get_build_log, pinpoint the exact step that failed, quote the actual error lines, and provide a concrete, step-by-step fix.
- When the user asks to deploy, call deploy_project and report the real status.
- When the user asks to roll back, verify the deployment ID with list_deployments and call rollback_deployment.
- Environment variables: when the user gives you an env var, use set_env_var. Note that it is strictly write-only: never echo or output the secret value back.

AVAILABLE TOOLS:
${list}

PERMISSION & SECURITY RULES:
- Project actions require the user to be a member or owner. Non-members receive a clear refusal.
- Hobby plan has 100 builds/month; if quota is exceeded, explain the upgrade path to Pro or Team.
${user ? `The current user is signed in as @${user.login}${user.name ? ` (${user.name})` : ''}.` : 'The current visitor is not signed in. Suggest signing in with GitHub or SAML SSO for account features.'}
${admin ? 'You are verified as the SITE OWNER with repo management permissions.' : ''}
Never invent fake logs or build results.`;
}

import { ApiError, ok } from './lib';
import { requireUser } from './auth';
import type { Ctx, Env, Plan } from './types';

export const PLANS: Record<string, Plan> = {
  hobby: { id: 'hobby', name: 'Hobby', price_monthly: 0, builds_per_month: 100, max_projects: 5, max_custom_domains: 1, seats: 1, concurrent_builds: 1 },
  pro: { id: 'pro', name: 'Pro', price_monthly: 2000, builds_per_month: 1000, max_projects: 20, max_custom_domains: 10, seats: 3, concurrent_builds: 3 },
  team: { id: 'team', name: 'Team', price_monthly: 8000, builds_per_month: -1, max_projects: -1, max_custom_domains: -1, seats: 20, concurrent_builds: 10 },
};

export async function getUserPlan(env: Env, userId: string): Promise<Plan> {
  const sub = await env.DB.prepare(
    'SELECT s.plan_id, p.* FROM user_subscriptions s JOIN plans p ON p.id = s.plan_id WHERE s.user_id = ?'
  ).bind(userId).first<Plan>();
  if (sub) return sub;

  const user = await env.DB.prepare('SELECT plan_id FROM users WHERE id = ?').bind(userId).first<{ plan_id: string }>();
  const planId = user?.plan_id && PLANS[user.plan_id] ? user.plan_id : 'hobby';
  const planRow = await env.DB.prepare('SELECT * FROM plans WHERE id = ?').bind(planId).first<Plan>();
  return planRow || PLANS[planId] || PLANS.hobby;
}

export function getCurrentCycleStart(): number {
  const now = new Date();
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1)).getTime();
}

export async function checkDeployQuota(env: Env, userId: string): Promise<{ plan: Plan; buildsUsed: number }> {
  const plan = await getUserPlan(env, userId);
  const cycleStart = getCurrentCycleStart();

  const usedRow = await env.DB.prepare(
    `SELECT COUNT(*) as count FROM deployments d
     JOIN projects p ON p.id = d.project_id
     WHERE p.user_id = ? AND d.created_at >= ? AND d.is_rollback = 0`
  ).bind(userId, cycleStart).first<{ count: number }>();

  const buildsUsed = usedRow?.count || 0;

  if (plan.builds_per_month !== -1 && buildsUsed >= plan.builds_per_month) {
    throw new ApiError(
      402,
      `Quota exceeded: You have reached the ${plan.name} plan limit of ${plan.builds_per_month} builds/month (used ${buildsUsed}). Upgrade to Pro ($20/mo) or Team ($80/mo) to continue building.`,
      'quota_exceeded'
    );
  }

  const concurrentRow = await env.DB.prepare(
    `SELECT COUNT(*) as count FROM deployments d
     JOIN projects p ON p.id = d.project_id
     WHERE p.user_id = ? AND d.status IN ('queued','building')`
  ).bind(userId).first<{ count: number }>();

  const activeBuilds = concurrentRow?.count || 0;
  if (plan.concurrent_builds !== -1 && activeBuilds >= plan.concurrent_builds) {
    throw new ApiError(
      429,
      `Concurrent build limit reached: Your ${plan.name} plan allows up to ${plan.concurrent_builds} simultaneous build(s). Please wait for running builds to complete.`,
      'concurrent_limit_exceeded'
    );
  }

  return { plan, buildsUsed };
}

export async function billingUsage(c: Ctx): Promise<Response> {
  const user = await requireUser(c);
  const plan = await getUserPlan(c.env, user.id);
  const cycleStart = getCurrentCycleStart();

  const usedRow = await c.env.DB.prepare(
    `SELECT COUNT(*) as count FROM deployments d
     JOIN projects p ON p.id = d.project_id
     WHERE p.user_id = ? AND d.created_at >= ? AND d.is_rollback = 0`
  ).bind(user.id, cycleStart).first<{ count: number }>();

  const activeRow = await c.env.DB.prepare(
    `SELECT COUNT(*) as count FROM deployments d
     JOIN projects p ON p.id = d.project_id
     WHERE p.user_id = ? AND d.status IN ('queued','building')`
  ).bind(user.id).first<{ count: number }>();

  const projectsRow = await c.env.DB.prepare(
    `SELECT COUNT(*) as count FROM projects WHERE user_id = ?`
  ).bind(user.id).first<{ count: number }>();

  const { results: allPlans } = await c.env.DB.prepare('SELECT * FROM plans').all<Plan>();

  return ok({
    plan,
    usage: {
      builds_used: usedRow?.count || 0,
      builds_limit: plan.builds_per_month,
      active_builds: activeRow?.count || 0,
      concurrent_limit: plan.concurrent_builds,
      projects_count: projectsRow?.count || 0,
      projects_limit: plan.max_projects,
      cycle_start: cycleStart,
    },
    plans: allPlans && allPlans.length ? allPlans : Object.values(PLANS),
  });
}

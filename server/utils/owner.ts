// Owner = signed-in GitHub login listed in OWNER_GITHUB_LOGINS (comma-separated, case-insensitive), or the ADMIN_CHAT_TOKEN fallback.
import { isAdmin } from './tools'
import type { H3Event } from 'h3'
import { getSessionUser } from '../lib/auth'

const DEFAULT_OWNERS = 'thanabartbb,examplessdk-lgtm'
export const ownerLogins = (env: any) => String(env.OWNER_GITHUB_LOGINS || DEFAULT_OWNERS).split(',').map(s => s.trim().toLowerCase()).filter(Boolean)

export async function chatIdentity(event: H3Event) {
  const env = (event.context as any).cloudflare?.env || {}
  const req = toWebRequest(event)

  // 1. Try D1 session via aq_session cookie
  let dbUser: any = null
  if (env.DB) {
    try {
      const s = await getSessionUser(req, env)
      if (s?.user) dbUser = s.user
    } catch {}
  }

  // 2. Try nuxt-auth-utils session
  const nuxtSession = await getUserSession(event).catch(() => ({} as any))
  const nuxtUser = (nuxtSession as any)?.user

  let user: { id: string, login: string, name: string | null } | null = null
  if (dbUser) {
    user = { id: dbUser.id, login: dbUser.login, name: dbUser.name }
  } else if (nuxtUser) {
    user = { id: nuxtUser.id || nuxtUser.login, login: nuxtUser.login, name: nuxtUser.name || null }
  }

  const owner = !!user?.login && ownerLogins(env).includes(user.login.toLowerCase())
  const admin = owner || await isAdmin(env, getHeader(event, 'x-admin-token'))
  return { env, user, admin, via: owner ? 'github' : admin ? 'token' : null }
}

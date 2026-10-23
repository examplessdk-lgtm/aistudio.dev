<script setup lang="ts">
definePageMeta({ layout: 'dashboard' })
useSeoMeta({
  title: "Dashboard — Aibotq.dev",
  description: "Your Aibotq.dev projects, deployments, monorepo apps, and rollbacks.",
  ogTitle: "Dashboard — Aibotq.dev",
  ogDescription: "Your Aibotq.dev projects, deployments, monorepo apps, and rollbacks.",
  ogType: 'website',
  ogUrl: 'https://aibotq.dev/dashboard/',
  ogImage: 'https://aibotq.dev/icon-512.png',
  twitterCard: 'summary',
  robots: "noindex"
})

const toast = useToast()
const { user, loaded, load, login } = useSession()
const projects = ref<any[]>([]), sel = ref<string | null>(null), deps = ref<any[]>([]), depSel = ref<string | null>(null)
const state = ref<'loading' | 'anon' | 'error' | 'ready'>('loading'), errMsg = ref(''), depsErr = ref(''), depAlert = ref(''), busy = ref(false)
const rollbackBusy = ref<string | null>(null)
const activeTab = ref<'deployments' | 'monorepo' | 'saml'>('deployments')

// Monorepo apps state
const projectApps = ref<any[]>([])
const appsLoading = ref(false)
const appFormOpen = ref(false)
const newApp = ref({ name: '', root_dir: '', framework: 'other', build_command: '', output_dir: '' })

// Billing & Quota state
const billing = ref<any>(null)
async function loadBilling() {
  try {
    const res = await aq('/billing/usage')
    billing.value = res
  } catch {}
}

let timer: any = null
const stopTimer = () => { clearTimeout(timer); timer = null }
onBeforeUnmount(stopTimer)

const STATUS: Record<string, any> = { ready: 'success', live: 'success', building: 'primary', queued: 'neutral', failed: 'error' }
const cur = computed(() => projects.value.find(p => p.id === sel.value))
const kpis = computed(() => [
  { label: 'Projects', value: projects.value.length, icon: 'i-lucide-folder-git-2' },
  { label: 'Live', value: projects.value.filter(p => p.status === 'live').length, icon: 'i-lucide-radio' },
  { label: 'Deploying now', value: projects.value.filter(p => ['queued', 'building'].includes(p.latest_deployment?.status)).length, icon: 'i-lucide-loader' },
])

async function start() {
  await load(true)
  if (!user.value) { state.value = 'anon'; return }
  await loadProjects()
  await loadBilling()
}

async function loadProjects() {
  try {
    projects.value = (await aq('/projects')).projects
  } catch (e: any) {
    if (e.status === 401) { state.value = 'anon'; return }
    errMsg.value = e.message
    state.value = 'error'
    return
  }
  const want = new URLSearchParams(location.search).get('p')
  sel.value = want && projects.value.find(p => p.id === want) ? want : projects.value[0]?.id || null
  state.value = 'ready'
  if (sel.value) {
    loadDeps()
    loadApps()
  }
}

function select(id: string) {
  sel.value = id
  depSel.value = null
  deps.value = []
  depAlert.value = ''
  stopTimer()
  history.replaceState(null, '', '?p=' + encodeURIComponent(id))
  loadDeps()
  loadApps()
}

async function loadDeps() {
  const id = sel.value
  depsErr.value = ''
  try {
    const d = await aq(`/projects/${encodeURIComponent(id!)}/deployments`)
    if (id !== sel.value) return
    deps.value = d.deployments
    if (!depSel.value || !deps.value.find(x => x.id === depSel.value)) depSel.value = deps.value[0]?.id || null
    const p = cur.value, top = deps.value[0]
    if (p && top) {
      p.latest_deployment = { ...top }
      if (top.status === 'ready' && top.environment === 'production') {
        p.status = 'live'
        p.url = top.url
      }
    }
    if (deps.value.some(x => x.status === 'queued' || x.status === 'building')) {
      stopTimer()
      timer = setTimeout(loadDeps, 2500)
    }
  } catch (e: any) {
    if (id === sel.value) depsErr.value = e.message
  }
}

async function loadApps() {
  const id = sel.value
  if (!id) return
  appsLoading.value = true
  try {
    const res = await aq(`/projects/${encodeURIComponent(id)}/apps`)
    projectApps.value = res.apps || []
  } catch {
    projectApps.value = []
  } finally {
    appsLoading.value = false
  }
}

async function addApp() {
  const id = sel.value
  if (!id || !newApp.value.name || !newApp.value.root_dir) return
  try {
    await aq(`/projects/${encodeURIComponent(id)}/apps`, {
      method: 'POST',
      body: newApp.value,
    })
    toast.add({ color: 'success', title: `App "${newApp.value.name}" added to monorepo.` })
    newApp.value = { name: '', root_dir: '', framework: 'other', build_command: '', output_dir: '' }
    appFormOpen.value = false
    await loadApps()
  } catch (e: any) {
    toast.add({ color: 'error', title: e.message || 'Failed to add monorepo app' })
  }
}

async function removeApp(appId: string) {
  const id = sel.value
  if (!id) return
  try {
    await aq(`/projects/${encodeURIComponent(id)}/apps/${encodeURIComponent(appId)}`, { method: 'DELETE' })
    toast.add({ title: 'Monorepo app removed.' })
    await loadApps()
  } catch (e: any) {
    toast.add({ color: 'error', title: e.message || 'Failed to delete app' })
  }
}

async function redeploy() {
  const p = cur.value
  if (!p) return
  busy.value = true
  depAlert.value = ''
  try {
    const d = await aq(`/projects/${encodeURIComponent(p.id)}/deploy`, { method: 'POST', body: {} })
    depSel.value = d.deployment.id
    toast.add({ color: 'success', title: 'Deployment queued.' })
    await loadBilling()
  } catch (e: any) {
    depAlert.value = e.message
    if (e.code === 'quota_exceeded' || e.status === 402) {
      toast.add({ color: 'warning', title: 'Build Quota Exceeded', description: e.message })
    }
  } finally {
    busy.value = false
  }
  stopTimer()
  loadDeps()
}

// 7-day rollback guard check
function canRollback(dep: any): boolean {
  if (!dep || dep.status !== 'ready' || !dep.url) return false
  const top = deps.value[0]
  if (top && top.id === dep.id) return false // already the current live deployment
  const ageMs = Date.now() - dep.created_at
  return ageMs <= 7 * 24 * 3600 * 1000
}

async function rollbackTo(dep: any) {
  const p = cur.value
  if (!p || !dep) return
  rollbackBusy.value = dep.id
  depAlert.value = ''
  try {
    const res = await aq(`/projects/${encodeURIComponent(p.id)}/deployments/${encodeURIComponent(dep.id)}/rollback`, {
      method: 'POST',
      body: {},
    })
    depSel.value = res.deployment.id
    p.status = 'live'
    p.url = res.live_url
    toast.add({
      color: 'success',
      title: 'Rollback Completed (Zero Rebuild Time)',
      description: `Re-pointed live URL to deployment #${dep.id.slice(0, 7)}.`,
    })
    await loadDeps()
  } catch (e: any) {
    depAlert.value = e.message || 'Rollback failed'
    toast.add({ color: 'error', title: 'Rollback Failed', description: e.message })
  } finally {
    rollbackBusy.value = null
  }
}

const selDep = computed(() => deps.value.find(x => x.id === depSel.value))
async function copyLog() {
  try {
    await navigator.clipboard.writeText(selDep.value?.log || '')
    toast.add({ title: 'Log copied to clipboard' })
  } catch {}
}

const wsLabel = (ws = '') => (ws === 'active' ? 'Git push = deploy: active' : 'Auto-deploy: ' + (ws.replace(/^\w+:\s*/, '') || 'off').slice(0, 60))
onMounted(start)
</script>

<template>
  <UDashboardPanel id="projects">
    <template #header>
      <UDashboardNavbar title="Projects" icon="i-lucide-layout-grid">
        <template #leading><UDashboardSidebarCollapse /></template>
        <template #right>
          <div v-if="billing?.plan" class="flex items-center gap-2">
            <UBadge :label="`${billing.plan.name} Plan`" :color="billing.plan.id === 'team' ? 'primary' : billing.plan.id === 'pro' ? 'secondary' : 'neutral'" variant="subtle" size="sm" />
            <span class="text-xs text-muted font-mono tabular-nums">
              {{ billing.usage?.builds_used || 0 }} / {{ billing.plan.builds_per_month === -1 ? '∞' : billing.plan.builds_per_month }} builds
            </span>
          </div>
        </template>
      </UDashboardNavbar>
    </template>
    <template #body>
      <div class="max-w-6xl w-full mx-auto">
        <ClientOnly>
          <div v-if="state === 'loading'" class="space-y-4">
            <USkeleton class="h-10 w-64" />
            <USkeleton class="h-28 w-full" />
            <USkeleton class="h-64 w-full" />
          </div>

          <UPageCTA
            v-else-if="state === 'anon'"
            title="Sign in to see your projects"
            description="Your dashboard lists every project, monorepo application, and deployment tied to your account."
            variant="subtle"
            :links="[
              { label: 'Continue with GitHub', icon: 'i-simple-icons-github', size: 'lg', onClick: () => login('github', 'login', '/dashboard/') },
              { label: 'Team SAML SSO', icon: 'i-lucide-shield-check', size: 'lg', color: 'neutral', to: '/api/auth/saml/login' }
            ]"
          />

          <UPageCTA v-else-if="state === 'error'" title="Could not load projects" :description="errMsg" variant="subtle" :links="[{ label: 'Retry', onClick: start }]" />

          <template v-else>
            <!-- Quota Exceeded Banner -->
            <UAlert
              v-if="billing?.plan?.builds_per_month !== -1 && (billing?.usage?.builds_used || 0) >= billing?.plan?.builds_per_month"
              color="error"
              variant="subtle"
              icon="i-lucide-triangle-alert"
              title="Build Quota Exceeded"
              description="You have reached your monthly build quota on the Hobby plan. Upgrade to Pro ($20/mo) or Team ($80/mo) to continue building."
              class="mb-6"
            >
              <template #actions>
                <UButton to="/docs#pricing" label="Upgrade Plan" color="neutral" size="xs" />
              </template>
            </UAlert>

            <UPageHeader headline="Dashboard" title="Your projects" :description="`Signed in as @${user?.login}`" class="border-none pt-0">
              <template #links>
                <UButton to="/new/" label="New project" icon="i-lucide-plus" />
              </template>
            </UPageHeader>

            <div class="grid gap-4 sm:grid-cols-3 my-8">
              <UCard v-for="k in kpis" :key="k.label">
                <div class="flex items-center gap-3">
                  <UIcon :name="k.icon" class="size-5 text-muted" />
                  <span class="text-sm text-muted">{{ k.label }}</span>
                </div>
                <p class="mt-2 text-3xl font-bold text-highlighted font-mono tabular-nums">{{ k.value }}</p>
              </UCard>
            </div>

            <UPageCTA
              v-if="!projects.length"
              title="No projects yet."
              description="Import a Git repository (GitHub or Bitbucket), upload a folder, or start from a template."
              variant="soft"
              :links="[{ label: 'Create your first project', to: '/new/' }]"
            />

            <div v-else class="grid gap-6 lg:grid-cols-3">
              <!-- Left Project List -->
              <div class="space-y-2">
                <UPageCard
                  v-for="p in projects"
                  :key="p.id"
                  :title="p.name"
                  :description="p.repo_full_name || 'Uploaded files'"
                  :highlight="p.id === sel"
                  highlight-color="neutral"
                  variant="subtle"
                  class="cursor-pointer"
                  @click="select(p.id)"
                >
                  <template #footer>
                    <div class="flex items-center gap-2 text-xs text-muted">
                      <UBadge :label="p.latest_deployment?.status || p.status" :color="STATUS[p.latest_deployment?.status || p.status] || 'neutral'" variant="subtle" size="sm" />
                      <UBadge v-if="p.latest_deployment?.is_rollback" label="Rollback" color="secondary" variant="subtle" size="sm" />
                      <span>{{ [FW[p.framework] || p.framework, p.latest_deployment ? `${p.latest_deployment.environment} · ${timeAgo(p.latest_deployment.created_at)}` : `created ${timeAgo(p.created_at)}`].filter(Boolean).join(' · ') }}</span>
                    </div>
                  </template>
                </UPageCard>
              </div>

              <!-- Right Project Detail Panel -->
              <UCard v-if="cur" class="lg:col-span-2">
                <template #header>
                  <div class="flex flex-wrap items-start justify-between gap-3">
                    <div>
                      <h2 class="text-xl font-bold text-highlighted">{{ cur.name }}</h2>
                      <div class="mt-2 flex flex-wrap gap-2">
                        <UBadge :label="cur.status" :color="STATUS[cur.status] || 'neutral'" variant="subtle" />
                        <UBadge :label="cur.repo_full_name ? `${LABEL[cur.provider] || cur.provider} · ${cur.repo_full_name}` : 'Upload'" color="neutral" variant="subtle" />
                        <UBadge v-if="cur.private" label="Private" color="neutral" variant="outline" />
                        <UBadge :label="FW[cur.framework] || cur.framework || 'Other'" color="neutral" variant="subtle" />
                        <UBadge :label="wsLabel(cur.webhook_status)" :color="cur.webhook_status === 'active' ? 'success' : 'neutral'" variant="subtle" />
                      </div>
                    </div>
                    <div class="flex gap-2">
                      <UButton v-if="safeUrl(cur.url)" :to="safeUrl(cur.url)" target="_blank" label="Visit" color="neutral" variant="subtle" trailing-icon="i-lucide-arrow-up-right" />
                      <UButton label="Redeploy" icon="i-lucide-zap" :loading="busy" @click="redeploy" />
                    </div>
                  </div>
                </template>

                <UAlert v-if="safeUrl(cur.url)" color="success" variant="subtle" icon="i-lucide-radio" title="Production" :description="cur.url" class="mb-4" />
                <UAlert v-if="depAlert" color="error" variant="subtle" :title="depAlert" class="mb-4" />

                <!-- Navigation Tabs: Deployments vs Monorepo Apps -->
                <div class="flex items-center gap-2 border-b border-default pb-2 mb-4">
                  <UButton
                    size="xs"
                    :variant="activeTab === 'deployments' ? 'solid' : 'ghost'"
                    :color="activeTab === 'deployments' ? 'neutral' : 'neutral'"
                    label="Deployments & Rollback"
                    icon="i-lucide-history"
                    @click="activeTab = 'deployments'"
                  />
                  <UButton
                    size="xs"
                    :variant="activeTab === 'monorepo' ? 'solid' : 'ghost'"
                    :color="activeTab === 'monorepo' ? 'neutral' : 'neutral'"
                    :label="`Monorepo Apps (${projectApps.length})`"
                    icon="i-lucide-boxes"
                    @click="activeTab = 'monorepo'"
                  />
                </div>

                <!-- TAB 1: Deployments with Rollback -->
                <div v-if="activeTab === 'deployments'">
                  <h3 class="font-semibold text-highlighted mb-2">Deployments History</h3>
                  <UAlert v-if="depsErr" color="error" variant="subtle" :title="depsErr" />
                  <p v-else-if="!deps.length" class="text-sm text-muted py-6 text-center">No deployments yet. Hit “Redeploy” to ship this project.</p>
                  <div v-else class="divide-y divide-default rounded-lg ring ring-default">
                    <div
                      v-for="x in deps"
                      :key="x.id"
                      class="flex items-center justify-between gap-3 px-4 py-3 hover:bg-elevated/50 transition-colors cursor-pointer"
                      :class="x.id === depSel ? 'bg-elevated/60' : ''"
                      @click="depSel = x.id"
                    >
                      <div class="flex items-center gap-3 min-w-0">
                        <UBadge :label="x.status" :color="STATUS[x.status] || 'neutral'" variant="subtle" size="sm" />
                        <UBadge v-if="x.is_rollback" :label="`Rollback to #${x.rollback_from_id?.slice(0, 7)}`" color="secondary" variant="subtle" size="xs" />
                        <div class="min-w-0">
                          <p class="text-sm font-medium text-highlighted truncate">
                            {{ x.environment }}{{ x.ref ? ' · ' + x.ref : '' }}
                          </p>
                          <p class="text-xs text-muted font-mono tabular-nums">
                            {{ x.step }}{{ x.commit_sha ? ' · ' + x.commit_sha.slice(0, 7) : '' }} · {{ timeAgo(x.created_at) }}
                          </p>
                        </div>
                      </div>

                      <div class="flex items-center gap-2 shrink-0" @click.stop>
                        <UButton
                          v-if="canRollback(x)"
                          size="xs"
                          color="neutral"
                          variant="outline"
                          icon="i-lucide-rotate-ccw"
                          label="Rollback"
                          :loading="rollbackBusy === x.id"
                          @click="rollbackTo(x)"
                        />
                      </div>
                    </div>
                  </div>

                  <!-- Build Log Preview -->
                  <template v-if="selDep">
                    <div class="mt-6 flex items-center justify-between">
                      <h3 class="font-semibold text-highlighted">
                        Log <span class="text-xs text-muted font-mono">{{ selDep.id.slice(0, 8) }} — {{ selDep.status }}</span>
                      </h3>
                      <UButton label="Copy" icon="i-lucide-copy" size="xs" color="neutral" variant="ghost" @click="copyLog" />
                    </div>
                    <pre class="mt-2 max-h-80 overflow-auto rounded-lg bg-elevated/60 ring ring-default p-4 text-xs font-mono text-toned whitespace-pre-wrap">{{ selDep.log || '(empty)' }}</pre>
                  </template>
                </div>

                <!-- TAB 2: Visual Monorepo App Directory Manager -->
                <div v-else-if="activeTab === 'monorepo'" class="space-y-4">
                  <div class="flex items-center justify-between">
                    <div>
                      <h3 class="font-semibold text-highlighted">Monorepo Applications</h3>
                      <p class="text-xs text-muted mt-1">
                        Each app has its own root directory, framework, and build command. Path-filtered builds only trigger when files inside an app's root directory change.
                      </p>
                    </div>
                    <UButton size="xs" label="Add App" icon="i-lucide-plus" @click="appFormOpen = !appFormOpen" />
                  </div>

                  <!-- Add Monorepo App Form -->
                  <div v-if="appFormOpen" class="p-4 rounded-lg border border-default bg-elevated/40 space-y-3">
                    <h4 class="text-sm font-semibold text-highlighted">Register New Monorepo App</h4>
                    <div class="grid gap-3 sm:grid-cols-2">
                      <div>
                        <label class="text-xs text-muted block mb-1">App Name</label>
                        <UInput v-model="newApp.name" placeholder="e.g. web, api, agent" size="sm" />
                      </div>
                      <div>
                        <label class="text-xs text-muted block mb-1">Root Directory</label>
                        <UInput v-model="newApp.root_dir" placeholder="e.g. apps/web or packages/bot" size="sm" />
                      </div>
                      <div>
                        <label class="text-xs text-muted block mb-1">Framework</label>
                        <UInput v-model="newApp.framework" placeholder="nuxt, nextjs, vite, other" size="sm" />
                      </div>
                      <div>
                        <label class="text-xs text-muted block mb-1">Build Command</label>
                        <UInput v-model="newApp.build_command" placeholder="npm run build" size="sm" />
                      </div>
                    </div>
                    <div class="flex justify-end gap-2 pt-2">
                      <UButton size="xs" variant="ghost" label="Cancel" @click="appFormOpen = false" />
                      <UButton size="xs" color="primary" label="Save App" @click="addApp" />
                    </div>
                  </div>

                  <!-- Monorepo App List -->
                  <div v-if="!projectApps.length" class="py-6 text-center text-sm text-muted rounded-lg border border-dashed border-default">
                    No monorepo apps configured. By default, the root directory (<code>.</code>) is built for all commits.
                  </div>

                  <div v-else class="divide-y divide-default rounded-lg ring ring-default">
                    <div v-for="app in projectApps" :key="app.id" class="flex items-center justify-between p-3">
                      <div>
                        <div class="flex items-center gap-2">
                          <span class="font-medium text-highlighted text-sm">{{ app.name }}</span>
                          <UBadge :label="app.framework" size="xs" color="neutral" variant="subtle" />
                        </div>
                        <p class="text-xs text-muted font-mono mt-0.5">
                          Root: <code>{{ app.root_dir }}</code> · Build: <code>{{ app.build_command || 'default' }}</code>
                        </p>
                      </div>
                      <UButton size="xs" color="error" variant="ghost" icon="i-lucide-trash-2" @click="removeApp(app.id)" />
                    </div>
                  </div>
                </div>
              </UCard>
            </div>
          </template>
        </ClientOnly>
      </div>
    </template>
  </UDashboardPanel>
</template>

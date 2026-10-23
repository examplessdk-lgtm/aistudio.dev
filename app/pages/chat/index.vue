<script setup lang="ts">
// Layout from the Nuxt UI chat template (UChatMessages + UChatPrompt inside a dashboard panel).
definePageMeta({ layout: 'dashboard' })
const title = 'Agent chat — Aibotq.dev'
const description = 'Ask the aibotq.dev assistant to deploy, diagnose build errors, stream live build logs, and manage agent environments.'
useSeoMeta({
  title,
  description,
  ogTitle: title,
  ogDescription: description,
  ogType: 'website',
  ogUrl: 'https://aibotq.dev/chat/',
  ogImage: 'https://aibotq.dev/icon-512.png',
  twitterCard: 'summary',
})

type ToolEv = {
  tool: string
  input: any
  output?: string
  error?: string
  pending?: { payload: string, sig: string }
  done?: string
  busy?: boolean
  // Live polling extension for bot-aware deployments
  liveDeploy?: {
    id: string
    status: 'queued' | 'building' | 'ready' | 'failed'
    step: string
    url?: string | null
    log?: string
    is_rollback?: boolean
  }
}

type Msg = {
  id: string
  role: 'user' | 'assistant'
  parts: { type: 'text', text: string }[]
  tools?: ToolEv[]
}

const files = ref<{ name: string, type: string, text?: string, base64?: string }[]>([])
const fileInput = ref<HTMLInputElement>()

async function pickFiles(e: Event) {
  for (const f of Array.from((e.target as HTMLInputElement).files || [])) {
    if (f.size > 4_000_000) {
      error.value = `${f.name} is too large (max 4 MB)`
      continue
    }
    if (/^image\/(png|jpeg|webp)$/i.test(f.type)) {
      if (f.size > 4 * 1024 * 1024) continue
      const b = new Uint8Array(await f.arrayBuffer())
      let s = ''
      for (let i = 0; i < b.length; i += 32768) s += String.fromCharCode(...b.subarray(i, i + 32768))
      files.value.push({ name: f.name, type: f.type, base64: btoa(s) })
    } else if (/pdf/i.test(f.type) || f.name.toLowerCase().endsWith('.pdf')) {
      const b = new Uint8Array(await f.arrayBuffer())
      let s = ''
      for (let i = 0; i < b.length; i += 32768) s += String.fromCharCode(...b.subarray(i, i + 32768))
      files.value.push({ name: f.name, type: 'application/pdf', base64: btoa(s) })
    } else {
      files.value.push({ name: f.name, type: f.type || 'text/plain', text: await f.text() })
    }
  }
  if (fileInput.value) fileInput.value.value = ''
}

// Owner mode
const adminToken = ref('')
const isAdmin = ref(false)
const adminOpen = ref(false)
const adminInput = ref('')

async function checkAdmin(t: string) {
  const r = await fetch('/api/chat/admin', { method: 'POST', headers: { 'x-admin-token': t } }).then(r => r.json()).catch(() => null)
  isAdmin.value = !!r?.data?.admin
  return r?.data
}

onMounted(async () => {
  const t = sessionStorage.getItem('aibotq_admin')
  const d = await checkAdmin(t || '')
  if (t && d?.admin && d?.via === 'token') adminToken.value = t
})

async function saveAdmin() {
  const d = await checkAdmin(adminInput.value)
  if (d?.admin) {
    adminToken.value = adminInput.value
    sessionStorage.setItem('aibotq_admin', adminInput.value)
    adminOpen.value = false
    error.value = ''
  } else {
    error.value = d?.configured === false ? 'Owner mode is not configured on the server (ADMIN_CHAT_TOKEN missing).' : 'Wrong owner token.'
  }
  adminInput.value = ''
}

function logoutAdmin() {
  sessionStorage.removeItem('aibotq_admin')
  adminToken.value = ''
  isAdmin.value = false
}

async function confirmTool(t: ToolEv) {
  t.busy = true
  const r = await fetch('/api/chat/confirm', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-admin-token': adminToken.value },
    body: JSON.stringify(t.pending),
  }).then(r => r.json()).catch(e => ({ ok: false, error: e.message }))
  t.busy = false
  t.done = r.ok ? JSON.stringify(r.data) : 'Error: ' + r.error
  if (r.ok) t.pending = undefined
}

const messages = ref<Msg[]>([])
const input = ref('')
onMounted(() => {
  const q = new URLSearchParams(location.search).get('q')
  if (q) input.value = q.slice(0, 500)
})

const status = ref<'ready' | 'submitted' | 'error'>('ready')
const error = ref('')
type ModelDef = { id: string, label: string, provider: string }
const { data: modelInfo } = await useFetch<any>('/api/models', { default: () => null })
const models = computed<ModelDef[]>(() => modelInfo.value?.data?.models || [])
const model = ref<string | undefined>(modelInfo.value?.data?.default || undefined)
watch(modelInfo, v => {
  if (!model.value) model.value = v?.data?.default || undefined
})
const modelItems = computed(() => models.value.map(m => ({ label: m.label, value: m.id })))
const lastUsed = ref('')

const suggestions = [
  'สถานะ build ล่าสุดคืออะไร',
  'ทำไม build ถึงล้มเหลว และต้องแก้อย่างไร',
  'Deploy my project to production',
  'List all my recent deployments and rollbacks',
]

// Polling manager for real-time live streaming logs & status
const activePollers = new Set<string>()

function trackDeployment(toolEv: ToolEv, deployId: string, initialStatus = 'queued') {
  if (!deployId || activePollers.has(deployId)) return
  activePollers.add(deployId)
  toolEv.liveDeploy = {
    id: deployId,
    status: initialStatus as any,
    step: 'checking status...',
  }

  const poll = async () => {
    try {
      const res = await fetch(`/api/deployments/${encodeURIComponent(deployId)}`)
      if (!res.ok) {
        activePollers.delete(deployId)
        return
      }
      const j = await res.json()
      const d = j.data?.deployment || j.deployment
      if (d && toolEv.liveDeploy) {
        toolEv.liveDeploy.status = d.status
        toolEv.liveDeploy.step = d.step
        toolEv.liveDeploy.url = d.url
        toolEv.liveDeploy.log = d.log
        toolEv.liveDeploy.is_rollback = d.is_rollback

        if (d.status === 'queued' || d.status === 'building') {
          setTimeout(poll, 2000)
        } else {
          activePollers.delete(deployId)
        }
      }
    } catch {
      activePollers.delete(deployId)
    }
  }

  setTimeout(poll, 1500)
}

function inspectToolForDeployments(tools?: ToolEv[]) {
  if (!tools) return
  for (const t of tools) {
    if (t.output) {
      try {
        const parsed = JSON.parse(t.output)
        const depId = parsed.deployment_id || parsed.new_deployment_id || parsed.id || parsed.latest_deployment?.id
        if (depId && (parsed.status === 'queued' || parsed.status === 'building' || t.tool === 'deploy_project')) {
          trackDeployment(t, depId, parsed.status || 'queued')
        }
      } catch {}
    }
  }
}

async function send(text?: string) {
  const t = (text ?? input.value).trim()
  if (!t || status.value === 'submitted') return
  input.value = ''
  error.value = ''
  messages.value.push({ id: crypto.randomUUID(), role: 'user', parts: [{ type: 'text', text: t }] })
  status.value = 'submitted'
  try {
    const res = await fetch('/api/chat', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(adminToken.value ? { 'x-admin-token': adminToken.value } : {}),
      },
      body: JSON.stringify({
        model: model.value,
        files: files.value,
        messages: messages.value.map(m => ({ role: m.role, content: m.parts[0]!.text })),
      }),
    })
    const j = await res.json().catch(() => null)
    if (!j?.ok) throw new Error(j?.error || `Request failed (HTTP ${res.status})`)

    const assistantMsg: Msg = {
      id: crypto.randomUUID(),
      role: 'assistant',
      parts: [{ type: 'text', text: j.data.text }],
      tools: j.data.tools || [],
    }
    messages.value.push(assistantMsg)
    inspectToolForDeployments(assistantMsg.tools)

    lastUsed.value = (models.value.find(m => m.id === j.data.model)?.label || j.data.model) + (j.data.fallback ? ' (fallback)' : '')
    status.value = 'ready'
  } catch (e: any) {
    error.value = e.message
    status.value = 'error'
  }
}

function parseOutputJson(out?: string) {
  if (!out) return null
  try {
    return JSON.parse(out)
  } catch {
    return null
  }
}
</script>

<template>
  <UDashboardPanel id="chat" :ui="{ body: 'p-0 sm:p-0' }">
    <template #header>
      <UDashboardNavbar title="Agent chat" icon="i-lucide-message-square">
        <template #leading><UDashboardSidebarCollapse /></template>
        <template #right>
          <UButton
            :icon="isAdmin ? 'i-lucide-shield-check' : 'i-lucide-shield'"
            :color="isAdmin ? 'primary' : 'neutral'"
            variant="ghost"
            size="sm"
            :label="isAdmin ? 'Owner' : undefined"
            aria-label="Owner mode"
            @click="isAdmin ? logoutAdmin() : (adminOpen = !adminOpen)"
          />
          <USelect v-if="modelItems.length" v-model="model" :items="modelItems" size="sm" color="neutral" variant="outline" class="w-44" aria-label="Model" />
        </template>
      </UDashboardNavbar>
    </template>

    <template #body>
      <UContainer class="flex-1 flex flex-col gap-4 sm:gap-6 py-8 max-w-3xl">
        <div v-if="!messages.length" class="my-auto text-center space-y-6">
          <img src="/logo-mark.svg" alt="" class="size-12 mx-auto">
          <h1 class="text-3xl font-bold text-highlighted">Bot-Aware Agent Deployment</h1>
          <p class="text-sm text-muted max-w-md mx-auto">
            Directly connected to the build pipeline and D1. Ask about real build progress, diagnose failures with logs, or ship to the edge.
          </p>
          <div class="flex flex-wrap justify-center gap-2">
            <UButton v-for="s in suggestions" :key="s" :label="s" color="neutral" variant="outline" size="sm" class="rounded-full" @click="send(s)" />
          </div>
        </div>

        <UChatMessages v-else :messages="messages" :status="status === 'error' ? 'ready' : status" :assistant="{ variant: 'naked' }" :user="{ variant: 'soft' }" should-auto-scroll>
          <template #content="{ message }">
            <!-- Tool Calls & Real-time Live Status Badges -->
            <div v-if="(message as any).tools?.length" class="flex flex-col gap-2 mb-3">
              <div v-for="(t, i) in (message as any).tools" :key="i" class="rounded-lg border border-default bg-elevated/60 p-3 space-y-2">
                <!-- Header with Real-Time Badge -->
                <div class="flex items-center justify-between gap-2">
                  <div class="flex items-center gap-2 text-xs">
                    <UIcon :name="t.error ? 'i-lucide-circle-x' : t.pending ? 'i-lucide-clock' : 'i-lucide-wrench'" class="size-4 text-muted" />
                    <span class="font-mono font-medium text-highlighted">{{ t.tool }}</span>
                  </div>

                  <!-- Real-time Live Status Badge -->
                  <div v-if="t.liveDeploy" class="flex items-center gap-2">
                    <UBadge
                      :label="t.liveDeploy.status"
                      :color="t.liveDeploy.status === 'ready' ? 'success' : t.liveDeploy.status === 'failed' ? 'error' : t.liveDeploy.status === 'building' ? 'primary' : 'neutral'"
                      variant="subtle"
                      size="sm"
                    />
                    <span v-if="t.liveDeploy.is_rollback" class="text-xs text-secondary font-medium">Rollback</span>
                    <span class="text-xs text-muted font-mono tabular-nums">{{ t.liveDeploy.step }}</span>
                  </div>
                  <div v-else-if="parseOutputJson(t.output)?.status" class="flex items-center gap-2">
                    <UBadge
                      :label="parseOutputJson(t.output)?.status"
                      :color="parseOutputJson(t.output)?.status === 'ready' ? 'success' : parseOutputJson(t.output)?.status === 'failed' ? 'error' : 'neutral'"
                      variant="subtle"
                      size="sm"
                    />
                  </div>
                </div>

                <!-- Live Streaming Log Box if Deploying or Diagnosing -->
                <div v-if="t.liveDeploy?.log || parseOutputJson(t.output)?.log_tail || parseOutputJson(t.output)?.error_lines?.length" class="mt-2">
                  <!-- Failing Step Alert if Failed -->
                  <div v-if="t.liveDeploy?.status === 'failed' || parseOutputJson(t.output)?.status === 'failed'" class="mb-2 p-2 rounded bg-rose-500/10 border border-rose-500/30 text-xs text-rose-300">
                    <span class="font-semibold">Failing Step:</span> {{ t.liveDeploy?.step || parseOutputJson(t.output)?.failing_step || 'Build failure' }}
                    <div v-if="parseOutputJson(t.output)?.diagnosis" class="mt-1 text-muted text-xs">
                      {{ parseOutputJson(t.output)?.diagnosis }}
                    </div>
                  </div>

                  <!-- Live Log Terminal Snippet -->
                  <pre class="max-h-48 overflow-auto rounded bg-black/50 p-2.5 font-mono text-[11px] leading-relaxed text-emerald-400 whitespace-pre-wrap">{{ t.liveDeploy?.log || parseOutputJson(t.output)?.log_tail || '(Streaming build logs...)' }}</pre>

                  <!-- Live Visit Link when ready -->
                  <div v-if="(t.liveDeploy?.status === 'ready' && t.liveDeploy?.url) || parseOutputJson(t.output)?.live_url" class="mt-2 flex items-center justify-between">
                    <span class="text-xs text-emerald-400 flex items-center gap-1 font-mono">
                      <UIcon name="i-lucide-check-circle" class="size-3.5" /> Deployed Live
                    </span>
                    <UButton
                      size="xs"
                      color="neutral"
                      variant="subtle"
                      trailing-icon="i-lucide-arrow-up-right"
                      :to="t.liveDeploy?.url || parseOutputJson(t.output)?.live_url"
                      target="_blank"
                      label="Open Live App"
                    />
                  </div>
                </div>

                <!-- Collapsible Technical Details -->
                <details class="text-xs text-muted pt-1">
                  <summary class="cursor-pointer hover:text-highlighted">Show raw tool payload</summary>
                  <pre class="whitespace-pre-wrap break-all mt-1 bg-black/30 p-2 rounded text-[11px] font-mono">{{ t.error ? 'error: ' + t.error : t.output || 'No output' }}</pre>
                </details>

                <div v-if="t.pending" class="mt-1">
                  <UButton size="xs" color="primary" :loading="t.busy" label="Confirm and run" @click="confirmTool(t)" />
                </div>
                <pre v-if="t.done" class="whitespace-pre-wrap break-all mt-1 text-xs">{{ t.done }}</pre>
              </div>
            </div>

            <!-- Assistant Response Text -->
            <p class="whitespace-pre-wrap">{{ message.parts[0]?.text }}</p>
          </template>
        </UChatMessages>
      </UContainer>
    </template>

    <template #footer>
      <UContainer class="pb-4 sm:pb-6 max-w-3xl">
        <form v-if="adminOpen && !isAdmin" class="flex gap-2 mb-3" @submit.prevent="saveAdmin">
          <UInput v-model="adminInput" type="password" placeholder="Owner token" class="flex-1" autocomplete="off" />
          <UButton type="submit" label="Unlock" color="neutral" />
        </form>
        <div v-if="files.length" class="flex flex-wrap gap-1 mb-2">
          <UBadge v-for="(f, i) in files" :key="f.name" color="neutral" variant="subtle">
            {{ f.name }} <UIcon name="i-lucide-x" class="cursor-pointer" @click="files.splice(i, 1)" />
          </UBadge>
        </div>
        <UAlert v-if="error" color="error" variant="subtle" :title="error" icon="i-lucide-triangle-alert" class="mb-3" />
        <UChatPrompt
          v-model="input"
          placeholder="Ask in Thai or English: สถานะ build ล่าสุด, deploy project, check errors…"
          variant="subtle"
          :status="status === 'submitted' ? 'submitted' : 'ready'"
          @submit="send()"
        >
          <input
            ref="fileInput"
            type="file"
            multiple
            class="hidden"
            accept=".txt,.md,.json,.csv,.pdf,.ts,.js,.vue,.html,.css,.py,.yaml,.yml,.toml,text/*,application/pdf,image/png,image/jpeg,image/webp"
            @change="pickFiles"
          >
          <UButton icon="i-lucide-paperclip" color="neutral" variant="ghost" size="sm" aria-label="Attach file" @click="fileInput?.click()" />
          <span v-if="lastUsed" class="text-xs text-muted me-auto">Answered by {{ lastUsed }}</span>
          <UChatPromptSubmit :status="status === 'submitted' ? 'submitted' : 'ready'" color="neutral" />
        </UChatPrompt>
      </UContainer>
    </template>
  </UDashboardPanel>
</template>

const BASE_URL = '/api'

class ApiError extends Error {
  status: number
  constructor(message: string, status: number) {
    super(message)
    this.status = status
  }
}

function getAuthHeader(): Record<string, string> {
  const token = localStorage.getItem('access_token')
  return token ? { Authorization: `Bearer ${token}` } : {}
}

async function request<T>(path: string, options?: RequestInit): Promise<T> {
  const res = await fetch(`${BASE_URL}${path}`, {
    headers: {
      'Content-Type': 'application/json',
      ...getAuthHeader(),
      ...options?.headers,
    },
    ...options,
  })
  if (!res.ok) {
    if (res.status === 401) {
      localStorage.removeItem('access_token')
      localStorage.removeItem('refresh_token')
      window.location.href = '/login'
    }
    const body = await res.text()
    throw new ApiError(body, res.status)
  }
  return res.json()
}

// Auth
export interface TokenResponse {
  access_token: string
  refresh_token: string
  token_type: string
}

export const register = (username: string, password: string) =>
  request<TokenResponse>('/auth/register', {
    method: 'POST',
    body: JSON.stringify({ username, password }),
  })

export const login = (username: string, password: string) =>
  request<TokenResponse>('/auth/login', {
    method: 'POST',
    body: JSON.stringify({ username, password }),
  })

export const refreshToken = (refresh_token: string) =>
  request<TokenResponse>('/auth/refresh', {
    method: 'POST',
    body: JSON.stringify({ refresh_token }),
  })

// Datasets
export interface Dataset {
  id: number
  name: string
  topic: string
  status: string
  provider: string | null
  model: string | null
  target_size: number
  actual_size: number
  valid_count: number
  invalid_count: number
  healed_count: number
  prompt_tokens: number
  completion_tokens: number
  total_tokens: number
  gpu_kwh: number
  duration_seconds: number
  output_path: string | null
  system_prompt: string | null
  temperature: number
  max_tokens: number | null
  hf_repo: string | null
  created_at: string | null
  started_at: string | null
  completed_at: string | null
  error_message: string | null
}

export interface DatasetListResponse {
  datasets: Dataset[]
  total: number
  page: number
  per_page: number
}

export interface CreateDatasetRequest {
  topic: string
  provider?: string | null
  model?: string | null
  target_size?: number
  system_prompt?: string | null
  temperature?: number
  max_tokens?: number | null
}

export const createDataset = (data: CreateDatasetRequest) =>
  request<Dataset>('/datasets', { method: 'POST', body: JSON.stringify(data) })

export const createBatchDatasets = (datasets: CreateDatasetRequest[]) =>
  request<Dataset[]>('/datasets/batch', { method: 'POST', body: JSON.stringify({ datasets }) })

export const getDatasets = (page = 1) =>
  request<DatasetListResponse>(`/datasets?page=${page}`)

export interface AggregateStats {
  dataset_count: number
  completed_datasets: number
  failed_datasets: number
  running_datasets: number
  paper_count: number
  training_count: number
  total_prompt_tokens: number
  total_completion_tokens: number
  total_tokens: number
  total_gpu_kwh: number
  total_qa_pairs: number
  total_generation_seconds: number
  paper_by_topic: {
    topic: string
    count: number
  }[]
  per_dataset: {
    topic: string
    total_tokens: number
    prompt_tokens: number
    completion_tokens: number
    qa_pairs: number
    created_at: string | null
  }[]
}

export const getAggregateStats = () =>
  request<AggregateStats>('/datasets/stats')

export const getDataset = (id: number) =>
  request<Dataset>(`/datasets/${id}`)

export const cancelDataset = (id: number) =>
  request<{ status: string }>(`/datasets/${id}/cancel`, { method: 'POST' })

export const deleteDataset = (id: number) =>
  request<{ status: string }>(`/datasets/${id}`, { method: 'DELETE' })

export const retryDataset = (id: number) =>
  request<Dataset>(`/datasets/${id}/retry`, { method: 'POST' })

export async function exportDataset(id: number, format: 'jsonl' | 'csv' = 'jsonl') {
  const res = await fetch(`${BASE_URL}/datasets/${id}/export?fmt=${format}`, {
    headers: { ...getAuthHeader() },
  })
  if (!res.ok) throw new ApiError(await res.text(), res.status)
  const blob = await res.blob()
  const disposition = res.headers.get('content-disposition') || ''
  const match = disposition.match(/filename="(.+)"/)
  const filename = match ? match[1] : `dataset_${id}.${format}`
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}

export interface QAPair {
  id: number | null
  instruction: string
  output: string
  is_valid: boolean
  was_healed: boolean
  source_title: string | null
  think_text: string | null
  answer_text: string | null
}

export interface DatasetSamplesResponse {
  samples: QAPair[]
  total: number
  page: number
  per_page: number
}

export const getDatasetSamples = (id: number, page = 1, search?: string) => {
  const params = new URLSearchParams({ page: String(page) })
  if (search) params.set('search', search)
  return request<DatasetSamplesResponse>(`/datasets/${id}/samples?${params}`)
}

// Generate from papers
export interface CreateFromPapersRequest {
  paper_ids: number[]
  provider?: string | null
  model?: string | null
  system_prompt?: string | null
  temperature?: number
  max_tokens?: number | null
}

export const createDatasetFromPapers = (data: CreateFromPapersRequest) =>
  request<Dataset>('/datasets/from-papers', { method: 'POST', body: JSON.stringify(data) })

// Import from HuggingFace
export const importFromHuggingFace = (data: { repo_id: string; split?: string }) =>
  request<Dataset>('/datasets/import-hf', { method: 'POST', body: JSON.stringify(data) })

// Delete QA pair
export const deleteQAPair = (datasetId: number, qaId: number) =>
  request<{ status: string }>(`/datasets/${datasetId}/samples/${qaId}`, { method: 'DELETE' })

// HuggingFace Push
export interface HFPushResponse {
  repo_url: string
  hf_repo: string
}

export const pushToHuggingFace = (id: number, data: {
  repo_name: string
  description?: string
  private?: boolean
}) =>
  request<HFPushResponse>(`/datasets/${id}/push-hf`, {
    method: 'POST',
    body: JSON.stringify(data),
  })

// Providers
export interface ProviderInfo {
  name: string
  default_model: string
  api_key_env: string | null
  has_key: boolean
}

export const getProviders = () => request<ProviderInfo[]>('/providers')

export const getOllamaModels = () => request<string[]>('/providers/models')

// Settings - API Keys
export interface ApiKeyInfo {
  provider_name: string
  masked_key: string
  updated_at: string | null
}

export const getApiKeys = () => request<ApiKeyInfo[]>('/settings/keys')

export const saveApiKey = (provider: string, api_key: string) =>
  request<{ status: string }>(`/settings/keys/${provider}`, {
    method: 'PUT',
    body: JSON.stringify({ api_key }),
  })

export const deleteApiKey = (provider: string) =>
  request<{ status: string }>(`/settings/keys/${provider}`, { method: 'DELETE' })

// Settings - HF Token
export interface HFTokenStatus {
  configured: boolean
}

export const getHFTokenStatus = () => request<HFTokenStatus>('/settings/hf-token')

export const saveHFToken = (token: string) =>
  request<{ status: string }>('/settings/hf-token', {
    method: 'PUT',
    body: JSON.stringify({ token }),
  })

export const deleteHFToken = () =>
  request<{ status: string }>('/settings/hf-token', { method: 'DELETE' })

// Settings - Semantic Scholar API Key
export interface S2TokenStatus {
  configured: boolean
}

export const getS2TokenStatus = () => request<S2TokenStatus>('/settings/s2-token')

export const saveS2Token = (token: string) =>
  request<{ status: string }>('/settings/s2-token', {
    method: 'PUT',
    body: JSON.stringify({ token }),
  })

export const deleteS2Token = () =>
  request<{ status: string }>('/settings/s2-token', { method: 'DELETE' })

// Settings - CORE API Key
export interface CoreTokenStatus {
  configured: boolean
}

export const getCoreTokenStatus = () => request<CoreTokenStatus>('/settings/core-token')

export const saveCoreToken = (token: string) =>
  request<{ status: string }>('/settings/core-token', {
    method: 'PUT',
    body: JSON.stringify({ token }),
  })

export const deleteCoreToken = () =>
  request<{ status: string }>('/settings/core-token', { method: 'DELETE' })

// Papers
export interface PaperInfo {
  id: number
  paper_id: string | null
  title: string
  authors: string[]
  abstract: string | null
  year: number | null
  doi: string | null
  url: string | null
  source: string | null
  citation_count: number
  qa_pair_count: number
  pdf_url: string | null
  pdf_path: string | null
  dataset_id: number | null
}

export interface PaperListResponse {
  papers: PaperInfo[]
  total: number
  page: number
  per_page: number
}

export const deletePaper = (id: number) =>
  request<{ status: string }>(`/papers/${id}`, { method: 'DELETE' })

export const bulkDeletePapers = (paper_ids: number[]) =>
  request<{ deleted: number }>('/papers/bulk-delete', {
    method: 'POST',
    body: JSON.stringify({ paper_ids }),
  })

export const getPapers = (page = 1, search?: string, datasetId?: number, topic?: string) => {
  const params = new URLSearchParams({ page: String(page), per_page: '50' })
  if (search) params.set('search', search)
  if (datasetId) params.set('dataset_id', String(datasetId))
  if (topic) params.set('topic', topic)
  return request<PaperListResponse>(`/papers?${params}`)
}

export const getPaperTopics = () => request<string[]>('/papers/topics')

export const scrapePapers = (
  topic: string,
  max_results: number,
  year_min?: number | null,
  year_max?: number | null,
  sources?: string[] | null,
) =>
  request<{ saved: number; searched: number }>('/papers/scrape', {
    method: 'POST',
    body: JSON.stringify({
      topic,
      max_results,
      ...(year_min ? { year_min } : {}),
      ...(year_max ? { year_max } : {}),
      ...(sources && sources.length > 0 ? { sources } : {}),
    }),
  })

export interface ScrapeProgressEvent {
  stage: string
  message: string
  source?: string
  found?: number
  saved?: number
  searched?: number
  sources_total?: number
  sources_done?: number
}

export function scrapePapersStream(
  topic: string,
  max_results: number,
  year_min?: number | null,
  year_max?: number | null,
  sources?: string[] | null,
  onProgress?: (event: ScrapeProgressEvent) => void,
  onDone?: (event: ScrapeProgressEvent) => void,
): () => void {
  const token = localStorage.getItem('access_token')
  const controller = new AbortController()

  fetch(`${BASE_URL}/papers/scrape/stream`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify({
      topic,
      max_results,
      ...(year_min ? { year_min } : {}),
      ...(year_max ? { year_max } : {}),
      ...(sources && sources.length > 0 ? { sources } : {}),
    }),
    signal: controller.signal,
  }).then(async (res) => {
    if (!res.ok || !res.body) return
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''

    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })

      const lines = buffer.split('\n')
      buffer = lines.pop() || ''

      let currentEvent = ''
      for (const line of lines) {
        if (line.startsWith('event:')) {
          currentEvent = line.slice(6).trim()
        } else if (line.startsWith('data:')) {
          try {
            const data = JSON.parse(line.slice(5).trim()) as ScrapeProgressEvent
            if (currentEvent === 'done') {
              onDone?.(data)
            } else {
              onProgress?.(data)
            }
          } catch { /* skip malformed */ }
        }
      }
    }
  }).catch(() => { /* aborted or network error */ })

  return () => controller.abort()
}

export async function downloadPaperPdf(paperId: number, filename: string) {
  const res = await fetch(`${BASE_URL}/papers/${paperId}/pdf`, {
    headers: { ...getAuthHeader() },
  })
  if (!res.ok) {
    throw new ApiError(await res.text(), res.status)
  }
  const blob = await res.blob()
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename.endsWith('.pdf') ? filename : `${filename}.pdf`
  document.body.appendChild(a)
  a.click()
  a.remove()
  URL.revokeObjectURL(url)
}

// Galaxy
export interface GalaxyNode {
  id: string
  type: string
  label: string
  size: number
  color: string
  cluster: number
  year?: number | null
  citation_count?: number | null
  abstract?: string | null
  authors?: string[] | null
  url?: string | null
  qa_pair_count?: number
  instruction?: string | null
  answer_text?: string | null
  is_valid?: boolean | null
}

export interface GalaxyLink {
  source: string
  target: string
  weight: number
  type: string
}

export interface ClusterInfo {
  id: number
  label: string
  color: string
  paper_count: number
  qa_pair_count: number
}

export interface GalaxyData {
  nodes: GalaxyNode[]
  links: GalaxyLink[]
  clusters: ClusterInfo[]
}

export interface PaperDetail {
  paper_id: string
  title: string
  authors: string[]
  abstract: string | null
  year: number | null
  citation_count: number
  url: string | null
  total_qa_pairs: number
  qa_pairs: QAPair[]
}

export const getGalaxyData = () => request<GalaxyData>('/galaxy/data')
export const getPaperDetail = (paperId: number) =>
  request<PaperDetail>(`/galaxy/paper/${paperId}`)

// Training
export interface TrainingRun {
  id: number
  run_name: string
  status: string
  dataset_id: number | null
  base_model: string
  model_size: string
  lora_rank: number
  lora_alpha: number
  learning_rate: number
  num_epochs: number
  batch_size: number
  gradient_accumulation_steps: number
  max_steps: number
  dataset_path: string | null
  train_samples: number
  val_samples: number
  test_samples: number
  adapter_path: string | null
  output_dir: string | null
  final_loss: number | null
  total_steps: number | null
  training_runtime_seconds: number | null
  created_at: string | null
  started_at: string | null
  completed_at: string | null
  duration_seconds: number
  error_message: string | null
}

export interface TrainingRunListResponse {
  runs: TrainingRun[]
  total: number
  page: number
  per_page: number
}

export interface StartTrainingRequest {
  dataset_id?: number | null
  dataset_path?: string | null
  base_model?: string
  model_size?: string
  lora_rank?: number
  lora_alpha?: number
  learning_rate?: number
  num_epochs?: number
  batch_size?: number
  gradient_accumulation_steps?: number
  max_steps?: number
  dataset_config_name?: string | null
  model_config_name?: string | null
  training_config_name?: string | null
  resume_from_checkpoint?: string | null
}

export const startTraining = (data: StartTrainingRequest) =>
  request<TrainingRun>('/training/start', { method: 'POST', body: JSON.stringify(data) })

export const getTrainingRuns = (page = 1) =>
  request<TrainingRunListResponse>(`/training?page=${page}`)

export const getTrainingRun = (id: number) =>
  request<TrainingRun>(`/training/${id}`)

export const cancelTraining = (id: number) =>
  request<{ cancelled: boolean }>(`/training/${id}/cancel`, { method: 'POST' })

export const deleteTrainingRun = (id: number) =>
  request<{ deleted: boolean }>(`/training/${id}`, { method: 'DELETE' })

export const retryTrainingRun = (id: number) =>
  request<TrainingRun>(`/training/${id}/retry`, { method: 'POST' })

// Evaluations
export interface EvaluationRun {
  id: number
  run_name: string
  status: string
  training_run_id: number | null
  model_path: string | null
  test_dataset_path: string | null
  judge_model: string
  max_samples: number
  factual_accuracy: number | null
  completeness: number | null
  technical_precision: number | null
  overall_accuracy: number | null
  purity: number | null
  entropy: number | null
  samples_scored: number
  samples_skipped: number
  samples_failed: number
  created_at: string | null
  started_at: string | null
  completed_at: string | null
  duration_seconds: number
  error_message: string | null
}

export interface EvaluationRunListResponse {
  evaluations: EvaluationRun[]
  total: number
  page: number
  per_page: number
}

export interface StartEvaluationRequest {
  training_run_id?: number | null
  model_path?: string | null
  test_dataset_path?: string | null
  judge_model?: string
  max_samples?: number
}

export interface EvaluationDetail extends EvaluationRun {
  per_sample_results: unknown[]
  articles_log: unknown[]
  correction_results: Record<string, unknown> | null
}

export const startEvaluation = (data: StartEvaluationRequest) =>
  request<EvaluationRun>('/training/evaluate', { method: 'POST', body: JSON.stringify(data) })

export const getEvaluations = (page = 1) =>
  request<EvaluationRunListResponse>(`/training/evaluations?page=${page}`)

export const getEvaluationDetail = (id: number) =>
  request<EvaluationDetail>(`/training/evaluations/${id}`)

// Training Configs
export interface ConfigInfo {
  name: string
  display_name: string
  path: string
}

export interface ConfigListResponse {
  configs: ConfigInfo[]
}

export const getConfigs = (configType: string) =>
  request<ConfigListResponse>(`/training/configs/${configType}`)

// Training Artifacts
export interface ArtifactEntry {
  path: string
  label: string
}

export interface ArtifactListResponse {
  adapters: ArtifactEntry[]
  gguf_files: ArtifactEntry[]
  checkpoints: ArtifactEntry[]
  merged_models: ArtifactEntry[]
}

export const getArtifacts = () =>
  request<ArtifactListResponse>('/training/artifacts')

// Base Models
export const getBaseModels = () =>
  request<ArtifactEntry[]>('/training/base-models')

export function downloadBaseModel(
  repo_id: string,
  onProgress: (msg: { type: string; data?: string; percent?: number; path?: string; label?: string; status?: string }) => void,
): () => void {
  const token = localStorage.getItem('access_token') || ''
  const url = `${BASE_URL}/training/download-model?repo_id=${encodeURIComponent(repo_id)}`
  const es = new EventSource(url)

  // EventSource doesn't support custom headers, so we need fetch-based SSE
  // Actually, let's use fetch with streaming reader instead
  const controller = new AbortController()

  ;(async () => {
    try {
      const res = await fetch(url, {
        headers: { ...getAuthHeader() },
        signal: controller.signal,
      })
      if (!res.ok || !res.body) {
        onProgress({ type: 'error', data: `HTTP ${res.status}` })
        return
      }
      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''

      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n\n')
        buffer = lines.pop() || ''
        for (const block of lines) {
          const dataLine = block.split('\n').find(l => l.startsWith('data: '))
          if (dataLine) {
            try {
              const msg = JSON.parse(dataLine.slice(6))
              onProgress(msg)
            } catch { /* skip */ }
          }
        }
      }
    } catch (e) {
      if (!controller.signal.aborted) {
        onProgress({ type: 'error', data: e instanceof Error ? e.message : 'Download failed' })
      }
    }
  })()

  es.close()
  return () => controller.abort()
}

// Training Knobs
export const updateKnobs = (runId: number, data: { learning_rate?: number }) =>
  request<{ run_id: number; knobs: Record<string, number> }>(`/training/${runId}/knobs`, {
    method: 'POST',
    body: JSON.stringify(data),
  })

// Correction Agent
export const startCorrection = (evalId: number, data: { score_threshold?: number; model?: string }) =>
  request<{ eval_id: number; status: string }>(`/training/evaluate/${evalId}/correct`, {
    method: 'POST',
    body: JSON.stringify(data),
  })

// Merge/Convert
export interface MergeConvertRequest {
  adapter_path: string
  base_model?: string
  quant_method?: string
  output_name?: string
  keep_merged?: boolean
}

export interface MergeConvertResponse {
  gguf_path: string
  status: string
}

export const mergeConvert = (data: MergeConvertRequest) =>
  request<MergeConvertResponse>('/training/convert', {
    method: 'POST',
    body: JSON.stringify(data),
  })

// Push Model to HuggingFace
export interface PushModelRequest {
  repo_id: string
  gguf_path?: string
  merged_model_dir?: string
  private?: boolean
  base_model?: string
  description?: string
  dataset?: string
  author?: string
}

export interface PushModelResponse {
  repo_url: string
}

export const pushModel = (data: PushModelRequest) =>
  request<PushModelResponse>('/training/push', {
    method: 'POST',
    body: JSON.stringify(data),
  })

// Knowledge Base
export interface KBStatus {
  collection_count: number
  indexed_files: string[]
  indexed_file_count: number
  total_pdfs: number
  vector_store_dir: string
}

export interface KBSearchResult {
  content: string
  source_file: string
  metadata: Record<string, unknown>
}

export interface KBSearchResponse {
  results: KBSearchResult[]
  count: number
}

export interface KBChatResponse {
  answer: string
  sources: string[]
  chunks_used: number
  model?: string
}

export interface KBChatParams {
  query: string
  model?: string
  k?: number
  temperature?: number
  top_k?: number
  max_tokens?: number
}

export interface KBIndexResponse {
  total_pdfs: number
  indexed: number
  skipped: number
  chunks_added: number
}

export const getKBStatus = () => request<KBStatus>('/knowledge/status')

export interface KBIndexEvent {
  type: 'log' | 'skip' | 'index' | 'done'
  message?: string
  data?: string
  file?: string
  chunks?: number
  progress?: number
  total?: number
  total_pdfs?: number
  indexed?: number
  skipped?: number
  chunks_added?: number
}

export interface KBIndexStatus {
  running: boolean
  logs_count: number
}

export const startKBIndex = (force = false) =>
  request<{ status: string }>(`/knowledge/index?force=${force}`, { method: 'POST' })

export const getKBIndexStatus = () =>
  request<KBIndexStatus>('/knowledge/index/status')

export const stopKBIndex = () =>
  request<{ status: string }>('/knowledge/index/cancel', { method: 'POST' })

export function indexKBEvents(
  onEvent: (event: KBIndexEvent) => void,
  onDone?: () => void,
  lastId = 0,
): () => void {
  const controller = new AbortController()

  ;(async () => {
    try {
      const res = await fetch(`${BASE_URL}/knowledge/index/events?last_id=${lastId}`, {
        headers: { ...getAuthHeader() },
        signal: controller.signal,
      })
      if (!res.ok || !res.body) {
        onEvent({ type: 'log', message: `Error: HTTP ${res.status}` })
        onDone?.()
        return
      }
      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ''

      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n\n')
        buffer = lines.pop() || ''
        for (const block of lines) {
          const dataLine = block.split('\n').find(l => l.startsWith('data: '))
          if (dataLine) {
            try {
              const event = JSON.parse(dataLine.slice(6)) as KBIndexEvent
              onEvent(event)
              if (event.type === 'done') onDone?.()
            } catch { /* skip */ }
          }
        }
      }
      onDone?.()
    } catch (e) {
      if (!controller.signal.aborted) {
        onEvent({ type: 'log', message: e instanceof Error ? e.message : 'Indexing failed' })
        onDone?.()
      }
    }
  })()

  return () => controller.abort()
}

export const searchKB = (q: string, k = 5) =>
  request<KBSearchResponse>(`/knowledge/search?q=${encodeURIComponent(q)}&k=${k}`)

export const chatKB = (params: KBChatParams) =>
  request<KBChatResponse>('/knowledge/chat', {
    method: 'POST',
    body: JSON.stringify({
      query: params.query,
      model: params.model || 'gpt-oss:120b',
      k: params.k || 5,
      temperature: params.temperature ?? 0.7,
      top_k: params.top_k ?? 40,
      max_tokens: params.max_tokens ?? 2048,
    }),
  })

export const resetKB = () =>
  request<{ status: string }>('/knowledge/reset', { method: 'POST' })

// Health
export const getHealth = () => request<{ status: string }>('/health')

// Evolution Loop
export interface EvolutionSummary {
  evolution: number
  overall_score: number
  factual_accuracy: number
  completeness: number
  technical_precision: number
  best_score_so_far: number
  delta_from_previous: number
  consecutive_regressions: number
  consecutive_plateaus: number
  target_reached: boolean
  domain_scores: Record<string, Record<string, number>>
  started_at: string | null
  completed_at: string | null
}

export interface LoopStatus {
  loop_id: string
  status: string
  current_evolution: number
  current_stage: string
  stop_reason: string | null
  stop_requested: boolean
  created_at: string
  updated_at: string
  evolutions: EvolutionSummary[]
  config_snapshot: Record<string, unknown>
}

export interface LoopListEntry {
  loop_id: string
  status: string
  current_evolution: number
  current_stage: string
  stop_reason: string | null
  created_at: string
  updated_at: string
}

export interface LoopStartParams {
  config_path?: string
  dataset_id: number
  model_config?: string
  learning_rate?: number
  num_epochs?: number
  batch_size?: number
  gradient_accumulation_steps?: number
  max_steps?: number
  lora_rank?: number
  lora_alpha?: number
}

export const startLoop = (params: LoopStartParams) =>
  request<{ status: string; loop_id: string }>('/loop/start', {
    method: 'POST',
    body: JSON.stringify({
      config_path: params.config_path ?? null,
      dataset_id: params.dataset_id,
      model_config: params.model_config ?? '',
      learning_rate: params.learning_rate ?? null,
      num_epochs: params.num_epochs ?? null,
      batch_size: params.batch_size ?? null,
      gradient_accumulation_steps: params.gradient_accumulation_steps ?? null,
      max_steps: params.max_steps ?? null,
      lora_rank: params.lora_rank ?? null,
      lora_alpha: params.lora_alpha ?? null,
    }),
  })

export const stopLoop = () =>
  request<{ status: string; loop_id: string }>('/loop/stop', { method: 'POST' })

export const getLoopStatus = () =>
  request<LoopStatus | null>('/loop/status')

export const getLoopStatusById = (loopId: string) =>
  request<LoopStatus>(`/loop/status/${loopId}`)

export const listLoops = (limit = 20) =>
  request<LoopListEntry[]>(`/loop/list?limit=${limit}`)

export interface LoopConfigEntry {
  name: string
  path: string
  display_name: string
}

export const listLoopConfigs = () =>
  request<LoopConfigEntry[]>('/loop/configs')

// --- Closed-Loop API ---

export interface ClosedLoopCycle {
  cycle: number
  benchmark_scores: Record<string, number>
  gate_passed: boolean | null
  gate_delta: number
  consecutive_gate_failures: number
  dataset_size: number
  training_loss: number | null
  merged_model_path: string | null
  tally_metadata: Record<string, any>
  dataset_path: string | null
  adapter_path: string | null
  started_at: string | null
  completed_at: string | null
}

export interface ClosedLoopStatus {
  loop_id: string | null
  status: string
  current_cycle: number
  current_stage: string | null
  consecutive_gate_failures: number
  stop_reason: string | null
}

export const startClosedLoop = (configPath?: string) =>
  request<{ loop_id: string; status: string }>('/closed-loop/start', {
    method: 'POST',
    body: JSON.stringify({ config_path: configPath || null }),
  })

export const stopClosedLoop = () =>
  request<{ loop_id: string; status: string }>('/closed-loop/stop', {
    method: 'POST',
  })

export const getClosedLoopStatus = () =>
  request<ClosedLoopStatus>('/closed-loop/status')

export const getClosedLoopHistory = (loopId?: string) => {
  const params = loopId ? `?loop_id=${loopId}` : ''
  return request<{ loop_id: string | null; cycles: ClosedLoopCycle[] }>(`/closed-loop/history${params}`)
}

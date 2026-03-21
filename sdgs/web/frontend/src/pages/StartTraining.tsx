import { useState, useEffect, useRef } from 'react'
import { useNavigate } from 'react-router-dom'
import { ChevronDown, ChevronRight, StopCircle } from 'lucide-react'
import { getDatasets, startTraining, cancelTraining, getConfigs, getArtifacts, getBaseModels, downloadBaseModel, importFromHuggingFace, Dataset, ConfigInfo, ArtifactEntry } from '../api/client'
import { useTrainingSSE } from '../hooks/useTrainingSSE'

export default function StartTraining() {
  const navigate = useNavigate()
  const logViewerRef = useRef<HTMLDivElement>(null)

  // Config mode
  const [configMode, setConfigMode] = useState<'manual' | 'preset'>('manual')
  const [modelConfigs, setModelConfigs] = useState<ConfigInfo[]>([])
  const [datasetConfigs, setDatasetConfigs] = useState<ConfigInfo[]>([])
  const [trainingConfigs, setTrainingConfigs] = useState<ConfigInfo[]>([])
  const [selectedModelConfig, setSelectedModelConfig] = useState('')
  const [selectedDatasetConfig, setSelectedDatasetConfig] = useState('')
  const [selectedTrainingConfig, setSelectedTrainingConfig] = useState('')

  // Dataset selection
  const [datasets, setDatasets] = useState<Dataset[]>([])
  const [datasetSource, setDatasetSource] = useState<'dataset' | 'path' | 'huggingface'>('dataset')
  const [datasetId, setDatasetId] = useState<number | null>(null)
  const [datasetPath, setDatasetPath] = useState('')
  const [hfRepoId, setHfRepoId] = useState('')
  const [hfImporting, setHfImporting] = useState(false)

  // Model config
  const [modelSource, setModelSource] = useState<'local' | 'huggingface'>('huggingface')
  const [localModels, setLocalModels] = useState<ArtifactEntry[]>([])
  const [baseModel, setBaseModel] = useState('Qwen/Qwen3.5-9B')
  const [hfModelId, setHfModelId] = useState('Qwen/Qwen3.5-9B')
  const [downloadingModel, setDownloadingModel] = useState(false)
  const [downloadProgress, setDownloadProgress] = useState('')
  const [downloadPercent, setDownloadPercent] = useState(-1)
  const [modelSize, setModelSize] = useState('9B')

  // Context length
  const [maxSeqLength, setMaxSeqLength] = useState(2048)

  // LoRA config
  const [loraRank, setLoraRank] = useState(64)
  const [loraAlpha, setLoraAlpha] = useState(128)

  // Training config
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [learningRate, setLearningRate] = useState(0.00001)
  const [numEpochs, setNumEpochs] = useState(3)
  const [batchSize, setBatchSize] = useState(32)
  const [gradAccumSteps, setGradAccumSteps] = useState(4)
  const [maxSteps, setMaxSteps] = useState(-1)
  const [lossFunction, setLossFunction] = useState('cross_entropy')
  const [labelSmoothing, setLabelSmoothing] = useState(0.0)
  const [optimizer, setOptimizer] = useState('adamw_8bit')
  const [lrScheduler, setLrScheduler] = useState('cosine')
  const [weightDecay, setWeightDecay] = useState(0.1)
  const [warmupSteps, setWarmupSteps] = useState(100)
  const [maxGradNorm, setMaxGradNorm] = useState(0.3)
  const [checkpoints, setCheckpoints] = useState<ArtifactEntry[]>([])
  const [resumeCheckpoint, setResumeCheckpoint] = useState('')
  const [customCheckpoint, setCustomCheckpoint] = useState(false)

  // State
  const [submitting, setSubmitting] = useState(false)
  const [runId, setRunId] = useState<number | null>(null)
  const [error, setError] = useState('')

  const { logs, status, done } = useTrainingSSE(runId)

  useEffect(() => {
    getDatasets(1, 100).then((res) => {
      setDatasets(res.datasets.filter((d) => d.status === 'completed'))
    }).catch(() => {})
    getArtifacts().then((res) => setCheckpoints(res.checkpoints)).catch(() => {})
    getBaseModels().then((models) => {
      setLocalModels(models)
      if (models.length > 0) setModelSource('local')
    }).catch(() => {})
  }, [])

  useEffect(() => {
    if (configMode === 'preset') {
      getConfigs('models').then((r) => setModelConfigs(r.configs)).catch(() => {})
      getConfigs('datasets').then((r) => setDatasetConfigs(r.configs)).catch(() => {})
      getConfigs('training').then((r) => setTrainingConfigs(r.configs)).catch(() => {})
    }
  }, [configMode])

  useEffect(() => {
    if (logViewerRef.current) {
      logViewerRef.current.scrollTop = logViewerRef.current.scrollHeight
    }
  }, [logs])

  useEffect(() => {
    if (done && status === 'completed' && runId) {
      setTimeout(() => navigate(`/training/${runId}`), 1000)
    }
  }, [done, status, runId, navigate])

  const handleHfImport = async () => {
    if (!hfRepoId.trim()) return
    setHfImporting(true)
    try {
      const ds = await importFromHuggingFace({ repo_id: hfRepoId.trim() })
      const res = await getDatasets(1)
      setDatasets(res.datasets.filter((d) => d.status === 'completed'))
      setDatasetId(ds.id)
      setDatasetSource('dataset')
      setHfRepoId('')
    } catch (e) {
      setError(e instanceof Error ? e.message : 'HuggingFace import failed')
    } finally {
      setHfImporting(false)
    }
  }

  const handleStart = async () => {
    setError('')
    setSubmitting(true)
    try {
      const payload: Parameters<typeof startTraining>[0] = configMode === 'preset'
        ? {
            model_config_name: selectedModelConfig || undefined,
            dataset_config_name: selectedDatasetConfig || undefined,
            training_config_name: selectedTrainingConfig || undefined,
            // Still allow dataset source in preset mode when no dataset config is chosen
            dataset_id: !selectedDatasetConfig && datasetSource === 'dataset' ? datasetId : undefined,
            dataset_path: !selectedDatasetConfig && datasetSource === 'path' ? datasetPath.trim() || undefined : undefined,
            resume_from_checkpoint: resumeCheckpoint.trim() || undefined,
          }
        : {
            dataset_id: datasetSource === 'dataset' ? datasetId : undefined,
            dataset_path: datasetSource === 'path' ? datasetPath.trim() || undefined : undefined,
            base_model: modelSource === 'huggingface' && hfModelId.trim() ? hfModelId.trim() : baseModel,
            model_size: modelSize,
            max_seq_length: maxSeqLength,
            lora_rank: loraRank,
            lora_alpha: loraAlpha,
            learning_rate: learningRate,
            num_epochs: numEpochs,
            batch_size: batchSize,
            gradient_accumulation_steps: gradAccumSteps,
            max_steps: maxSteps,
            loss_function: lossFunction,
            label_smoothing: labelSmoothing,
            optimizer: optimizer,
            lr_scheduler: lrScheduler,
            weight_decay: weightDecay,
            warmup_steps: warmupSteps,
            max_grad_norm: maxGradNorm,
            resume_from_checkpoint: resumeCheckpoint.trim() || undefined,
          }
      const run = await startTraining(payload)
      setRunId(run.id)
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Failed to start training')
      setSubmitting(false)
    }
  }

  const canSubmit = !submitting && (
    configMode === 'preset'
      ? (selectedModelConfig || selectedDatasetConfig || selectedTrainingConfig)
      : (
          (datasetSource === 'dataset' && datasetId != null) ||
          (datasetSource === 'path' && datasetPath.trim()) ||
          (datasetSource === 'huggingface' && datasetId != null)
        )
  )

  return (
    <div style={{ maxWidth: '700px' }}>
      <div className="page-header">
        <h1>Model Fine-Tuning</h1>
        <p>Configure and launch a fine-tuning run</p>
      </div>

      {/* Config mode toggle */}
      <div className="card" style={{ marginBottom: '16px' }}>
        <label style={{ fontSize: '15px', fontWeight: 500, color: 'var(--text-primary)', marginBottom: '8px' }}>
          Configuration Mode
        </label>
        <div style={{ display: 'flex', gap: '8px', marginTop: '8px' }}>
          <button
            onClick={() => setConfigMode('manual')}
            disabled={submitting}
            style={{
              background: configMode === 'manual' ? 'var(--accent-blue)' : 'var(--bg-tertiary)',
              border: '1px solid ' + (configMode === 'manual' ? 'var(--accent-blue)' : 'var(--border-primary)'),
              color: configMode === 'manual' ? '#fff' : 'var(--text-secondary)',
              cursor: 'pointer',
              fontSize: '13px',
              padding: '6px 12px',
              borderRadius: 'var(--radius-sm)',
            }}
          >
            Manual Config
          </button>
          <button
            onClick={() => setConfigMode('preset')}
            disabled={submitting}
            style={{
              background: configMode === 'preset' ? 'var(--accent-blue)' : 'var(--bg-tertiary)',
              border: '1px solid ' + (configMode === 'preset' ? 'var(--accent-blue)' : 'var(--border-primary)'),
              color: configMode === 'preset' ? '#fff' : 'var(--text-secondary)',
              cursor: 'pointer',
              fontSize: '13px',
              padding: '6px 12px',
              borderRadius: 'var(--radius-sm)',
            }}
          >
            Use Presets
          </button>
        </div>
      </div>

      <div className="card" style={{ marginBottom: '20px' }}>
        {/* Preset config dropdowns */}
        {configMode === 'preset' && (
          <div style={{ marginBottom: '20px' }}>
            <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '12px' }}>
              <div>
                <label>Model Config</label>
                <select
                  value={selectedModelConfig}
                  onChange={(e) => setSelectedModelConfig(e.target.value)}
                  disabled={submitting}
                >
                  <option value="">Select model...</option>
                  {modelConfigs.map((c) => (
                    <option key={c.name} value={c.name}>{c.display_name}</option>
                  ))}
                </select>
              </div>
              <div>
                <label>Dataset Config</label>
                <select
                  value={selectedDatasetConfig}
                  onChange={(e) => setSelectedDatasetConfig(e.target.value)}
                  disabled={submitting}
                >
                  <option value="">Select dataset...</option>
                  {datasetConfigs.map((c) => (
                    <option key={c.name} value={c.name}>{c.display_name}</option>
                  ))}
                </select>
              </div>
              <div>
                <label>Training Config</label>
                <select
                  value={selectedTrainingConfig}
                  onChange={(e) => setSelectedTrainingConfig(e.target.value)}
                  disabled={submitting}
                >
                  <option value="">Select training...</option>
                  {trainingConfigs.map((c) => (
                    <option key={c.name} value={c.name}>{c.display_name}</option>
                  ))}
                </select>
              </div>
            </div>
          </div>
        )}

        {/* Dataset source — shown in manual mode, or preset mode when no dataset config */}
        {(configMode === 'manual' || !selectedDatasetConfig) && (
        <div style={{ marginBottom: '20px' }}>
          <label style={{ fontSize: '15px', fontWeight: 700, color: 'var(--text-primary)', marginBottom: '8px', display: 'block' }}>
            Qwen-Fine-Tuning
          </label>
          <div style={{ display: 'flex', gap: '8px', marginBottom: '12px' }}>
            <button
              onClick={() => setDatasetSource('dataset')}
              disabled={submitting}
              style={{
                background: datasetSource === 'dataset' ? 'var(--accent-blue)' : 'var(--bg-tertiary)',
                border: '1px solid ' + (datasetSource === 'dataset' ? 'var(--accent-blue)' : 'var(--border-primary)'),
                color: datasetSource === 'dataset' ? '#fff' : 'var(--text-secondary)',
                cursor: 'pointer',
                fontSize: '13px',
                padding: '6px 12px',
                borderRadius: 'var(--radius-sm)',
              }}
            >
              From Dataset
            </button>
            <button
              onClick={() => setDatasetSource('path')}
              disabled={submitting}
              style={{
                background: datasetSource === 'path' ? 'var(--accent-blue)' : 'var(--bg-tertiary)',
                border: '1px solid ' + (datasetSource === 'path' ? 'var(--accent-blue)' : 'var(--border-primary)'),
                color: datasetSource === 'path' ? '#fff' : 'var(--text-secondary)',
                cursor: 'pointer',
                fontSize: '13px',
                padding: '6px 12px',
                borderRadius: 'var(--radius-sm)',
              }}
            >
              Manual Path
            </button>
            <button
              onClick={() => setDatasetSource('huggingface')}
              disabled={submitting}
              style={{
                background: datasetSource === 'huggingface' ? 'var(--accent-blue)' : 'var(--bg-tertiary)',
                border: '1px solid ' + (datasetSource === 'huggingface' ? 'var(--accent-blue)' : 'var(--border-primary)'),
                color: datasetSource === 'huggingface' ? '#fff' : 'var(--text-secondary)',
                cursor: 'pointer',
                fontSize: '13px',
                padding: '6px 12px',
                borderRadius: 'var(--radius-sm)',
              }}
            >
              HuggingFace
            </button>
          </div>

          {datasetSource === 'dataset' ? (
            <select
              value={datasetId ?? ''}
              onChange={(e) => setDatasetId(e.target.value ? Number(e.target.value) : null)}
              disabled={submitting}
            >
              <option value="">Select a completed dataset...</option>
              {datasets.map((d) => (
                <option key={d.id} value={d.id}>
                  {d.name || d.topic} ({d.actual_size} samples)
                </option>
              ))}
            </select>
          ) : datasetSource === 'huggingface' ? (
            <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
              <input
                type="text"
                placeholder="username/dataset-name"
                value={hfRepoId}
                onChange={(e) => setHfRepoId(e.target.value)}
                disabled={submitting || hfImporting}
                style={{ fontSize: '14px', flex: 1 }}
                onKeyDown={(e) => e.key === 'Enter' && handleHfImport()}
              />
              <button
                className="btn btn-primary"
                onClick={handleHfImport}
                disabled={submitting || hfImporting || !hfRepoId.trim()}
                style={{ padding: '6px 16px', fontSize: '13px', whiteSpace: 'nowrap' }}
              >
                {hfImporting ? 'Importing...' : 'Import'}
              </button>
            </div>
          ) : (
            <input
              type="text"
              placeholder="/path/to/train.jsonl"
              value={datasetPath}
              onChange={(e) => setDatasetPath(e.target.value)}
              disabled={submitting}
              style={{ fontSize: '14px' }}
            />
          )}
        </div>
        )}

        {/* Model config — manual mode only */}
        {configMode === 'manual' && (<>
        {/* Model config */}
        <div style={{ marginBottom: '20px' }}>
          <label>Base Model</label>
          <div style={{ display: 'flex', gap: '8px', marginBottom: '8px' }}>
            <button
              onClick={() => setModelSource('local')}
              disabled={submitting}
              style={{
                background: modelSource === 'local' ? 'var(--accent-blue)' : 'var(--bg-tertiary)',
                border: '1px solid ' + (modelSource === 'local' ? 'var(--accent-blue)' : 'var(--border-primary)'),
                color: modelSource === 'local' ? '#fff' : 'var(--text-secondary)',
                cursor: 'pointer',
                fontSize: '13px',
                padding: '6px 12px',
                borderRadius: 'var(--radius-sm)',
              }}
            >
              Local Models
            </button>
            <button
              onClick={() => setModelSource('huggingface')}
              disabled={submitting}
              style={{
                background: modelSource === 'huggingface' ? 'var(--accent-blue)' : 'var(--bg-tertiary)',
                border: '1px solid ' + (modelSource === 'huggingface' ? 'var(--accent-blue)' : 'var(--border-primary)'),
                color: modelSource === 'huggingface' ? '#fff' : 'var(--text-secondary)',
                cursor: 'pointer',
                fontSize: '13px',
                padding: '6px 12px',
                borderRadius: 'var(--radius-sm)',
              }}
            >
              HuggingFace
            </button>
          </div>
          {modelSource === 'local' ? (
            <select
              value={baseModel}
              onChange={(e) => setBaseModel(e.target.value)}
              disabled={submitting}
            >
              <option value="">Select a local model...</option>
              {localModels.map((m) => (
                <option key={m.path} value={m.path}>{m.label}</option>
              ))}
            </select>
          ) : (
            <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
              <input
                type="text"
                placeholder="Qwen/Qwen3.5-9B"
                value={hfModelId}
                onChange={(e) => setHfModelId(e.target.value)}
                disabled={submitting || downloadingModel}
                style={{ flex: 1 }}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && hfModelId.trim()) {
                    setBaseModel(hfModelId.trim())
                  }
                }}
              />
              <button
                className="btn btn-primary"
                onClick={() => {
                  if (!hfModelId.trim()) return
                  setDownloadingModel(true)
                  setDownloadProgress('')
                  setDownloadPercent(-1)
                  setError('')
                  downloadBaseModel(hfModelId.trim(), (msg) => {
                    if (msg.type === 'log' || msg.type === 'progress') {
                      setDownloadProgress(msg.data || '')
                      if (msg.percent !== undefined) setDownloadPercent(msg.percent)
                    } else if (msg.type === 'done') {
                      setDownloadingModel(false)
                      setDownloadProgress('')
                      setDownloadPercent(-1)
                      if (msg.path) {
                        setBaseModel(msg.path)
                        setModelSource('local')
                      }
                      getBaseModels().then((models) => {
                        setLocalModels(models)
                      }).catch(() => {})
                      setHfModelId('')
                    } else if (msg.type === 'error') {
                      setDownloadingModel(false)
                      setDownloadProgress('')
                      setDownloadPercent(-1)
                      setError(msg.data || 'Download failed')
                    }
                  })
                }}
                disabled={submitting || downloadingModel || !hfModelId.trim()}
                style={{ padding: '6px 16px', fontSize: '13px', whiteSpace: 'nowrap' }}
              >
                {downloadingModel ? 'Downloading...' : 'Download'}
              </button>
            </div>
          )}
          {downloadingModel && downloadProgress && (
            <div style={{ marginTop: '8px' }}>
              <div style={{ fontSize: '12px', color: 'var(--text-secondary)', marginBottom: '4px' }}>
                {downloadProgress}
              </div>
              {downloadPercent >= 0 && (
                <div style={{
                  height: '6px',
                  background: 'var(--bg-tertiary)',
                  borderRadius: '3px',
                  overflow: 'hidden',
                }}>
                  <div style={{
                    height: '100%',
                    width: `${downloadPercent}%`,
                    background: 'var(--accent-blue)',
                    borderRadius: '3px',
                    transition: 'width 0.3s ease',
                  }} />
                </div>
              )}
            </div>
          )}
          {modelSource === 'huggingface' && !downloadingModel && (
            <div style={{ fontSize: '11px', color: 'var(--text-muted)', marginTop: '4px' }}>
              Enter a HuggingFace repo ID to use directly, or click Download to cache locally.
            </div>
          )}
        </div>

        {/* Context length + LoRA config */}
        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '16px', marginBottom: '20px' }}>
          <div>
            <label>Context Length</label>
            <select
              value={maxSeqLength}
              onChange={(e) => setMaxSeqLength(parseInt(e.target.value))}
              disabled={submitting}
            >
              <option value={512}>512</option>
              <option value={1024}>1024</option>
              <option value={2048}>2048</option>
              <option value={4096}>4096</option>
              <option value={8192}>8192</option>
              <option value={16384}>16384</option>
              <option value={32768}>32768</option>
            </select>
          </div>
          <div>
            <label>LoRA Rank</label>
            <input
              type="number"
              value={loraRank}
              onChange={(e) => setLoraRank(Math.max(1, parseInt(e.target.value) || 1))}
              min={1}
              disabled={submitting}
            />
          </div>
          <div>
            <label>LoRA Alpha</label>
            <input
              type="number"
              value={loraAlpha}
              onChange={(e) => setLoraAlpha(Math.max(1, parseInt(e.target.value) || 1))}
              min={1}
              disabled={submitting}
            />
          </div>
        </div>

        {/* Advanced training config */}
        <div style={{ marginBottom: '20px' }}>
          <button
            onClick={() => setShowAdvanced(!showAdvanced)}
            style={{
              background: 'none',
              border: 'none',
              color: 'var(--text-secondary)',
              cursor: 'pointer',
              display: 'flex',
              alignItems: 'center',
              gap: '4px',
              fontSize: '13px',
              padding: 0,
            }}
          >
            {showAdvanced ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
            Training Parameters
          </button>

          {showAdvanced && (
            <div style={{ marginTop: '12px', paddingLeft: '18px' }}>
              <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: '12px' }}>
                <div>
                  <label>Learning Rate</label>
                  <input
                    type="number"
                    value={learningRate}
                    onChange={(e) => setLearningRate(parseFloat(e.target.value) || 0.00005)}
                    step={0.00001}
                    disabled={submitting}
                  />
                </div>
                <div>
                  <label>Epochs</label>
                  <input
                    type="number"
                    value={numEpochs}
                    onChange={(e) => setNumEpochs(Math.max(1, parseInt(e.target.value) || 1))}
                    min={1}
                    disabled={submitting}
                  />
                </div>
                <div>
                  <label>Batch Size</label>
                  <input
                    type="number"
                    value={batchSize}
                    onChange={(e) => setBatchSize(Math.max(1, parseInt(e.target.value) || 1))}
                    min={1}
                    disabled={submitting}
                  />
                </div>
                <div>
                  <label>Gradient Accumulation Steps</label>
                  <input
                    type="number"
                    value={gradAccumSteps}
                    onChange={(e) => setGradAccumSteps(Math.max(1, parseInt(e.target.value) || 1))}
                    min={1}
                    disabled={submitting}
                  />
                </div>
              </div>
              <div style={{ marginTop: '12px', display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '16px' }}>
                <div>
                  <label>Max Steps (-1 for unlimited)</label>
                  <input
                    type="number"
                    value={maxSteps}
                    onChange={(e) => setMaxSteps(parseInt(e.target.value) || -1)}
                    disabled={submitting}
                  />
                </div>
                <div>
                  <label>Loss Function</label>
                  <select value={lossFunction} onChange={(e) => setLossFunction(e.target.value)} disabled={submitting}>
                    <option value="cross_entropy">CrossEntropyLoss</option>
                    <option value="nll">NLLLoss</option>
                    <option value="focal">Focal Loss</option>
                    <option value="kl_div">KLDivLoss</option>
                    <option value="bce">BCELoss</option>
                    <option value="bce_with_logits">BCEWithLogitsLoss</option>
                    <option value="mse">MSELoss</option>
                    <option value="l1">L1Loss</option>
                    <option value="smooth_l1">SmoothL1Loss</option>
                    <option value="huber">HuberLoss</option>
                    <option value="cosine_embedding">CosineEmbeddingLoss</option>
                    <option value="hinge_embedding">HingeEmbeddingLoss</option>
                    <option value="soft_margin">SoftMarginLoss</option>
                    <option value="multi_margin">MultiMarginLoss</option>
                    <option value="multi_label_margin">MultiLabelMarginLoss</option>
                    <option value="multi_label_soft_margin">MultiLabelSoftMarginLoss</option>
                    <option value="poisson_nll">PoissonNLLLoss</option>
                    <option value="gaussian_nll">GaussianNLLLoss</option>
                    <option value="ctc">CTCLoss</option>
                  </select>
                </div>
                <div>
                  <label>Label Smoothing</label>
                  <input
                    type="number"
                    step="0.01"
                    min="0"
                    max="0.5"
                    value={labelSmoothing}
                    onChange={(e) => setLabelSmoothing(parseFloat(e.target.value) || 0)}
                    disabled={submitting}
                  />
                </div>
              </div>
              <div style={{ marginTop: '12px', display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '16px' }}>
                <div>
                  <label>Optimizer</label>
                  <select value={optimizer} onChange={(e) => setOptimizer(e.target.value)} disabled={submitting}>
                    <optgroup label="AdamW">
                      <option value="adamw_torch">adamw_torch</option>
                      <option value="adamw_torch_fused">adamw_torch_fused</option>
                      <option value="adamw_8bit">adamw_8bit</option>
                      <option value="adamw_bnb_8bit">adamw_bnb_8bit</option>
                      <option value="adamw_torch_4bit">adamw_torch_4bit</option>
                      <option value="adamw_torch_8bit">adamw_torch_8bit</option>
                      <option value="paged_adamw_8bit">paged_adamw_8bit</option>
                      <option value="paged_adamw_32bit">paged_adamw_32bit</option>
                      <option value="stable_adamw">stable_adamw</option>
                    </optgroup>
                    <optgroup label="SGD / Classical">
                      <option value="sgd">SGD</option>
                      <option value="adagrad">Adagrad</option>
                      <option value="rmsprop">RMSProp</option>
                      <option value="rmsprop_bnb">rmsprop_bnb</option>
                      <option value="rmsprop_bnb_8bit">rmsprop_bnb_8bit</option>
                      <option value="rmsprop_bnb_32bit">rmsprop_bnb_32bit</option>
                      <option value="adafactor">Adafactor</option>
                    </optgroup>
                    <optgroup label="Lion">
                      <option value="lion_8bit">lion_8bit</option>
                      <option value="lion_32bit">lion_32bit</option>
                      <option value="paged_lion_8bit">paged_lion_8bit</option>
                      <option value="paged_lion_32bit">paged_lion_32bit</option>
                    </optgroup>
                    <optgroup label="AdEMAMix">
                      <option value="ademamix">ademamix</option>
                      <option value="ademamix_8bit">ademamix_8bit</option>
                      <option value="paged_ademamix_8bit">paged_ademamix_8bit</option>
                      <option value="paged_ademamix_32bit">paged_ademamix_32bit</option>
                    </optgroup>
                    <optgroup label="GaLore">
                      <option value="galore_adamw">galore_adamw</option>
                      <option value="galore_adamw_8bit">galore_adamw_8bit</option>
                      <option value="galore_adafactor">galore_adafactor</option>
                      <option value="galore_adamw_layerwise">galore_adamw_layerwise</option>
                      <option value="galore_adamw_8bit_layerwise">galore_adamw_8bit_layerwise</option>
                      <option value="galore_adafactor_layerwise">galore_adafactor_layerwise</option>
                    </optgroup>
                    <optgroup label="Schedule-Free">
                      <option value="schedule_free_adamw">schedule_free_adamw</option>
                      <option value="schedule_free_sgd">schedule_free_sgd</option>
                      <option value="schedule_free_radam">schedule_free_radam</option>
                    </optgroup>
                    <optgroup label="Other">
                      <option value="lomo">LOMO</option>
                      <option value="adalomo">AdaLOMO</option>
                      <option value="grokadamw">GrokAdamW</option>
                      <option value="apollo_adamw">apollo_adamw</option>
                      <option value="apollo_adamw_layerwise">apollo_adamw_layerwise</option>
                    </optgroup>
                  </select>
                </div>
                <div>
                  <label>LR Scheduler</label>
                  <select value={lrScheduler} onChange={(e) => setLrScheduler(e.target.value)} disabled={submitting}>
                    <option value="cosine">Cosine</option>
                    <option value="linear">Linear</option>
                    <option value="constant">Constant</option>
                    <option value="constant_with_warmup">Constant + Warmup</option>
                    <option value="cosine_with_restarts">Cosine + Restarts</option>
                    <option value="polynomial">Polynomial</option>
                    <option value="inverse_sqrt">Inverse Sqrt</option>
                    <option value="reduce_lr_on_plateau">Reduce on Plateau</option>
                  </select>
                </div>
                <div>
                  <label>Weight Decay</label>
                  <input type="number" step="0.01" min="0" max="1" value={weightDecay} onChange={(e) => setWeightDecay(parseFloat(e.target.value) || 0)} disabled={submitting} />
                </div>
              </div>
              <div style={{ marginTop: '12px', display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: '16px' }}>
                <div>
                  <label>Warmup Steps</label>
                  <input type="number" min="0" value={warmupSteps} onChange={(e) => setWarmupSteps(parseInt(e.target.value) || 0)} disabled={submitting} />
                </div>
                <div>
                  <label>Max Grad Norm</label>
                  <input type="number" step="0.1" min="0" value={maxGradNorm} onChange={(e) => setMaxGradNorm(parseFloat(e.target.value) || 0)} disabled={submitting} />
                </div>
              </div>
              <div style={{ marginTop: '12px' }}>
                <label>Resume from Checkpoint</label>
                {!customCheckpoint ? (
                  <select
                    value={resumeCheckpoint}
                    onChange={(e) => {
                      if (e.target.value === '__custom__') {
                        setCustomCheckpoint(true)
                        setResumeCheckpoint('')
                      } else {
                        setResumeCheckpoint(e.target.value)
                      }
                    }}
                    disabled={submitting}
                    style={{ fontSize: '13px' }}
                  >
                    <option value="">None</option>
                    {checkpoints.map((c) => (
                      <option key={c.path} value={c.path}>{c.label}</option>
                    ))}
                    <option value="__custom__">Custom path...</option>
                  </select>
                ) : (
                  <>
                    <input
                      type="text"
                      placeholder="/path/to/checkpoint-XXX"
                      value={resumeCheckpoint}
                      onChange={(e) => setResumeCheckpoint(e.target.value)}
                      disabled={submitting}
                      style={{ fontSize: '13px' }}
                    />
                    <button
                      onClick={() => { setCustomCheckpoint(false); setResumeCheckpoint('') }}
                      style={{
                        background: 'none', border: 'none', color: 'var(--accent-blue)',
                        cursor: 'pointer', fontSize: '12px', padding: '4px 0', marginTop: '4px',
                      }}
                    >
                      Back to dropdown
                    </button>
                  </>
                )}
              </div>
            </div>
          )}
        </div>
        </>)}

        {/* Resume from checkpoint — shown in preset mode too */}
        {configMode === 'preset' && (
          <div style={{ marginBottom: '20px' }}>
            <label>Resume from Checkpoint</label>
            {!customCheckpoint ? (
              <select
                value={resumeCheckpoint}
                onChange={(e) => {
                  if (e.target.value === '__custom__') {
                    setCustomCheckpoint(true)
                    setResumeCheckpoint('')
                  } else {
                    setResumeCheckpoint(e.target.value)
                  }
                }}
                disabled={submitting}
                style={{ fontSize: '13px' }}
              >
                <option value="">None</option>
                {checkpoints.map((c) => (
                  <option key={c.path} value={c.path}>{c.label}</option>
                ))}
                <option value="__custom__">Custom path...</option>
              </select>
            ) : (
              <>
                <input
                  type="text"
                  placeholder="/path/to/checkpoint-XXX"
                  value={resumeCheckpoint}
                  onChange={(e) => setResumeCheckpoint(e.target.value)}
                  disabled={submitting}
                  style={{ fontSize: '13px' }}
                />
                <button
                  onClick={() => { setCustomCheckpoint(false); setResumeCheckpoint('') }}
                  style={{
                    background: 'none', border: 'none', color: 'var(--accent-blue)',
                    cursor: 'pointer', fontSize: '12px', padding: '4px 0', marginTop: '4px',
                  }}
                >
                  Back to dropdown
                </button>
              </>
            )}
          </div>
        )}

        {/* Error */}
        {error && (
          <div style={{
            background: 'rgba(239, 68, 68, 0.1)',
            border: '1px solid rgba(239, 68, 68, 0.3)',
            borderRadius: 'var(--radius-sm)',
            padding: '8px 12px',
            color: 'var(--accent-pink)',
            fontSize: '13px',
            marginBottom: '16px',
          }}>
            {error}
          </div>
        )}

        {/* Submit */}
        <button
          className="btn btn-primary"
          onClick={handleStart}
          disabled={!canSubmit}
          style={{ width: '100%', justifyContent: 'center', padding: '10px 20px', fontSize: '15px' }}
        >
          {submitting ? <span className="spinner" /> : 'Start Training'}
        </button>
      </div>

      {/* Progress log */}
      {runId && (
        <div className="card">
          <div style={{
            display: 'flex',
            justifyContent: 'space-between',
            alignItems: 'center',
            marginBottom: '12px',
          }}>
            <h3 style={{ fontSize: '14px', fontWeight: 500 }}>Progress</h3>
            <div style={{ display: 'flex', alignItems: 'center', gap: '8px' }}>
              {status && (
                <span className={`badge badge-${status}`}>
                  {status}
                </span>
              )}
              {submitting && !done && (
                <button
                  className="btn btn-danger"
                  style={{ padding: '4px 10px', fontSize: '12px' }}
                  onClick={async () => {
                    try {
                      await cancelTraining(runId)
                      setSubmitting(false)
                    } catch { /* ignore */ }
                  }}
                >
                  <StopCircle size={14} />
                  Cancel
                </button>
              )}
            </div>
          </div>
          <div className="log-viewer" ref={logViewerRef} style={{ maxHeight: '300px' }}>
            {logs.map((line, i) => (
              <div key={i} className="log-line">{line}</div>
            ))}
            {logs.length === 0 && (
              <div style={{ color: 'var(--text-muted)' }}>Waiting for training to start...</div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

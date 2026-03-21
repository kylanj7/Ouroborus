import { useEffect, useRef, useState } from 'react'
import { Play, Square, XCircle, ChevronDown, ChevronUp, Settings, Upload } from 'lucide-react'
import InfoTip from '../components/common/InfoTip'
import { uploadTrainingYaml } from '../api/client'
import { useLoopStore } from '../store/loopStore'
import { useLoopSSE } from '../hooks/useLoopSSE'
import StagePipeline from '../components/loop/StagePipeline'
import BenchmarkChart from '../components/loop/BenchmarkChart'
import TallyDiagnosis from '../components/loop/TallyDiagnosis'
import GateBanner from '../components/loop/GateBanner'
import CycleHistory from '../components/loop/CycleHistory'

export default function Loop() {
  const store = useLoopStore()
  const { logs, done, clear } = useLoopSSE()
  const showLogs = true  // always visible in side panel
  const [showYaml, setShowYaml] = useState(false)
  const logEndRef = useRef<HTMLDivElement>(null)

  // Config form state
  const [configPath, setConfigPath] = useState('configs/closed_loop.yaml')
  const [baseModel, setBaseModel] = useState('Qwen/Qwen3.5-9B')
  const [learningRate, setLearningRate] = useState('1e-5')
  const [numEpochs, setNumEpochs] = useState(3)
  const [batchSize, setBatchSize] = useState(32)
  const [gradAccumSteps, setGradAccumSteps] = useState(4)
  const [maxSeqLength, setMaxSeqLength] = useState(8192)
  const [loraRank, setLoraRank] = useState(64)
  const [loraAlpha, setLoraAlpha] = useState(128)
  const [targetScore, setTargetScore] = useState(85)
  const [maxCycles, setMaxCycles] = useState(50)
  const [gateThreshold, setGateThreshold] = useState(0.5)
  const [minPairs, setMinPairs] = useState(3500)
  const [lossFunction, setLossFunction] = useState('focal')
  const [labelSmoothing, setLabelSmoothing] = useState(0.0)
  const [optimizer, setOptimizer] = useState('adamw_8bit')
  const [lrScheduler, setLrScheduler] = useState('cosine')
  const [weightDecay, setWeightDecay] = useState(0.01)
  const [maxGradNorm, setMaxGradNorm] = useState(0.3)
  const [tallyModel, setTallyModel] = useState('gpt-oss:120b')
  const [loraDropout, setLoraDropout] = useState(0.1)
  const [useRslora, setUseRslora] = useState(false)
  const [targetModules, setTargetModules] = useState<string[]>([
    'q_proj', 'k_proj', 'v_proj', 'o_proj', 'gate_proj', 'up_proj', 'down_proj',
  ])
  const [neftuneNoiseAlpha, setNeftuneNoiseAlpha] = useState<number | null>(null)
  const [warmupRatio, setWarmupRatio] = useState(0.03)
  const [loggingSteps, setLoggingSteps] = useState(1)
  const [evalSteps, setEvalSteps] = useState(25)
  const [maxSteps, setMaxSteps] = useState(-1)
  const [quantType, setQuantType] = useState('nf4')
  const [earlyStoppingPatience, setEarlyStoppingPatience] = useState(3)
  useEffect(() => {
    store.fetchStatus()
    store.fetchHistory()
    // Poll status every 5s so UI stays in sync with backend
    const interval = setInterval(() => {
      store.fetchStatus()
    }, 5000)
    return () => clearInterval(interval)
  }, [])

  // When SSE signals done, refresh REST data
  useEffect(() => {
    if (done) {
      store.fetchStatus()
      store.fetchHistory()
    }
  }, [done])

  // Auto-scroll logs to bottom when new lines arrive
  useEffect(() => {
    if (showLogs) {
      logEndRef.current?.scrollIntoView({ behavior: 'instant' })
    }
  }, [logs.length, showLogs])

  const isRunning = store.status === 'running'
  const canStart = !isRunning && !store.loading

  const generateYaml = () => {
    // Format learning rate as scientific notation if small
    const lrNum = parseFloat(learningRate)
    const lrStr = lrNum < 0.001 ? lrNum.toExponential(1) : String(lrNum)

    return `---
# Ouroboros Evolution Loop - Training Configuration

# Model
training:
  base_model: "${baseModel}"
  max_seq_length: ${maxSeqLength}
  lora_rank: ${loraRank}
  lora_alpha: ${loraAlpha}
  lora_dropout: ${loraDropout}
  use_rslora: ${useRslora}
  target_modules: [${targetModules.map(m => `"${m}"`).join(', ')}]

# Training Hyperparameters
  per_device_train_batch_size: ${batchSize}
  gradient_accumulation_steps: ${gradAccumSteps}
  num_train_epochs: ${numEpochs}${maxSteps > 0 ? `\n  max_steps: ${maxSteps}` : ''}
  learning_rate: ${lrStr}
  optim: "${optimizer}"
  lr_scheduler_type: "${lrScheduler}"
  weight_decay: ${weightDecay}
  warmup_ratio: ${warmupRatio}
  max_grad_norm: ${maxGradNorm}${neftuneNoiseAlpha != null ? `\n  neftune_noise_alpha: ${neftuneNoiseAlpha}` : ''}

# Loss Function
  loss_function: "${lossFunction}"
  label_smoothing_factor: ${labelSmoothing}

# Precision
  auto_precision: true
  quant_type: "${quantType}"

# Logging & WandB
  logging_steps: ${loggingSteps}
  eval_steps: ${evalSteps}
  wandb_enabled: true
  wandb_project_template: "{dataset_name}-{model_name}"

# Evolution Loop
termination:
  target_score: ${targetScore}
  max_cycles: ${maxCycles}

gate:
  improvement_threshold: ${gateThreshold}
  fail_cap: ${earlyStoppingPatience}

curation:
  min_pairs_per_cycle: ${minPairs}

tally:
  model: "${tallyModel}"
`
  }

  const baseVersion = store.cycles.filter(c => (c as any).gate_passed === true).length

  return (
    <div style={{ padding: '32px', maxWidth: 1200 }}>
      {/* Pulse animation for status badge */}
      <style>{`
        @keyframes statusPulse {
          0% { opacity: 1; }
          50% { opacity: 0.5; }
          100% { opacity: 1; }
        }
      `}</style>

      {/* GateBanner -- floating overlay */}
      <GateBanner data={store.gateBanner} onDismiss={store.dismissGateBanner} />

      {/* Header + Controls Bar */}
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24, flexWrap: 'wrap', gap: 12 }}>
        <div>
          <h1 style={{ fontSize: 24, fontWeight: 700, color: 'var(--text-primary)', margin: 0 }}>
            Evolution Loop
          </h1>
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 6, flexWrap: 'wrap' }}>
            {/* Status badge */}
            <span style={{
              display: 'inline-flex',
              alignItems: 'center',
              gap: 6,
              padding: '3px 10px',
              borderRadius: 20,
              fontSize: 12,
              fontWeight: 600,
              background: isRunning ? 'rgba(59, 130, 246, 0.15)' : 'rgba(100, 116, 139, 0.15)',
              color: isRunning ? 'var(--accent-blue)' : 'var(--text-muted)',
              border: `1px solid ${isRunning ? 'var(--accent-blue)' : 'var(--border-subtle)'}`,
              animation: isRunning ? 'statusPulse 2s ease-in-out infinite' : undefined,
            }}>
              {store.status ?? 'idle'}
            </span>

            {/* Stop reason badges */}
            {store.stopReason === 'fail_cap' && (
              <span style={{
                padding: '3px 10px', borderRadius: 20, fontSize: 12, fontWeight: 600,
                background: 'rgba(234, 179, 8, 0.15)', color: 'var(--accent-yellow)',
                border: '1px solid var(--accent-yellow)',
              }}>
                Fail Cap
              </span>
            )}
            {store.stopReason === 'target_reached' && (
              <span style={{
                padding: '3px 10px', borderRadius: 20, fontSize: 12, fontWeight: 600,
                background: 'rgba(34, 197, 94, 0.15)', color: 'var(--accent-green)',
                border: '1px solid var(--accent-green)',
              }}>
                Target Reached
              </span>
            )}

            {/* Base model version */}
            <span style={{ fontSize: 12, color: 'var(--text-muted)' }}>
              Base v{baseVersion}
            </span>

            {/* Fail counter -- only shown when > 0 */}
            {store.consecutiveGateFailures > 0 && (
              <span style={{
                fontSize: 12, color: 'var(--status-failed)',
                padding: '3px 10px', borderRadius: 20,
                background: 'rgba(239, 68, 68, 0.1)',
                border: '1px solid var(--status-failed)',
              }}>
                Gate failures: {store.consecutiveGateFailures}/3
              </span>
            )}
          </div>
        </div>

        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <button
            onClick={() => { store.start(configPath); clear() }}
            disabled={!canStart}
            style={btnStyle('start', !canStart)}
          >
            <Play size={16} /> Start
          </button>

          {isRunning && (
            <button
              onClick={store.stop}
              disabled={store.loading}
              style={btnStyle('stop', store.loading)}
            >
              <Square size={16} /> Stop
            </button>
          )}

          <button
            onClick={store.cancel}
            disabled={store.loading}
            style={btnStyle('cancel', store.loading)}
            title="Force-cancel any stale or stuck loop run"
          >
            <XCircle size={16} /> Cancel
          </button>
        </div>
      </div>

      {/* Config Panel */}
      <div className="card" style={{ marginBottom: 16 }}>
        <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 16 }}>
          <div style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: 'var(--text-secondary)', fontSize: 13, fontWeight: 600 }}>
            <Settings size={16} />
            Training Configuration
          </div>
          <label style={{
            display: 'inline-flex', alignItems: 'center', gap: 6,
            fontSize: 12, color: 'var(--accent-purple)', cursor: 'pointer',
            padding: '4px 12px', borderRadius: 8,
            background: 'rgba(139, 92, 246, 0.1)',
            border: '1px solid rgba(139, 92, 246, 0.2)',
            margin: 0, textTransform: 'none', letterSpacing: 'normal', fontWeight: 500,
          }}>
            <Upload size={13} />
            Load YAML
            <input
              type="file"
              accept=".yaml,.yml"
              style={{ display: 'none' }}
              onChange={async (e) => {
                const file = e.target.files?.[0]
                if (!file) return
                try {
                  const result = await uploadTrainingYaml(file)
                  const raw = result.data
                  // Support both flat YAML and nested under "training:" key
                  const cfg = raw.training && typeof raw.training === 'object' ? raw.training : raw
                  if (cfg.base_model) setBaseModel(cfg.base_model)
                  if (cfg.max_seq_length != null) setMaxSeqLength(cfg.max_seq_length)
                  if (cfg.lora_rank != null) setLoraRank(cfg.lora_rank)
                  if (cfg.lora_alpha != null) setLoraAlpha(cfg.lora_alpha)
                  if (cfg.learning_rate != null) setLearningRate(String(cfg.learning_rate))
                  if (cfg.num_train_epochs != null) setNumEpochs(cfg.num_train_epochs)
                  if (cfg.per_device_train_batch_size != null) setBatchSize(cfg.per_device_train_batch_size)
                  if (cfg.gradient_accumulation_steps != null) setGradAccumSteps(cfg.gradient_accumulation_steps)
                  if (cfg.optim) setOptimizer(cfg.optim)
                  if (cfg.lr_scheduler_type) setLrScheduler(cfg.lr_scheduler_type)
                  if (cfg.weight_decay != null) setWeightDecay(cfg.weight_decay)
                  if (cfg.max_grad_norm != null) setMaxGradNorm(cfg.max_grad_norm)
                  if (cfg.lora_dropout != null) setLoraDropout(cfg.lora_dropout)
                  if (cfg.use_rslora != null) setUseRslora(cfg.use_rslora)
                  if (Array.isArray(cfg.target_modules)) setTargetModules(cfg.target_modules)
                  if (cfg.neftune_noise_alpha != null) setNeftuneNoiseAlpha(cfg.neftune_noise_alpha)
                  if (cfg.warmup_ratio != null) setWarmupRatio(cfg.warmup_ratio)
                  if (cfg.logging_steps != null) setLoggingSteps(cfg.logging_steps)
                  if (cfg.eval_steps != null) setEvalSteps(cfg.eval_steps)
                  if (cfg.max_steps != null) setMaxSteps(cfg.max_steps)
                  if (cfg.quant_type) setQuantType(cfg.quant_type)
                  if (cfg.loss_function) setLossFunction(cfg.loss_function)
                  if (cfg.label_smoothing_factor != null) setLabelSmoothing(cfg.label_smoothing_factor)
                  // Loop-level keys from top-level YAML
                  if (raw.termination?.target_score != null) setTargetScore(raw.termination.target_score)
                  if (raw.termination?.max_cycles != null) setMaxCycles(raw.termination.max_cycles)
                  if (raw.gate?.improvement_threshold != null) setGateThreshold(raw.gate.improvement_threshold)
                  if (raw.gate?.fail_cap != null) setEarlyStoppingPatience(raw.gate.fail_cap)
                  if (raw.curation?.min_pairs_per_cycle != null) setMinPairs(raw.curation.min_pairs_per_cycle)
                  if (raw.tally?.model) setTallyModel(raw.tally.model)
                } catch (err: any) {
                  // show error via store
                }
                e.target.value = ''
              }}
            />
          </label>
        </div>

        <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr 1fr', gap: 16 }}>
              {/* Config Preset */}
              <div style={{ gridColumn: '1 / -1' }}>
                <label>Run Type<InfoTip text="Production uses full benchmarks, retrieval, and verification. Test uses smaller limits for quick iteration." /></label>
                <select value={configPath} onChange={e => setConfigPath(e.target.value)}>
                  <option value="configs/closed_loop.yaml">Production</option>
                  <option value="configs/closed_loop_test.yaml">Test</option>
                </select>
              </div>

              {/* Model */}
              <div>
                <label>Base Model<InfoTip text="HuggingFace model ID or local path. The model that gets fine-tuned each cycle." /></label>
                <input value={baseModel} onChange={e => setBaseModel(e.target.value)} />
              </div>
              <div>
                <label>Context Length<InfoTip text="Max token sequence length per training sample. Longer = more context but more VRAM." /></label>
                <select value={maxSeqLength} onChange={e => setMaxSeqLength(Number(e.target.value))}>
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
                <label>LoRA Rank<InfoTip text="Rank of the low-rank adaptation matrices. Higher = more trainable params and expressiveness." /></label>
                <input type="number" value={loraRank} onChange={e => setLoraRank(Number(e.target.value))} />
              </div>
              <div>
                <label>LoRA Alpha<InfoTip text="Scaling factor for LoRA updates. Typically set to 2x the rank. Controls update magnitude." /></label>
                <input type="number" value={loraAlpha} onChange={e => setLoraAlpha(Number(e.target.value))} />
              </div>
              <div>
                <label>LoRA Dropout<InfoTip text="Dropout rate on LoRA layers. Prevents overfitting on small datasets. Typical range: 0.05-0.1." /></label>
                <input type="number" step="0.01" min="0" max="0.5" value={loraDropout} onChange={e => setLoraDropout(Number(e.target.value))} />
              </div>
              <div>
                <label>RS-LoRA<InfoTip text="Rank-Stabilized LoRA. Uses a different scaling factor (alpha/sqrt(r)) so training stays stable when you change rank without re-tuning the learning rate." /></label>
                <div
                  onClick={() => setUseRslora(!useRslora)}
                  style={{
                    cursor: 'pointer',
                    display: 'flex',
                    alignItems: 'center',
                    gap: 8,
                    userSelect: 'none',
                  }}
                >
                  <div style={{
                    width: 36, height: 20, borderRadius: 10,
                    background: useRslora ? 'var(--accent-green)' : 'rgba(100,116,139,0.3)',
                    position: 'relative', transition: 'background 0.2s',
                  }}>
                    <div style={{
                      width: 16, height: 16, borderRadius: 8,
                      background: '#fff', position: 'absolute', top: 2,
                      left: useRslora ? 18 : 2, transition: 'left 0.2s',
                    }} />
                  </div>
                  <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>{useRslora ? 'Enabled' : 'Disabled'}</span>
                </div>
              </div>

              {/* Target Modules */}
              <div style={{ gridColumn: '1 / -1' }}>
                <label>Target Modules<InfoTip text="Which layers to apply LoRA to. Attention layers (q/k/v/o_proj) are standard. Adding MLP layers (gate/up/down_proj) often improves reasoning." /></label>
                <div style={{
                  display: 'flex',
                  flexWrap: 'wrap',
                  gap: 6,
                  padding: '8px 12px',
                }}>
                  {[
                    { key: 'q_proj', group: 'Attn' },
                    { key: 'k_proj', group: 'Attn' },
                    { key: 'v_proj', group: 'Attn' },
                    { key: 'o_proj', group: 'Attn' },
                    { key: 'gate_proj', group: 'MLP' },
                    { key: 'up_proj', group: 'MLP' },
                    { key: 'down_proj', group: 'MLP' },
                  ].map(({ key, group }) => {
                    const active = targetModules.includes(key)
                    return (
                      <button
                        key={key}
                        type="button"
                        onClick={() => setTargetModules(prev =>
                          active ? prev.filter(m => m !== key) : [...prev, key]
                        )}
                        style={{
                          padding: '4px 10px',
                          borderRadius: 6,
                          fontSize: 11,
                          fontWeight: 500,
                          fontFamily: "'JetBrains Mono', monospace",
                          cursor: 'pointer',
                          border: `1px solid ${active ? (group === 'MLP' ? 'var(--accent-purple)' : 'var(--accent-blue)') : 'var(--border-subtle)'}`,
                          background: active
                            ? (group === 'MLP' ? 'rgba(139, 92, 246, 0.15)' : 'rgba(59, 130, 246, 0.15)')
                            : 'transparent',
                          color: active
                            ? (group === 'MLP' ? 'var(--accent-purple)' : 'var(--accent-blue)')
                            : 'var(--text-muted)',
                        }}
                      >
                        {key}
                      </button>
                    )
                  })}
                </div>
              </div>

              {/* Quantization */}
              <div>
                <label>Quantization<InfoTip text="Model weight precision. NF4 is optimal for 3090s (24GB). INT8 uses more VRAM but higher fidelity. None loads full precision." /></label>
                <select value={quantType} onChange={e => setQuantType(e.target.value)}>
                  <option value="nf4">NF4 (4-bit NormalFloat)</option>
                  <option value="fp4">FP4 (4-bit Float)</option>
                  <option value="int8">INT8 (8-bit)</option>
                  <option value="none">None (Full Precision)</option>
                </select>
              </div>

              {/* Training */}
              <div>
                <label>Learning Rate<InfoTip text="Step size for weight updates. Too high = instability, too low = slow convergence." /></label>
                <input value={learningRate} onChange={e => setLearningRate(e.target.value)} />
              </div>
              <div>
                <label>Epochs<InfoTip text="Number of full passes over the training dataset per cycle." /></label>
                <input type="number" value={numEpochs} onChange={e => setNumEpochs(Number(e.target.value))} />
              </div>
              <div>
                <label>Max Steps<InfoTip text="Hard cap on training steps. Overrides epoch count when set. -1 means no limit (use epochs instead)." /></label>
                <input type="number" value={maxSteps} onChange={e => setMaxSteps(Number(e.target.value))} />
              </div>
              <div>
                <label>Batch Size<InfoTip text="Samples processed per GPU per step. Larger = smoother gradients but more VRAM." /></label>
                <input type="number" value={batchSize} onChange={e => setBatchSize(Number(e.target.value))} />
              </div>
              <div>
                <label>Grad Accumulation<InfoTip text="Accumulate gradients over N steps before updating. Effective batch = batch_size x this value. The VRAM cheat code." /></label>
                <input type="number" value={gradAccumSteps} onChange={e => setGradAccumSteps(Number(e.target.value))} />
              </div>

              {/* Loop */}
              <div>
                <label>Target Score (%)<InfoTip text="Benchmark score goal. The loop stops when the model reaches this accuracy." /></label>
                <input type="number" value={targetScore} onChange={e => setTargetScore(Number(e.target.value))} />
              </div>
              <div>
                <label>Max Cycles<InfoTip text="Upper limit on evolution cycles. The loop stops after this many iterations regardless of score." /></label>
                <input type="number" value={maxCycles} onChange={e => setMaxCycles(Number(e.target.value))} />
              </div>
              <div>
                <label>Gate Threshold (pp)<InfoTip text="Minimum improvement in percentage points required to pass the quality gate and keep training." /></label>
                <input type="number" step="0.1" value={gateThreshold} onChange={e => setGateThreshold(Number(e.target.value))} />
              </div>
              <div>
                <label>Early Stop Patience<InfoTip text="Stop the loop after this many consecutive gate failures (no improvement). Prevents wasting compute on a plateaued model." /></label>
                <input type="number" min="1" max="20" value={earlyStoppingPatience} onChange={e => setEarlyStoppingPatience(Number(e.target.value))} />
              </div>
              <div>
                <label>Min Pairs / Cycle<InfoTip text="Minimum Q&A pairs to generate per cycle. More pairs = better coverage but longer curation." /></label>
                <input type="number" value={minPairs} onChange={e => setMinPairs(Number(e.target.value))} />
              </div>
              <div>
                <label>Tally Model<InfoTip text="LLM used by the tally agent to diagnose benchmark failures and identify weak knowledge areas." /></label>
                <input value={tallyModel} onChange={e => setTallyModel(e.target.value)} />
              </div>
              <div>
                <label>Loss Function<InfoTip text="Objective function for training. Focal loss down-weights easy samples to focus on hard examples." /></label>
                <select value={lossFunction} onChange={e => setLossFunction(e.target.value)}>
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
                <label>Label Smoothing<InfoTip text="Softens target distribution by mixing in uniform probability. Reduces overconfidence." /></label>
                <input type="number" step="0.01" min="0" max="0.5" value={labelSmoothing} onChange={e => setLabelSmoothing(Number(e.target.value))} />
              </div>
              <div>
                <label>Optimizer<InfoTip text="Algorithm for updating weights. adamw_8bit saves VRAM via quantized optimizer states." /></label>
                <select value={optimizer} onChange={e => setOptimizer(e.target.value)}>
                  <optgroup label="AdamW">
                    <option value="adamw_torch">adamw_torch</option>
                    <option value="adamw_torch_fused">adamw_torch_fused</option>
                    <option value="adamw_8bit">adamw_8bit</option>
                    <option value="adamw_bnb_8bit">adamw_bnb_8bit</option>
                    <option value="adamw_torch_4bit">adamw_torch_4bit</option>
                    <option value="paged_adamw_8bit">paged_adamw_8bit</option>
                    <option value="paged_adamw_32bit">paged_adamw_32bit</option>
                    <option value="stable_adamw">stable_adamw</option>
                  </optgroup>
                  <optgroup label="SGD / Classical">
                    <option value="sgd">SGD</option>
                    <option value="adagrad">Adagrad</option>
                    <option value="rmsprop">RMSProp</option>
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
                  </optgroup>
                  <optgroup label="GaLore">
                    <option value="galore_adamw">galore_adamw</option>
                    <option value="galore_adamw_8bit">galore_adamw_8bit</option>
                    <option value="galore_adafactor">galore_adafactor</option>
                  </optgroup>
                  <optgroup label="Schedule-Free">
                    <option value="schedule_free_adamw">schedule_free_adamw</option>
                    <option value="schedule_free_sgd">schedule_free_sgd</option>
                  </optgroup>
                  <optgroup label="Other">
                    <option value="lomo">LOMO</option>
                    <option value="adalomo">AdaLOMO</option>
                    <option value="grokadamw">GrokAdamW</option>
                  </optgroup>
                </select>
              </div>
              <div>
                <label>LR Scheduler<InfoTip text="Controls how learning rate changes over training. Cosine decays smoothly to zero." /></label>
                <select value={lrScheduler} onChange={e => setLrScheduler(e.target.value)}>
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
                <label>Weight Decay<InfoTip text="L2 regularization penalty. Prevents large weights and reduces overfitting." /></label>
                <input type="number" step="0.01" min="0" max="1" value={weightDecay} onChange={e => setWeightDecay(Number(e.target.value))} />
              </div>

              {/* Stability & Monitoring */}
              <div>
                <label>Warmup Ratio<InfoTip text="Fraction of total steps for learning rate warmup. Prevents early training instability. 3-10% is standard." /></label>
                <input type="number" step="0.01" min="0" max="0.5" value={warmupRatio} onChange={e => setWarmupRatio(Number(e.target.value))} />
              </div>
              <div>
                <label>Grad Clipping<InfoTip text="Max gradient norm (max_grad_norm). Clips large gradients to prevent NaN loss and training instability." /></label>
                <input type="number" step="0.1" min="0" max="5" value={maxGradNorm} onChange={e => setMaxGradNorm(Number(e.target.value))} />
              </div>
              <div>
                <label>NEFTune Alpha<InfoTip text="Noise magnitude added to embeddings during training. Improves generalization and instruction-following. Set 0 to disable, 5-15 is typical." /></label>
                <input type="number" step="1" min="0" value={neftuneNoiseAlpha ?? 0} onChange={e => {
                  const v = Number(e.target.value)
                  setNeftuneNoiseAlpha(v > 0 ? v : null)
                }} />
              </div>
              <div>
                <label>Logging Steps<InfoTip text="Log metrics every N steps. Set to 1 for real-time loss monitoring, higher for less noise in logs." /></label>
                <input type="number" min="1" value={loggingSteps} onChange={e => setLoggingSteps(Number(e.target.value))} />
              </div>
              <div>
                <label>Eval Steps<InfoTip text="Run evaluation every N steps. Provides validation loss to detect overfitting during training." /></label>
                <input type="number" min="1" value={evalSteps} onChange={e => setEvalSteps(Number(e.target.value))} />
              </div>

            </div>

        {/* Generate YAML */}
        <div style={{ marginTop: 16, borderTop: '1px solid rgba(255,255,255,0.06)', paddingTop: 12 }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <button
              onClick={() => setShowYaml(!showYaml)}
              style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'var(--text-secondary)', fontSize: 13, fontWeight: 600, padding: 0, display: 'flex', alignItems: 'center', gap: 6 }}
            >
              {showYaml ? <ChevronUp size={14} /> : <ChevronDown size={14} />}
              Generate YAML
            </button>
            {showYaml && (<>
              <button
                onClick={() => {
                  const yaml = generateYaml()
                  navigator.clipboard.writeText(yaml)
                }}
                style={{
                  fontSize: 12, padding: '4px 12px', borderRadius: 8,
                  background: 'rgba(74, 222, 128, 0.1)', border: '1px solid rgba(74, 222, 128, 0.2)',
                  color: 'var(--accent-green)', cursor: 'pointer', fontWeight: 500,
                }}
              >
                Copy to Clipboard
              </button>
              <button
                onClick={() => {
                  const yaml = generateYaml()
                  const blob = new Blob([yaml], { type: 'text/yaml' })
                  const url = URL.createObjectURL(blob)
                  const a = document.createElement('a')
                  a.href = url
                  a.download = 'training_config.yaml'
                  a.click()
                  URL.revokeObjectURL(url)
                }}
                style={{
                  fontSize: 12, padding: '4px 12px', borderRadius: 8,
                  background: 'rgba(139, 92, 246, 0.1)', border: '1px solid rgba(139, 92, 246, 0.2)',
                  color: 'var(--accent-purple)', cursor: 'pointer', fontWeight: 500,
                }}
              >
                Download YAML
              </button>
            </>)}
          </div>
          {showYaml && (
            <pre style={{
              marginTop: 8, padding: 16, borderRadius: 10,
              background: 'rgba(2, 6, 18, 0.8)', border: '1px solid var(--border-card)',
              fontSize: 12, lineHeight: 1.7, color: 'var(--text-secondary)',
              overflow: 'auto', maxHeight: 400,
              fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
            }}>
              {generateYaml()}
            </pre>
          )}
        </div>
      </div>

      {/* Error display */}
      {store.error && (
        <div style={{
          padding: '12px 16px',
          background: 'rgba(239, 68, 68, 0.1)',
          border: '1px solid var(--status-failed)',
          borderRadius: 12,
          marginBottom: 16,
          color: 'var(--status-failed)',
          fontSize: 13,
        }}>
          {store.error}
        </div>
      )}

      {/* Live Logs -- below training params, above chart */}
      <div style={{
        marginTop: 16, marginBottom: 16,
        background: 'rgba(8, 12, 24, 0.85)',
        backdropFilter: 'blur(16px)',
        border: '1px solid var(--border-subtle)',
        borderRadius: 14,
        overflow: 'hidden',
      }}>
        {/* Terminal header bar */}
        <div style={{
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'space-between',
          padding: '10px 16px',
          background: 'rgba(0, 0, 0, 0.3)',
          borderBottom: '1px solid var(--border-subtle)',
        }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <div style={{ display: 'flex', gap: 6 }}>
              <span style={{ width: 10, height: 10, borderRadius: '50%', background: isRunning ? '#EF4444' : '#3B3B3B' }} />
              <span style={{ width: 10, height: 10, borderRadius: '50%', background: isRunning ? '#EAB308' : '#3B3B3B' }} />
              <span style={{ width: 10, height: 10, borderRadius: '50%', background: isRunning ? '#22C55E' : '#3B3B3B' }} />
            </div>
            <span style={{
              fontSize: 11,
              fontWeight: 600,
              color: 'var(--text-muted)',
              textTransform: 'uppercase',
              letterSpacing: '1px',
              marginLeft: 4,
            }}>
              Live Logs
            </span>
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            {isRunning && (
              <span style={{
                fontSize: 10,
                color: 'var(--accent-green)',
                fontWeight: 600,
                letterSpacing: '0.5px',
                animation: 'statusPulse 2s ease-in-out infinite',
              }}>
                STREAMING
              </span>
            )}
            <span style={{
              fontSize: 10,
              color: 'var(--text-muted)',
              fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
            }}>
              {logs.length} lines
            </span>
          </div>
        </div>

        {/* Log content */}
        <div style={{
          fontFamily: "'JetBrains Mono', 'Fira Code', monospace",
          fontSize: 11,
          lineHeight: 1.7,
          background: 'rgba(2, 4, 12, 0.6)',
          padding: '12px 14px',
          maxHeight: 400,
          overflowY: 'auto',
          color: '#8A9AB5',
          scrollbarWidth: 'thin',
          scrollbarColor: 'rgba(255,255,255,0.1) transparent',
        }}>
          {logs.length === 0 ? (
            <div style={{ padding: '24px 0', textAlign: 'center' }}>
              <div style={{ fontSize: 20, opacity: 0.2, marginBottom: 8 }}>{'>'}_</div>
              <span style={{ color: 'var(--text-muted)', fontSize: 12 }}>Waiting for output...</span>
            </div>
          ) : (
            <pre style={{ margin: 0, whiteSpace: 'pre-wrap', wordBreak: 'break-all' }}>
              {logs.map((line, i) => {
                const isError = /error|fail|crash/i.test(line)
                const isWarn = /warn|warning/i.test(line)
                const isStage = /BASELINE|TALLYING|RETRIEVING|CURATING|TRAINING|MERGING|EVALUATING|GATING/i.test(line)
                return (
                  <span key={i} style={{
                    display: 'block',
                    color: isError ? '#EF4444' : isWarn ? '#EAB308' : isStage ? 'var(--accent-green)' : undefined,
                    fontWeight: isStage ? 600 : undefined,
                  }}>
                    {line}
                  </span>
                )
              })}
            </pre>
          )}
          <div ref={logEndRef} />
        </div>
      </div>

      {/* StagePipeline */}
      <StagePipeline currentStage={store.currentStage} currentCycle={store.currentCycle} />

      {/* BenchmarkChart */}
      <div className="card" style={{ marginTop: 16 }}>
        <BenchmarkChart cycles={store.cycles} targetScore={85} />
      </div>

      {/* TallyDiagnosis */}
      <div className="card" style={{ marginTop: 16 }}>
        <TallyDiagnosis tallyResult={store.tallyResult} cycle={store.currentCycle} />
      </div>

      {/* CycleHistory */}
      <div className="card" style={{ marginTop: 16 }}>
        <CycleHistory cycles={store.cycles} />
      </div>
    </div>
  )
}

function btnStyle(variant: 'start' | 'stop' | 'cancel', disabled: boolean): React.CSSProperties {
  const base: React.CSSProperties = {
    display: 'inline-flex',
    alignItems: 'center',
    gap: 6,
    padding: '8px 18px',
    borderRadius: 8,
    border: 'none',
    cursor: disabled ? 'not-allowed' : 'pointer',
    fontSize: 13,
    fontWeight: 600,
    opacity: disabled ? 0.5 : 1,
    transition: 'all 0.15s',
  }
  if (variant === 'start') {
    return {
      ...base,
      background: disabled ? 'rgba(34, 197, 94, 0.15)' : 'rgba(34, 197, 94, 0.2)',
      color: 'var(--accent-green)',
      border: '1px solid var(--accent-green)',
    }
  }
  if (variant === 'cancel') {
    return {
      ...base,
      background: 'rgba(249, 115, 22, 0.15)',
      color: '#f97316',
      border: '1px solid #f97316',
    }
  }
  return {
    ...base,
    background: 'rgba(239, 68, 68, 0.15)',
    color: 'var(--status-failed)',
    border: '1px solid var(--status-failed)',
  }
}

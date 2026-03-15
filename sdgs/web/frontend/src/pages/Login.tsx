import { useState } from 'react'
import { useNavigate, Link } from 'react-router-dom'
import { useAuthStore } from '../store/authStore'

export default function Login() {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [error, setError] = useState('')
  const { login, loading } = useAuthStore()
  const navigate = useNavigate()

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')
    try {
      await login(username, password)
      navigate('/')
    } catch {
      setError('Invalid username or password')
    }
  }

  return (
    <div style={{
      display: 'flex',
      alignItems: 'center',
      justifyContent: 'center',
      minHeight: '100vh',
      padding: '20px',
      background: '#030712',
      position: 'relative',
      overflow: 'hidden',
    }}>
      {/* Background glows */}
      <div style={{
        position: 'absolute',
        top: '20%',
        left: '45%',
        width: '700px',
        height: '700px',
        background: 'radial-gradient(circle, rgba(74, 222, 128, 0.06) 0%, transparent 60%)',
        pointerEvents: 'none',
        transform: 'translate(-50%, -50%)',
      }} />
      <div style={{
        position: 'absolute',
        bottom: '10%',
        right: '20%',
        width: '500px',
        height: '500px',
        background: 'radial-gradient(circle, rgba(59, 130, 246, 0.04) 0%, transparent 60%)',
        pointerEvents: 'none',
      }} />

      <div style={{
        width: '100%',
        maxWidth: '420px',
        background: 'rgba(15, 23, 42, 0.5)',
        backdropFilter: 'blur(24px) saturate(180%)',
        WebkitBackdropFilter: 'blur(24px) saturate(180%)',
        border: '1px solid rgba(255, 255, 255, 0.07)',
        borderRadius: '24px',
        padding: '44px',
        position: 'relative',
        overflow: 'hidden',
      }}>
        {/* Top shine */}
        <div style={{
          position: 'absolute',
          top: 0,
          left: 0,
          right: 0,
          height: '1px',
          background: 'linear-gradient(90deg, transparent 10%, rgba(255,255,255,0.08) 50%, transparent 90%)',
        }} />

        <div style={{ textAlign: 'center', marginBottom: '36px' }}>
          <div style={{
            width: '56px',
            height: '56px',
            borderRadius: '18px',
            background: 'linear-gradient(135deg, #4ADE80, #8B5CF6)',
            boxShadow: '0 8px 30px rgba(74, 222, 128, 0.2), 0 0 16px rgba(139, 92, 246, 0.15)',
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            marginBottom: '24px',
            padding: '10px',
          }}>
            <svg viewBox="0 0 100 100" width="32" height="32">
              <path
                d="M50 12 C74 12 88 30 88 50 C88 72 72 88 50 88 C28 88 12 72 12 52 C12 34 26 22 42 22 C56 22 66 32 66 46 C66 58 58 66 48 66 C38 66 32 60 32 50 C32 42 38 36 46 36 C52 36 56 40 56 46"
                fill="none"
                stroke="#fff"
                strokeWidth="6"
                strokeLinecap="round"
                opacity="0.9"
              />
            </svg>
          </div>
          <h1 style={{
            fontSize: '26px',
            fontWeight: 800,
            letterSpacing: '-0.04em',
            marginBottom: '4px',
          }}>
            <span style={{
              background: 'linear-gradient(135deg, #22C55E, #8B5CF6, #F97316)',
              WebkitBackgroundClip: 'text',
              WebkitTextFillColor: 'transparent',
            }}>
              Ouroboros
            </span>
          </h1>
          <p style={{ color: 'var(--text-muted)', fontSize: '14px' }}>
            Sign in to continue
          </p>
        </div>

        {error && (
          <div style={{
            background: 'rgba(239, 68, 68, 0.08)',
            border: '1px solid rgba(239, 68, 68, 0.15)',
            borderRadius: '12px',
            padding: '12px 16px',
            color: '#F87171',
            fontSize: '13px',
            marginBottom: '24px',
          }}>
            {error}
          </div>
        )}

        <form onSubmit={handleSubmit}>
          <div style={{ marginBottom: '20px' }}>
            <label style={{ fontSize: '12px', color: 'var(--text-muted)', marginBottom: '8px', display: 'block', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
              Username
            </label>
            <input
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              required
              autoFocus
              style={{
                background: 'rgba(6, 10, 24, 0.6)',
                border: '1px solid rgba(255,255,255,0.07)',
                borderRadius: '12px',
                padding: '12px 16px',
                fontSize: '14px',
                color: '#F1F5F9',
                width: '100%',
                outline: 'none',
                transition: 'all 0.2s',
              }}
            />
          </div>
          <div style={{ marginBottom: '28px' }}>
            <label style={{ fontSize: '12px', color: 'var(--text-muted)', marginBottom: '8px', display: 'block', fontWeight: 600, textTransform: 'uppercase', letterSpacing: '0.06em' }}>
              Password
            </label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              style={{
                background: 'rgba(6, 10, 24, 0.6)',
                border: '1px solid rgba(255,255,255,0.07)',
                borderRadius: '12px',
                padding: '12px 16px',
                fontSize: '14px',
                color: '#F1F5F9',
                width: '100%',
                outline: 'none',
                transition: 'all 0.2s',
              }}
            />
          </div>
          <button
            type="submit"
            disabled={loading}
            style={{
              width: '100%',
              padding: '13px 20px',
              borderRadius: '14px',
              border: 'none',
              background: 'linear-gradient(135deg, #4ADE80, #22C55E)',
              color: '#fff',
              fontSize: '14px',
              fontWeight: 600,
              cursor: loading ? 'not-allowed' : 'pointer',
              opacity: loading ? 0.5 : 1,
              boxShadow: '0 4px 24px rgba(74, 222, 128, 0.3), 0 0 8px rgba(74, 222, 128, 0.2)',
              transition: 'all 0.3s cubic-bezier(0.16, 1, 0.3, 1)',
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
            }}
          >
            {loading ? <span className="spinner" /> : 'Sign In'}
          </button>
        </form>

        <p style={{
          textAlign: 'center',
          marginTop: '24px',
          fontSize: '13px',
          color: 'var(--text-secondary)',
        }}>
          Don't have an account? <Link to="/register" style={{ color: '#22C55E', fontWeight: 500 }}>Create one</Link>
        </p>
      </div>
    </div>
  )
}

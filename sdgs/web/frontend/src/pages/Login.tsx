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
      background: 'var(--bg-primary)',
    }}>
      <div className="card" style={{
        width: '100%',
        maxWidth: '380px',
        padding: '32px',
      }}>
        <div style={{ textAlign: 'center', marginBottom: '28px' }}>
          <div style={{
            width: '48px',
            height: '48px',
            borderRadius: '8px',
            background: 'var(--accent-primary)',
            display: 'inline-flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontWeight: 800,
            fontSize: '24px',
            color: '#fff',
            marginBottom: '16px',
          }}>
            O
          </div>
          <h1 style={{
            fontSize: '22px',
            fontWeight: 600,
            color: 'var(--text-primary)',
          }}>
            Ouroboros
          </h1>
          <p style={{
            color: 'var(--text-muted)',
            fontSize: '13px',
            marginTop: '4px',
          }}>
            Sign in to continue
          </p>
        </div>

        {error && (
          <div style={{
            background: 'rgba(248, 81, 73, 0.1)',
            border: '1px solid rgba(248, 81, 73, 0.3)',
            borderRadius: 'var(--radius-sm)',
            padding: '8px 12px',
            color: 'var(--status-failed)',
            fontSize: '13px',
            marginBottom: '16px',
          }}>
            {error}
          </div>
        )}

        <form onSubmit={handleSubmit}>
          <div style={{ marginBottom: '16px' }}>
            <label>Username</label>
            <input
              type="text"
              value={username}
              onChange={(e) => setUsername(e.target.value)}
              required
              autoFocus
            />
          </div>
          <div style={{ marginBottom: '20px' }}>
            <label>Password</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
            />
          </div>
          <button
            className="btn btn-primary"
            type="submit"
            disabled={loading}
            style={{ width: '100%', justifyContent: 'center', padding: '10px 20px' }}
          >
            {loading ? <span className="spinner" /> : 'Sign In'}
          </button>
        </form>

        <p style={{
          textAlign: 'center',
          marginTop: '16px',
          fontSize: '13px',
          color: 'var(--text-secondary)',
        }}>
          Don't have an account? <Link to="/register">Create one</Link>
        </p>
      </div>
    </div>
  )
}

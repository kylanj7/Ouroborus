import { useState } from 'react'
import { useNavigate, Link } from 'react-router-dom'
import { useAuthStore } from '../store/authStore'

export default function Register() {
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [confirmPassword, setConfirmPassword] = useState('')
  const [error, setError] = useState('')
  const { register, loading } = useAuthStore()
  const navigate = useNavigate()

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')

    if (password !== confirmPassword) {
      setError('Passwords do not match')
      return
    }

    if (password.length < 6) {
      setError('Password must be at least 6 characters')
      return
    }

    try {
      await register(username, password)
      navigate('/')
    } catch {
      setError('Username already taken or registration failed')
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
            Create Account
          </h1>
          <p style={{
            color: 'var(--text-muted)',
            fontSize: '13px',
            marginTop: '4px',
          }}>
            Join Ouroboros AI Training Suite
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
          <div style={{ marginBottom: '16px' }}>
            <label>Password</label>
            <input
              type="password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              required
              minLength={6}
            />
          </div>
          <div style={{ marginBottom: '20px' }}>
            <label>Confirm Password</label>
            <input
              type="password"
              value={confirmPassword}
              onChange={(e) => setConfirmPassword(e.target.value)}
              required
            />
          </div>
          <button
            className="btn btn-primary"
            type="submit"
            disabled={loading}
            style={{ width: '100%', justifyContent: 'center' }}
          >
            {loading ? <span className="spinner" /> : 'Create Account'}
          </button>
        </form>

        <p style={{
          textAlign: 'center',
          marginTop: '16px',
          fontSize: '13px',
          color: 'var(--text-secondary)',
        }}>
          Already have an account? <Link to="/login">Sign in</Link>
        </p>
      </div>
    </div>
  )
}

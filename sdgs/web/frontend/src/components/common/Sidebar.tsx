import { NavLink } from 'react-router-dom'
import { Database, FileText, Orbit, Cpu, FlaskConical, ArrowRightLeft, Upload, Settings, LogOut, RefreshCw } from 'lucide-react'
import { useAuthStore } from '../../store/authStore'

const navItems = [
  { to: '/', icon: Database, label: 'Datasets' },
  { to: '/papers', icon: FileText, label: 'Papers' },
  { to: '/galaxy', icon: Orbit, label: 'Galaxy' },
  { to: '/training', icon: Cpu, label: 'Training' },
  { to: '/evaluations', icon: FlaskConical, label: 'Evaluations' },
  { to: '/loop', icon: RefreshCw, label: 'Evolution Loop' },
  { to: '/training/convert', icon: ArrowRightLeft, label: 'Convert' },
  { to: '/training/push', icon: Upload, label: 'Push Model' },
  { to: '/settings', icon: Settings, label: 'Settings' },
]

export default function Sidebar() {
  const { username, logout } = useAuthStore()

  return (
    <aside style={{
      position: 'fixed',
      left: 0,
      top: 0,
      bottom: 0,
      width: 'var(--sidebar-width)',
      background: 'var(--bg-secondary)',
      borderRight: '1px solid var(--border-subtle)',
      display: 'flex',
      flexDirection: 'column',
      zIndex: 100,
    }}>
      {/* Brand */}
      <div style={{
        padding: '20px',
        borderBottom: '1px solid var(--border-subtle)',
        display: 'flex',
        alignItems: 'center',
        gap: '10px',
      }}>
        <div style={{
          width: '32px',
          height: '32px',
          borderRadius: '6px',
          background: 'var(--accent-primary)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          fontWeight: 800,
          fontSize: '16px',
          color: '#fff',
          flexShrink: 0,
        }}>
          O
        </div>
        <div>
          <h1 style={{
            fontSize: '16px',
            fontWeight: 600,
            color: 'var(--text-primary)',
            letterSpacing: '0.3px',
          }}>
            Ouroboros
          </h1>
          <p style={{ fontSize: '10px', color: 'var(--text-muted)', marginTop: '1px' }}>
            AI Training Suite
          </p>
        </div>
      </div>

      <nav style={{ flex: 1, padding: '8px', overflowY: 'auto' }}>
        {navItems.map(({ to, icon: Icon, label }) => (
          <NavLink
            key={to}
            to={to}
            end={to === '/'}
            style={({ isActive }) => ({
              display: 'flex',
              alignItems: 'center',
              gap: '10px',
              padding: '8px 12px',
              borderRadius: 'var(--radius-sm)',
              color: isActive ? 'var(--text-primary)' : 'var(--text-secondary)',
              background: isActive ? 'var(--bg-tertiary)' : 'transparent',
              borderLeft: isActive ? '2px solid var(--accent-primary)' : '2px solid transparent',
              textDecoration: 'none',
              fontSize: '14px',
              fontWeight: isActive ? 500 : 400,
              marginBottom: '1px',
              transition: 'all 0.15s',
            })}
          >
            <Icon size={16} />
            {label}
          </NavLink>
        ))}
      </nav>

      <div style={{
        padding: '16px 20px',
        borderTop: '1px solid var(--border-subtle)',
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
      }}>
        <div>
          <div style={{ fontSize: '13px', color: 'var(--text-secondary)' }}>{username}</div>
          <div style={{ fontSize: '10px', color: 'var(--text-muted)' }}>v0.3.0</div>
        </div>
        <button
          onClick={logout}
          title="Sign out"
          style={{
            background: 'none',
            border: 'none',
            color: 'var(--text-muted)',
            cursor: 'pointer',
            padding: '4px',
            transition: 'color 0.15s',
          }}
        >
          <LogOut size={16} />
        </button>
      </div>
    </aside>
  )
}

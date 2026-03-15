import { NavLink } from 'react-router-dom'
import { LayoutDashboard, Database, FileText, Orbit, Cpu, FlaskConical, ArrowRightLeft, Upload, Settings, LogOut, RefreshCw, BookOpen } from 'lucide-react'
import { useAuthStore } from '../../store/authStore'

const mainNav = [
  { to: '/', icon: LayoutDashboard, label: 'Dashboard' },
  { to: '/datasets', icon: Database, label: 'QA Datasets' },
  { to: '/papers', icon: FileText, label: 'PDF Database' },
  { to: '/knowledge', icon: BookOpen, label: 'Semantic Database' },
  { to: '/galaxy', icon: Orbit, label: 'QA Visualizer' },
]

const trainNav = [
  { to: '/training', icon: Cpu, label: 'Training' },
  { to: '/evaluations', icon: FlaskConical, label: 'Evaluations' },
  { to: '/loop', icon: RefreshCw, label: 'Evolution Loop' },
]

const utilNav = [
  { to: '/training/convert', icon: ArrowRightLeft, label: 'Convert' },
  { to: '/training/push', icon: Upload, label: 'Push Model' },
  { to: '/settings', icon: Settings, label: 'Settings' },
]

function SectionLabel({ children }: { children: string }) {
  return (
    <div style={{
      fontSize: '10px',
      fontWeight: 700,
      color: 'var(--text-muted)',
      textTransform: 'uppercase',
      letterSpacing: '0.1em',
      padding: '16px 16px 8px',
    }}>
      {children}
    </div>
  )
}

function NavItem({ to, icon: Icon, label }: { to: string; icon: typeof LayoutDashboard; label: string }) {
  return (
    <NavLink
      to={to}
      end={to === '/'}
      style={({ isActive }) => ({
        display: 'flex',
        alignItems: 'center',
        gap: '12px',
        padding: '10px 16px',
        margin: '0 8px 2px',
        borderRadius: '12px',
        color: isActive ? '#fff' : 'var(--text-secondary)',
        background: isActive
          ? 'linear-gradient(135deg, rgba(74, 222, 128, 0.2) 0%, rgba(6, 182, 212, 0.1) 100%)'
          : 'transparent',
        border: isActive ? '1px solid rgba(74, 222, 128, 0.15)' : '1px solid transparent',
        boxShadow: isActive ? '0 0 24px rgba(74, 222, 128, 0.06), inset 0 1px 0 rgba(255,255,255,0.04)' : 'none',
        textDecoration: 'none',
        fontSize: '13px',
        fontWeight: isActive ? 600 : 400,
        transition: 'all 0.25s cubic-bezier(0.16, 1, 0.3, 1)',
      })}
    >
      {({ isActive }: { isActive: boolean }) => (
        <>
          <Icon size={17} strokeWidth={isActive ? 2.2 : 1.8} />
          {label}
        </>
      )}
    </NavLink>
  )
}

export default function Sidebar() {
  const { username, logout } = useAuthStore()

  return (
    <aside style={{
      position: 'fixed',
      left: 0,
      top: 0,
      bottom: 0,
      width: 'var(--sidebar-width)',
      background: 'rgba(8, 12, 28, 0.85)',
      backdropFilter: 'blur(24px) saturate(180%)',
      WebkitBackdropFilter: 'blur(24px) saturate(180%)',
      borderRight: '1px solid rgba(255, 255, 255, 0.06)',
      display: 'flex',
      flexDirection: 'column',
      zIndex: 100,
    }}>
      {/* Ambient glow at top */}
      <div style={{
        position: 'absolute',
        top: 0,
        left: 0,
        right: 0,
        height: '200px',
        background: 'radial-gradient(ellipse at 50% 0%, rgba(74, 222, 128, 0.04), rgba(139, 92, 246, 0.02) 50%, transparent 70%)',
        pointerEvents: 'none',
      }} />

      {/* Brand */}
      <div style={{
        padding: '28px 20px',
        display: 'flex',
        alignItems: 'center',
        gap: '14px',
        position: 'relative',
      }}>
        <div style={{
          width: '40px',
          height: '40px',
          borderRadius: '14px',
          background: 'linear-gradient(135deg, #4ADE80, #8B5CF6)',
          boxShadow: '0 4px 20px rgba(74, 222, 128, 0.25), 0 0 12px rgba(139, 92, 246, 0.15)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          flexShrink: 0,
          padding: '6px',
        }}>
          <svg viewBox="0 0 100 100" width="24" height="24">
            <path
              d="M50 15 A35 35 0 1 1 20 65 A25 25 0 1 0 50 30 A15 15 0 1 1 62 50 A8 8 0 1 0 50 45"
              fill="none"
              stroke="#fff"
              strokeWidth="7"
              strokeLinecap="round"
              opacity="0.9"
            />
          </svg>
        </div>
        <div>
          <h1 style={{
            fontSize: '17px',
            fontWeight: 700,
            color: '#fff',
            letterSpacing: '-0.02em',
          }}>
            Ouroboros
          </h1>
          <p style={{
            fontSize: '11px',
            color: 'var(--text-muted)',
            marginTop: '1px',
          }}>
            AI Training Suite
          </p>
        </div>
      </div>

      {/* Divider */}
      <div style={{ margin: '0 20px', height: '1px', background: 'rgba(255,255,255,0.05)' }} />

      <nav style={{ flex: 1, overflowY: 'auto', paddingTop: '8px' }}>
        {mainNav.map(item => <NavItem key={item.to} {...item} />)}
        <SectionLabel>Training</SectionLabel>
        {trainNav.map(item => <NavItem key={item.to} {...item} />)}
        <SectionLabel>Tools</SectionLabel>
        {utilNav.map(item => <NavItem key={item.to} {...item} />)}
      </nav>

      {/* User */}
      <div style={{
        padding: '16px 20px',
        borderTop: '1px solid rgba(255,255,255,0.05)',
        display: 'flex',
        justifyContent: 'space-between',
        alignItems: 'center',
      }}>
        <div style={{ display: 'flex', alignItems: 'center', gap: '10px' }}>
          <div style={{
            width: '30px',
            height: '30px',
            borderRadius: '10px',
            background: 'linear-gradient(135deg, rgba(59,130,246,0.2), rgba(167,139,250,0.2))',
            border: '1px solid rgba(255,255,255,0.08)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            fontSize: '12px',
            fontWeight: 700,
            color: '#A78BFA',
          }}>
            {username?.charAt(0)?.toUpperCase() || '?'}
          </div>
          <div>
            <div style={{ fontSize: '13px', color: '#fff', fontWeight: 500 }}>{username}</div>
            <div style={{ fontSize: '10px', color: 'var(--text-muted)' }}>v0.3.0</div>
          </div>
        </div>
        <button
          onClick={logout}
          title="Sign out"
          style={{
            background: 'rgba(255,255,255,0.04)',
            border: '1px solid rgba(255,255,255,0.06)',
            color: 'var(--text-muted)',
            cursor: 'pointer',
            padding: '7px',
            borderRadius: '10px',
            transition: 'all 0.2s',
            display: 'flex',
            alignItems: 'center',
          }}
          onMouseEnter={e => {
            e.currentTarget.style.background = 'rgba(239,68,68,0.1)'
            e.currentTarget.style.borderColor = 'rgba(239,68,68,0.2)'
            e.currentTarget.style.color = '#F87171'
          }}
          onMouseLeave={e => {
            e.currentTarget.style.background = 'rgba(255,255,255,0.04)'
            e.currentTarget.style.borderColor = 'rgba(255,255,255,0.06)'
            e.currentTarget.style.color = 'var(--text-muted)'
          }}
        >
          <LogOut size={14} />
        </button>
      </div>
    </aside>
  )
}
